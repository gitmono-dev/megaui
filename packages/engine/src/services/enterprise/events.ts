// megaui-only (FS-66): verified-event acceptance and dispatch have no upstream counterpart.
/**
 * FS-66: durable acceptance of already-verified Feishu events.
 *
 * Callback verification belongs to FS-09. This boundary accepts only the three
 * verified business-event shapes the enterprise plan allows, copies their
 * whitelisted metadata into the inbox, and enqueues exactly one durable job in
 * the same transaction. The worker leases the inbox row independently before
 * dispatching the Contact or private-message hint.
 */
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import {
  CONTACT_EVENT_HINT_QUEUE,
  PRIVATE_MESSAGE_EVENT_HINT_QUEUE,
  type EnterpriseJob,
  type EnterpriseJobHandler,
} from "./jobs";

/** The durable queue used to dispatch verified event metadata. */
export const VERIFIED_EVENT_QUEUE = "enterprise.verified-event";
/** The only callback business events this public port accepts. */
export const VERIFIED_EVENT_TYPES = [
  "contact.user.updated_v3",
  "contact.user.deleted_v3",
  "im.message.receive_v1",
] as const;
export type VerifiedEventType = (typeof VERIFIED_EVENT_TYPES)[number];

const EVENT_INBOX_LEASE_SECONDS = 30;
const EVENT_INBOX_LEASE_RENEWAL_MS = 10_000;

interface VerifiedEventBase {
  tenantKey: string;
  appId: string;
  eventId: string;
  eventCreatedAt: Date;
}

export interface VerifiedContactUserUpdatedEvent extends VerifiedEventBase {
  eventType: "contact.user.updated_v3";
  subjectOpenId: string;
}

export interface VerifiedContactUserDeletedEvent extends VerifiedEventBase {
  eventType: "contact.user.deleted_v3";
  subjectOpenId: string;
}

export type VerifiedContactEvent =
  | VerifiedContactUserUpdatedEvent
  | VerifiedContactUserDeletedEvent;

export interface VerifiedPrivateMessageEvent extends VerifiedEventBase {
  eventType: "im.message.receive_v1";
  messageId: string;
  senderOpenId: string;
  senderType: string;
  chatType: string;
  messageType: string;
  /** SHA-256 digest only. The private-message text and token never cross this port. */
  pairingTokenDigest?: string;
}

export type VerifiedEnterpriseEvent = VerifiedContactEvent | VerifiedPrivateMessageEvent;

/** Stable durable identifiers; a replay returns the identifiers of the first acceptance. */
export interface AcceptedVerifiedEvent {
  inboxId: string;
  jobId: string;
}

export type PersistedVerifiedContactEvent = VerifiedContactEvent & { inboxId: string };
export type PersistedVerifiedPrivateMessageEvent = VerifiedPrivateMessageEvent & {
  inboxId: string;
};

/**
 * Every effect receives the durable inbox identifier as its idempotency key.
 * Implementations must deduplicate by that key even though the dispatcher also
 * renews its lease: a process can always fail after the effect and before the
 * inbox completion update.
 */
export interface VerifiedEventEffectContext {
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface VerifiedEventEffects {
  onContactHint: (
    event: PersistedVerifiedContactEvent,
    context: VerifiedEventEffectContext,
  ) => Promise<void>;
  onPrivateMessageHint: (
    event: PersistedVerifiedPrivateMessageEvent,
    context: VerifiedEventEffectContext,
  ) => Promise<void>;
}

export interface VerifiedEventOffboardingPort {
  /** Maps a verified Contact deletion to the FS-18 transaction. */
  readonly onContactDeparture?: (
    event: PersistedVerifiedContactEvent,
    context: VerifiedEventEffectContext,
  ) => Promise<void>;
}

interface NormalizedEvent {
  tenantKey: string;
  appId: string;
  eventId: string;
  eventType: VerifiedEventType;
  eventCreatedAt: Date;
  subjectOpenId: string | null;
  messageId: string | null;
  senderOpenId: string | null;
  senderType: string | null;
  chatType: string | null;
  messageType: string | null;
  pairingTokenDigest: string | null;
}

interface InboxRow extends NormalizedEvent {
  id: string;
  state: string;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !/\S/u.test(value)) {
    throw new Error(`[@megaui/engine] verified event ${field} must not be empty`);
  }
  return value;
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("[@megaui/engine] verified event eventCreatedAt must be a valid Date");
  }
  return new Date(value.getTime());
}

function normalizeVerifiedEvent(value: VerifiedEnterpriseEvent): NormalizedEvent {
  if (!value || typeof value !== "object") {
    throw new Error("[@megaui/engine] verified event must be an object");
  }

  const tenantKey = requireText(value.tenantKey, "tenantKey");
  const appId = requireText(value.appId, "appId");
  const eventId = requireText(value.eventId, "eventId");
  const eventCreatedAt = requireDate(value.eventCreatedAt);

  switch (value.eventType) {
    case "contact.user.updated_v3":
    case "contact.user.deleted_v3":
      return {
        tenantKey,
        appId,
        eventId,
        eventType: value.eventType,
        eventCreatedAt,
        subjectOpenId: requireText(value.subjectOpenId, "subjectOpenId"),
        messageId: null,
        senderOpenId: null,
        senderType: null,
        chatType: null,
        messageType: null,
        pairingTokenDigest: null,
      };
    case "im.message.receive_v1": {
      const pairingTokenDigest = value.pairingTokenDigest;
      if (
        pairingTokenDigest !== undefined &&
        !/^[0-9a-f]{64}$/.test(pairingTokenDigest)
      ) {
        throw new Error(
          "[@megaui/engine] verified event pairingTokenDigest must be a lowercase SHA-256 digest",
        );
      }
      return {
        tenantKey,
        appId,
        eventId,
        eventType: value.eventType,
        eventCreatedAt,
        subjectOpenId: null,
        messageId: requireText(value.messageId, "messageId"),
        senderOpenId: requireText(value.senderOpenId, "senderOpenId"),
        senderType: requireText(value.senderType, "senderType"),
        chatType: requireText(value.chatType, "chatType"),
        messageType: requireText(value.messageType, "messageType"),
        pairingTokenDigest: pairingTokenDigest ?? null,
      };
    }
    default:
      throw new Error("[@megaui/engine] unsupported verified event type");
  }
}

function eventJobDedupeKey(inboxId: string): string {
  return `verified-event:${inboxId}`;
}

function eventHintDedupeKey(inboxId: string): string {
  return `verified-event-hint:${inboxId}`;
}

async function enqueueVerifiedEventHint(
  pool: Pool,
  queue: typeof CONTACT_EVENT_HINT_QUEUE | typeof PRIVATE_MESSAGE_EVENT_HINT_QUEUE,
  inboxId: string,
): Promise<void> {
  await pool.query(
    `insert into "enterprise_jobs"
       (id, queue, dedupe_key, payload, available_at)
     values ($1, $2, $3, $4::jsonb, now())
     on conflict (dedupe_key) do nothing`,
    [
      randomUUID(),
      queue,
      eventHintDedupeKey(inboxId),
      JSON.stringify({ inboxId }),
    ],
  );
}

/**
 * Creates the fail-safe standard dispatch effects.
 *
 * The verified-event job never treats an unconfigured business consumer as a
 * successful no-op. Instead it durably hands the inbox identifier to a typed
 * follow-up queue. Later owner cards register those queue handlers; until then
 * the rows remain pending and inspectable without losing the accepted event.
 */
export function createDurableVerifiedEventEffects(
  pool: Pool,
  offboarding: VerifiedEventOffboardingPort = {},
): VerifiedEventEffects {
  return {
    onContactHint: async (event, context) => {
      if (event.inboxId !== context.idempotencyKey) {
        throw new Error("[@megaui/engine] Contact hint idempotency key mismatch");
      }
      await enqueueVerifiedEventHint(pool, CONTACT_EVENT_HINT_QUEUE, event.inboxId);
      if (event.eventType === "contact.user.deleted_v3") {
        await offboarding.onContactDeparture?.(event, context);
      }
    },
    onPrivateMessageHint: async (event, context) => {
      if (event.inboxId !== context.idempotencyKey) {
        throw new Error("[@megaui/engine] private-message hint idempotency key mismatch");
      }
      await enqueueVerifiedEventHint(pool, PRIVATE_MESSAGE_EVENT_HINT_QUEUE, event.inboxId);
    },
  };
}

/**
 * Atomically accepts one already-verified event and its durable dispatch job.
 *
 * Both envelope and IM-message replays return the identifiers committed by the
 * first acceptance. A conflicting replay that points at two different durable
 * rows is refused instead of choosing one silently.
 */
export async function acceptVerifiedEvent(
  pool: Pool,
  value: VerifiedEnterpriseEvent,
): Promise<AcceptedVerifiedEvent> {
  const event = normalizeVerifiedEvent(value);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const inboxId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `insert into "enterprise_event_inbox"
         (id, tenant_key, app_id, event_id, event_type, event_created_at,
          subject_open_id, message_id, sender_open_id, sender_type, chat_type,
          message_type, pairing_token_digest)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict do nothing
       returning id`,
      [
        inboxId,
        event.tenantKey,
        event.appId,
        event.eventId,
        event.eventType,
        event.eventCreatedAt,
        event.subjectOpenId,
        event.messageId,
        event.senderOpenId,
        event.senderType,
        event.chatType,
        event.messageType,
        event.pairingTokenDigest,
      ],
    );

    if (inserted.rows.length === 0) {
      const existing = await client.query<{ id: string }>(
        `select id
           from "enterprise_event_inbox"
          where tenant_key = $1 and app_id = $2
            and (event_id = $3 or ($4::text is not null and message_id = $4))
          order by id
          for share`,
        [event.tenantKey, event.appId, event.eventId, event.messageId],
      );
      if (existing.rows.length !== 1) {
        throw new Error(
          "[@megaui/engine] verified event replay conflicts with multiple durable inbox rows",
        );
      }
      const existingInboxId = existing.rows[0]!.id;
      const existingJob = await client.query<{ id: string }>(
        `select id from "enterprise_jobs" where dedupe_key = $1`,
        [eventJobDedupeKey(existingInboxId)],
      );
      if (existingJob.rows.length !== 1) {
        throw new Error(
          "[@megaui/engine] verified event inbox is missing its durable dispatch job",
        );
      }
      await client.query("commit");
      return { inboxId: existingInboxId, jobId: existingJob.rows[0]!.id };
    }

    const jobId = randomUUID();
    await client.query(
      `insert into "enterprise_jobs"
         (id, queue, dedupe_key, payload, available_at)
       values ($1, $2, $3, $4::jsonb, now())`,
      [
        jobId,
        VERIFIED_EVENT_QUEUE,
        eventJobDedupeKey(inboxId),
        JSON.stringify({ inboxId }),
      ],
    );
    await client.query("commit");
    return { inboxId, jobId };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the acceptance failure that caused the rollback.
    }
    throw error;
  } finally {
    client.release();
  }
}

function parseInboxId(job: EnterpriseJob): string {
  if (job.queue !== VERIFIED_EVENT_QUEUE) {
    throw new Error("[@megaui/engine] verified event handler received another queue");
  }
  const payload = job.payload;
  const inboxId = payload.inboxId;
  if (typeof inboxId !== "string" || !/\S/u.test(inboxId)) {
    throw new Error("[@megaui/engine] invalid verified event job payload");
  }
  return inboxId;
}

function rowToContactEvent(row: InboxRow): PersistedVerifiedContactEvent {
  const subjectOpenId = requireText(row.subjectOpenId, "stored subjectOpenId");
  const base = {
    inboxId: row.id,
    tenantKey: row.tenantKey,
    appId: row.appId,
    eventId: row.eventId,
    eventCreatedAt: row.eventCreatedAt,
    subjectOpenId,
  };
  if (row.eventType === "contact.user.updated_v3") {
    return { ...base, eventType: row.eventType };
  }
  if (row.eventType === "contact.user.deleted_v3") {
    return { ...base, eventType: row.eventType };
  }
  throw new Error("[@megaui/engine] stored event is not a Contact hint");
}

function rowToPrivateMessageEvent(row: InboxRow): PersistedVerifiedPrivateMessageEvent {
  if (row.eventType !== "im.message.receive_v1") {
    throw new Error("[@megaui/engine] stored event is not a private-message hint");
  }
  return {
    inboxId: row.id,
    tenantKey: row.tenantKey,
    appId: row.appId,
    eventId: row.eventId,
    eventType: row.eventType,
    eventCreatedAt: row.eventCreatedAt,
    messageId: requireText(row.messageId, "stored messageId"),
    senderOpenId: requireText(row.senderOpenId, "stored senderOpenId"),
    senderType: requireText(row.senderType, "stored senderType"),
    chatType: requireText(row.chatType, "stored chatType"),
    messageType: requireText(row.messageType, "stored messageType"),
    ...(row.pairingTokenDigest === null
      ? {}
      : { pairingTokenDigest: row.pairingTokenDigest }),
  };
}

/**
 * Reads one persisted private-message projection for a follow-up owner.
 *
 * The inbox is deliberately the only source here: it contains sender/message
 * metadata and the optional digest proof produced by the callback verifier,
 * never the private-message body or opaque token. Missing rows and rows of a
 * different event type are returned as `undefined` so a stale follow-up job
 * cannot accidentally enter a bot-command flow.
 */
export async function readPersistedVerifiedPrivateMessageEvent(
  pool: Pick<Pool, "query">,
  inboxId: string,
): Promise<PersistedVerifiedPrivateMessageEvent | undefined> {
  if (typeof inboxId !== "string" || !/\S/u.test(inboxId)) return undefined;
  const result = await pool.query<InboxRow>(
    `select id, tenant_key as "tenantKey", app_id as "appId",
            event_id as "eventId", event_type as "eventType",
            event_created_at as "eventCreatedAt",
            subject_open_id as "subjectOpenId", message_id as "messageId",
            sender_open_id as "senderOpenId", sender_type as "senderType",
            chat_type as "chatType", message_type as "messageType",
            pairing_token_digest as "pairingTokenDigest", state
       from "enterprise_event_inbox"
      where id = $1 and event_type = 'im.message.receive_v1'`,
    [inboxId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : rowToPrivateMessageEvent(row);
}

async function waitForLeaseRenewal(
  stopSignal: Promise<void>,
  intervalMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      stopSignal.then(() => true),
      new Promise<boolean>((resolveWait) => {
        timer = setTimeout(() => resolveWait(false), intervalMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runWithInboxLeaseRenewal(options: {
  pool: Pool;
  inboxId: string;
  claimOwner: string;
  renewalIntervalMs: number;
  effect: (context: VerifiedEventEffectContext) => Promise<void>;
}): Promise<void> {
  let stopRenewal!: () => void;
  const stopSignal = new Promise<void>((resolveStop) => {
    stopRenewal = resolveStop;
  });
  const effectController = new AbortController();
  let renewalFailure: { error: unknown } | undefined;
  const renewal = (async () => {
    while (!(await waitForLeaseRenewal(stopSignal, options.renewalIntervalMs))) {
      const renewed = await options.pool.query(
        `update "enterprise_event_inbox"
            set lease_until = now() + ($3 * interval '1 second'),
                updated_at = now()
          where id = $1 and state = 'leased' and claim_owner = $2`,
        [options.inboxId, options.claimOwner, EVENT_INBOX_LEASE_SECONDS],
      );
      if (renewed.rowCount !== 1) {
        throw new Error("[@megaui/engine] verified event lease was lost during dispatch");
      }
    }
  })().catch((error: unknown) => {
    renewalFailure = { error };
    effectController.abort(error);
  });

  let effectFailure: { error: unknown } | undefined;
  try {
    await options.effect({
      idempotencyKey: options.inboxId,
      signal: effectController.signal,
    });
  } catch (error) {
    effectFailure = { error };
  } finally {
    stopRenewal();
    await renewal;
  }

  if (effectFailure) throw effectFailure.error;
  if (renewalFailure) throw renewalFailure.error;
}

/**
 * Creates the standard durable event dispatcher.
 *
 * The inbox row has its own renewable 30-second lease. Every effect must also
 * deduplicate by the supplied inbox id because a crash can occur after the
 * effect commits but before this handler marks the inbox done. Contact and IM
 * events remain hints: this layer never derives member absence from an event.
 */
export function createVerifiedEventJobHandler(options: {
  pool: Pool;
  effects: VerifiedEventEffects;
  /** Test seam; production renews every ten seconds. */
  leaseRenewalIntervalMs?: number;
}): EnterpriseJobHandler {
  if (
    typeof options.effects?.onContactHint !== "function" ||
    typeof options.effects?.onPrivateMessageHint !== "function"
  ) {
    throw new Error("[@megaui/engine] verified event effects must be configured");
  }
  const renewalIntervalMs =
    options.leaseRenewalIntervalMs ?? EVENT_INBOX_LEASE_RENEWAL_MS;
  if (
    !Number.isSafeInteger(renewalIntervalMs) ||
    renewalIntervalMs <= 0 ||
    renewalIntervalMs >= EVENT_INBOX_LEASE_SECONDS * 1_000
  ) {
    throw new Error("[@megaui/engine] invalid verified event lease renewal interval");
  }

  return async (job) => {
    const inboxId = parseInboxId(job);
    const claimOwner = `event-job:${job.id}:${randomUUID()}`;
    const claimed = await options.pool.query<InboxRow>(
      `update "enterprise_event_inbox"
          set state = 'leased', claim_owner = $2,
              lease_until = now() + ($3 * interval '1 second'),
              attempts = attempts + 1, updated_at = now()
        where id = $1
          and (state = 'pending'
            or (state = 'leased' and (claim_owner = $2 or lease_until < now())))
      returning id, tenant_key as "tenantKey", app_id as "appId",
                event_id as "eventId", event_type as "eventType",
                event_created_at as "eventCreatedAt",
                subject_open_id as "subjectOpenId", message_id as "messageId",
                sender_open_id as "senderOpenId", sender_type as "senderType",
                chat_type as "chatType", message_type as "messageType",
                pairing_token_digest as "pairingTokenDigest", state`,
      [inboxId, claimOwner, EVENT_INBOX_LEASE_SECONDS],
    );

    if (claimed.rows.length === 0) {
      const current = await options.pool.query<{ state: string }>(
        `select state from "enterprise_event_inbox" where id = $1`,
        [inboxId],
      );
      if (current.rows[0]?.state === "done") return;
      throw new Error("[@megaui/engine] verified event inbox is not claimable");
    }

    const row = claimed.rows[0]!;
    try {
      if (
        row.eventType === "contact.user.updated_v3" ||
        row.eventType === "contact.user.deleted_v3"
      ) {
        const event = rowToContactEvent(row);
        await runWithInboxLeaseRenewal({
          pool: options.pool,
          inboxId,
          claimOwner,
          renewalIntervalMs,
          effect: (context) => options.effects.onContactHint(event, context),
        });
      } else if (row.eventType === "im.message.receive_v1") {
        const event = rowToPrivateMessageEvent(row);
        await runWithInboxLeaseRenewal({
          pool: options.pool,
          inboxId,
          claimOwner,
          renewalIntervalMs,
          effect: (context) => options.effects.onPrivateMessageHint(event, context),
        });
      } else {
        throw new Error("[@megaui/engine] unsupported stored verified event type");
      }

      const completed = await options.pool.query(
        `update "enterprise_event_inbox"
            set state = 'done', claim_owner = null, lease_until = null,
                completed_at = now(), updated_at = now()
          where id = $1 and state = 'leased' and claim_owner = $2`,
        [inboxId, claimOwner],
      );
      if (completed.rowCount !== 1) {
        throw new Error("[@megaui/engine] verified event lease was lost before completion");
      }
    } catch (error) {
      try {
        await options.pool.query(
          `update "enterprise_event_inbox"
              set state = 'pending', claim_owner = null, lease_until = null,
                  updated_at = now()
            where id = $1 and state = 'leased' and claim_owner = $2`,
          [inboxId, claimOwner],
        );
      } catch {
        // Preserve the effect or completion error; an unreset lease expires.
      }
      throw error;
    }
  };
}
