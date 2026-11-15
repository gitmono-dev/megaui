// megaui-only (FS-08): the enterprise durable-job helpers have no upstream counterpart.
/** Durable enterprise job registration, beginning with directory reconciliation. */
import { createHash, randomUUID } from "node:crypto";

import {
  DIRECTORY_SYNC_PERIOD_MS,
  type DirectoryReconcileOutcome,
} from "./directory-sync";
import { scopeHashOf, type DirectoryScope } from "./feishu/directory";

export const DIRECTORY_SYNC_QUEUE = "enterprise.directory-sync";
/** Durable hand-off queues consumed by later Contact and bot-command owner cards. */
export const CONTACT_EVENT_HINT_QUEUE = "enterprise.contact-event-hint";
export const PRIVATE_MESSAGE_EVENT_HINT_QUEUE = "enterprise.private-message-event-hint";
/** The recurring queue that removes only completed verified-event metadata. */
export const EVENT_INBOX_CLEANUP_QUEUE = "enterprise.event-inbox-cleanup";
/** The queue that delivers an already-created encrypted login challenge. */
export const ENTERPRISE_DM_DELIVERY_QUEUE = "enterprise.dm-delivery";
/** The recurring queue that removes expired encrypted login payloads. */
export const ENTERPRISE_DM_CLEANUP_QUEUE = "enterprise.dm-cleanup";
/** The durable queue that fans a user revocation out to every collab instance. */
export const ENTERPRISE_COLLAB_REVOKE_QUEUE = "enterprise.collab-revoke";
/** The recurring queue that reconciles successful enterprise sessions to login notifications. */
export const ENTERPRISE_NOTIFICATION_QUEUE = "enterprise.login-notification";
/** The recurring queue that removes expired enterprise authentication metadata. */
export const ENTERPRISE_RETENTION_QUEUE = "enterprise.retention";
/** A delivery may be claimed at most three times. */
export const ENTERPRISE_DM_MAX_ATTEMPTS = 3;
/** One delivery UUID has a single twenty-second provider retry window. */
export const ENTERPRISE_DM_RETRY_WINDOW_MS = 20_000;
/** Cleanup is scheduled every minute, keeping expired ciphertext within five minutes. */
export const ENTERPRISE_DM_CLEANUP_PERIOD_MS = 60 * 1_000;
/** One cleanup execution can delete at most this many inbox rows. */
export const EVENT_INBOX_CLEANUP_BATCH_LIMIT = 100;
/** One encrypted-delivery cleanup execution is bounded to one worker batch. */
export const ENTERPRISE_DM_CLEANUP_BATCH_LIMIT = 100;
/** Completed event metadata is retained for thirty days. */
export const EVENT_INBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Cleanup is scheduled once per UTC hour. */
export const EVENT_INBOX_CLEANUP_PERIOD_MS = 60 * 60 * 1000;
/** The notification reconciliation cadence required by FS-21. */
export const ENTERPRISE_NOTIFICATION_RECONCILIATION_PERIOD_MS = 60 * 1_000;
/** One reconciliation claims at most this many session/grant rows. */
export const ENTERPRISE_NOTIFICATION_BATCH_LIMIT = 100;
/** Retention runs hourly and drains one bounded page per successful job. */
export const ENTERPRISE_RETENTION_PERIOD_MS = 60 * 60 * 1_000;
/** One retention transaction may remove at most this many rows in total. */
export const ENTERPRISE_RETENTION_BATCH_LIMIT = 100;

/** The queue-neutral job shape passed to every enterprise handler. */
export interface EnterpriseJob {
  id: string;
  queue: string;
  payload: Record<string, unknown>;
}

// FS-11: internal runtime ownership; existing one-argument handlers remain compatible.
export interface EnterpriseJobContext {
  readonly claimOwner: string;
  readonly signal: AbortSignal;
}
export type EnterpriseJobHandler = (job: EnterpriseJob, context?: EnterpriseJobContext) => Promise<void>;

export interface DirectorySyncJobPayload {
  scope: DirectoryScope;
  /** Present only on the first run after a configured scope transition. */
  previousScope?: DirectoryScope;
  scheduledFor: string;
}

export interface EnterpriseJobWriter {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
}

export interface EventInboxCleanupJobPayload {
  scheduledFor: string;
}

export interface EnterpriseNotificationReconciliationJobPayload {
  scheduledFor: string;
}

export interface EnterpriseRetentionJobPayload {
  scheduledFor: string;
}

export interface EnterpriseDmDeliveryJobPayload {
  deliveryId: string;
}

export interface EnterpriseDmCleanupJobPayload {
  scheduledFor: string;
}

export interface EnterpriseCollabRevokeJobPayload {
  userId: string;
  authEpoch: number;
  reason: string;
}

function recordOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[@megaui/engine] invalid directory-sync job payload");
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

/** Parses the delivery payload; no provider target or secret may enter it. */
export function parseEnterpriseDmDeliveryJobPayload(value: unknown): EnterpriseDmDeliveryJobPayload {
  const record = recordOf(value);
  if (Object.keys(record).length !== 1 || !uuid(record.deliveryId)) {
    throw new Error("[@megaui/engine] invalid enterprise DM delivery payload");
  }
  return { deliveryId: record.deliveryId };
}

export function parseEnterpriseDmCleanupJobPayload(value: unknown): EnterpriseDmCleanupJobPayload {
  const record = recordOf(value);
  if (Object.keys(record).length !== 1 || typeof record.scheduledFor !== "string") {
    throw new Error("[@megaui/engine] invalid enterprise DM cleanup schedule");
  }
  const scheduledFor = new Date(record.scheduledFor);
  if (Number.isNaN(scheduledFor.getTime()) || scheduledFor.toISOString() !== record.scheduledFor) {
    throw new Error("[@megaui/engine] invalid enterprise DM cleanup schedule");
  }
  return { scheduledFor: scheduledFor.toISOString() };
}

export function parseEnterpriseCollabRevokeJobPayload(value: unknown): EnterpriseCollabRevokeJobPayload {
  const record = recordOf(value);
  if (Object.keys(record).sort().join(",") !== "authEpoch,reason,userId" ||
    typeof record.userId !== "string" || record.userId.trim() === "" || record.userId.length > 256 ||
    typeof record.authEpoch !== "number" || !Number.isSafeInteger(record.authEpoch) || record.authEpoch < 0 ||
    typeof record.reason !== "string" || record.reason.trim() === "" || record.reason.length > 128) {
    throw new Error("[@megaui/engine] invalid collab revoke payload");
  }
  return { userId: record.userId, authEpoch: record.authEpoch, reason: record.reason };
}

/** Enqueues one user/epoch revocation without storing a ticket or service secret. */
export async function scheduleEnterpriseCollabRevokeJob(
  writer: EnterpriseJobWriter,
  value: EnterpriseCollabRevokeJobPayload,
): Promise<boolean> {
  const payload = parseEnterpriseCollabRevokeJobPayload(value);
  const result = await writer.query(
    `insert into "enterprise_jobs"
       (id, queue, dedupe_key, payload, available_at)
     values ($1, $2, $3, $4::jsonb, now())
     on conflict (dedupe_key) do nothing`,
    [randomUUID(), ENTERPRISE_COLLAB_REVOKE_QUEUE, `enterprise-collab-revoke:${payload.userId}:${payload.authEpoch}`, JSON.stringify(payload)],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Enqueues one idempotent delivery job; the payload contains only deliveryId. */
export async function scheduleEnterpriseDmDeliveryJob(
  writer: EnterpriseJobWriter,
  deliveryId: string,
): Promise<boolean> {
  if (!uuid(deliveryId)) throw new Error("[@megaui/engine] invalid enterprise DM delivery id");
  const payload = { deliveryId } satisfies EnterpriseDmDeliveryJobPayload;
  const result = await writer.query(
    `insert into "enterprise_jobs"
       (id, queue, dedupe_key, payload, available_at)
     values ($1, $2, $3, $4::jsonb, now())
     on conflict (dedupe_key) do nothing`,
    [randomUUID(), ENTERPRISE_DM_DELIVERY_QUEUE, `enterprise-dm-delivery:${deliveryId}`, JSON.stringify(payload)],
  );
  return (result.rowCount ?? 0) > 0;
}

export function nextEnterpriseDmCleanupSchedule(scheduledFor: string): Date {
  const current = new Date(scheduledFor);
  if (Number.isNaN(current.getTime()) || current.toISOString() !== scheduledFor) {
    throw new Error("[@megaui/engine] invalid enterprise DM cleanup schedule");
  }
  return new Date(current.getTime() + ENTERPRISE_DM_CLEANUP_PERIOD_MS);
}

export function enterpriseDmCleanupSlot(now: Date): Date {
  if (Number.isNaN(now.getTime())) throw new Error("[@megaui/engine] invalid enterprise DM cleanup clock");
  const slot = new Date(now.getTime());
  slot.setUTCSeconds(0, 0);
  return slot;
}

/** Enqueues one idempotent recurring ciphertext-cleanup job. */
export async function scheduleEnterpriseDmCleanupJob(
  writer: EnterpriseJobWriter,
  value: EnterpriseDmCleanupJobPayload,
): Promise<boolean> {
  const payload = parseEnterpriseDmCleanupJobPayload(value);
  const result = await writer.query(
    `insert into "enterprise_jobs"
       (id, queue, dedupe_key, payload, available_at)
     values ($1, $2, $3, $4::jsonb, $5)
     on conflict (dedupe_key) do nothing`,
    [randomUUID(), ENTERPRISE_DM_CLEANUP_QUEUE, `enterprise-dm-cleanup:${payload.scheduledFor}`, JSON.stringify(payload), payload.scheduledFor],
  );
  return (result.rowCount ?? 0) > 0;
}

function scopeOf(value: unknown): DirectoryScope {
  const record = recordOf(value);
  if (
    typeof record.tenantKey !== "string" ||
    record.tenantKey === "" ||
    typeof record.appId !== "string" ||
    record.appId === "" ||
    !Array.isArray(record.departmentIds) ||
    !record.departmentIds.every((id) => typeof id === "string" && id !== "")
  ) {
    throw new Error("[@megaui/engine] invalid directory-sync scope");
  }
  return {
    tenantKey: record.tenantKey,
    appId: record.appId,
    departmentIds: record.departmentIds,
  };
}

/** Parses only the non-secret fields allowed in a durable directory job. */
export function parseDirectorySyncJobPayload(value: unknown): DirectorySyncJobPayload {
  const record = recordOf(value);
  if (typeof record.scheduledFor !== "string") {
    throw new Error("[@megaui/engine] invalid directory-sync schedule");
  }
  const scheduledFor = new Date(record.scheduledFor);
  if (Number.isNaN(scheduledFor.getTime())) {
    throw new Error("[@megaui/engine] invalid directory-sync schedule");
  }
  return {
    scope: scopeOf(record.scope),
    previousScope:
      record.previousScope === undefined ? undefined : scopeOf(record.previousScope),
    scheduledFor: scheduledFor.toISOString(),
  };
}

/** The next durable run is exactly five minutes after the current slot. */
export function nextDirectorySyncSchedule(scheduledFor: string): Date {
  const current = new Date(scheduledFor);
  if (Number.isNaN(current.getTime())) {
    throw new Error("[@megaui/engine] invalid directory-sync schedule");
  }
  return new Date(current.getTime() + DIRECTORY_SYNC_PERIOD_MS);
}

function dedupeKey(payload: DirectorySyncJobPayload): string {
  return `directory-sync:${createHash("sha256")
    .update(`${scopeHashOf(payload.scope)}\u0000${payload.scheduledFor}`)
    .digest("hex")}`;
}

/**
 * Inserts one idempotent durable run without persisting provider credentials.
 *
 * Retry progress is monotonic: an applied retry may remove `previousScope`
 * from an already queued successor, while a later stale retry can never add it
 * back. This closes the enqueue-before-source-completion crash window.
 */
export async function scheduleDirectorySyncJob(
  writer: EnterpriseJobWriter,
  value: DirectorySyncJobPayload,
): Promise<boolean> {
  const payload = parseDirectorySyncJobPayload(value);
  const result = await writer.query(
    `insert into "enterprise_jobs" as job
       (id, queue, dedupe_key, payload, available_at)
     values ($1, $2, $3, $4::jsonb, $5)
     on conflict (dedupe_key) do update
       set payload = excluded.payload, updated_at = now()
       where job.state = 'pending'
         and job.payload ? 'previousScope'
         and not (excluded.payload ? 'previousScope')`,
    [
      randomUUID(),
      DIRECTORY_SYNC_QUEUE,
      dedupeKey(payload),
      JSON.stringify(payload),
      payload.scheduledFor,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Wraps reconciliation as a durable worker handler.
 *
 * A run schedules the next slot. The previous scope is consumed only after a
 * complete snapshot was applied: an incomplete/stale run retains it so the
 * next complete transition still classifies excluded identities as
 * out-of-scope. Later same-scope runs omit it and classify absences as missing.
 */
export function createDirectorySyncJobHandler(options: {
  writer: EnterpriseJobWriter;
  reconcile: (payload: DirectorySyncJobPayload) => Promise<DirectoryReconcileOutcome>;
}): EnterpriseJobHandler {
  return async (job) => {
    const payload = parseDirectorySyncJobPayload(job.payload);
    const outcome = await options.reconcile(payload);
    await scheduleDirectorySyncJob(options.writer, {
      scope: payload.scope,
      previousScope: outcome.kind === "applied" ? undefined : payload.previousScope,
      scheduledFor: nextDirectorySyncSchedule(payload.scheduledFor).toISOString(),
    });
  };
}

/** Parses the non-secret recurring cleanup payload. */
export function parseEventInboxCleanupJobPayload(
  value: unknown,
): EventInboxCleanupJobPayload {
  const record = recordOf(value);
  if (typeof record.scheduledFor !== "string") {
    throw new Error("[@megaui/engine] invalid event-inbox cleanup schedule");
  }
  const scheduledFor = new Date(record.scheduledFor);
  if (Number.isNaN(scheduledFor.getTime())) {
    throw new Error("[@megaui/engine] invalid event-inbox cleanup schedule");
  }
  return { scheduledFor: scheduledFor.toISOString() };
}

/** Parses the non-secret recurring notification-reconciliation payload. */
export function parseEnterpriseNotificationReconciliationJobPayload(
  value: unknown,
): EnterpriseNotificationReconciliationJobPayload {
  const record = recordOf(value);
  if (typeof record.scheduledFor !== "string") {
    throw new Error("[@megaui/engine] invalid enterprise notification schedule");
  }
  const scheduledFor = new Date(record.scheduledFor);
  if (Number.isNaN(scheduledFor.getTime()) || scheduledFor.toISOString() !== record.scheduledFor) {
    throw new Error("[@megaui/engine] invalid enterprise notification schedule");
  }
  return { scheduledFor: scheduledFor.toISOString() };
}

/** Parses the non-secret recurring retention payload. */
export function parseEnterpriseRetentionJobPayload(value: unknown): EnterpriseRetentionJobPayload {
  const record = recordOf(value);
  if (typeof record.scheduledFor !== "string") {
    throw new Error("[@megaui/engine] invalid enterprise retention schedule");
  }
  const scheduledFor = new Date(record.scheduledFor);
  if (Number.isNaN(scheduledFor.getTime()) || scheduledFor.toISOString() !== record.scheduledFor) {
    throw new Error("[@megaui/engine] invalid enterprise retention schedule");
  }
  return { scheduledFor: scheduledFor.toISOString() };
}

/** Returns the UTC-hour slot used to deduplicate startup scheduling. */
export function eventInboxCleanupSlot(now: Date): Date {
  if (Number.isNaN(now.getTime())) {
    throw new Error("[@megaui/engine] invalid event-inbox cleanup clock");
  }
  const slot = new Date(now.getTime());
  slot.setUTCMinutes(0, 0, 0);
  return slot;
}

/** The next recurring cleanup slot. */
export function nextEventInboxCleanupSchedule(scheduledFor: string): Date {
  const current = new Date(scheduledFor);
  if (Number.isNaN(current.getTime())) {
    throw new Error("[@megaui/engine] invalid event-inbox cleanup schedule");
  }
  return new Date(current.getTime() + EVENT_INBOX_CLEANUP_PERIOD_MS);
}

/** Returns the UTC-minute slot used to deduplicate notification scheduling. */
export function enterpriseNotificationSlot(now: Date): Date {
  if (Number.isNaN(now.getTime())) {
    throw new Error("[@megaui/engine] invalid enterprise notification clock");
  }
  const slot = new Date(now.getTime());
  slot.setUTCSeconds(0, 0);
  return slot;
}

/** The next notification reconciliation slot. */
export function nextEnterpriseNotificationSchedule(scheduledFor: string): Date {
  const current = new Date(scheduledFor);
  if (Number.isNaN(current.getTime()) || current.toISOString() !== scheduledFor) {
    throw new Error("[@megaui/engine] invalid enterprise notification schedule");
  }
  return new Date(current.getTime() + ENTERPRISE_NOTIFICATION_RECONCILIATION_PERIOD_MS);
}

/** Returns the UTC-hour slot used to deduplicate retention scheduling. */
export function enterpriseRetentionSlot(now: Date): Date {
  if (Number.isNaN(now.getTime())) {
    throw new Error("[@megaui/engine] invalid enterprise retention clock");
  }
  const slot = new Date(now.getTime());
  slot.setUTCMinutes(0, 0, 0);
  return slot;
}

/** The next recurring retention slot. */
export function nextEnterpriseRetentionSchedule(scheduledFor: string): Date {
  const current = new Date(scheduledFor);
  if (Number.isNaN(current.getTime()) || current.toISOString() !== scheduledFor) {
    throw new Error("[@megaui/engine] invalid enterprise retention schedule");
  }
  return new Date(current.getTime() + ENTERPRISE_RETENTION_PERIOD_MS);
}

/** Inserts one idempotent hourly cleanup job. */
export async function scheduleEventInboxCleanupJob(
  writer: EnterpriseJobWriter,
  value: EventInboxCleanupJobPayload,
): Promise<boolean> {
  const payload = parseEventInboxCleanupJobPayload(value);
  const result = await writer.query(
    `insert into "enterprise_jobs"
       (id, queue, dedupe_key, payload, available_at)
     values ($1, $2, $3, $4::jsonb, $5)
     on conflict (dedupe_key) do nothing`,
    [
      randomUUID(),
      EVENT_INBOX_CLEANUP_QUEUE,
      `event-inbox-cleanup:${payload.scheduledFor}`,
      JSON.stringify(payload),
      payload.scheduledFor,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Inserts one idempotent per-minute notification reconciliation job. */
export async function scheduleEnterpriseNotificationReconciliationJob(
  writer: EnterpriseJobWriter,
  value: EnterpriseNotificationReconciliationJobPayload,
): Promise<boolean> {
  const payload = parseEnterpriseNotificationReconciliationJobPayload(value);
  const result = await writer.query(
    `insert into "enterprise_jobs"
       (id, queue, dedupe_key, payload, available_at)
     values ($1, $2, $3, $4::jsonb, $5)
     on conflict (dedupe_key) do nothing`,
    [
      randomUUID(),
      ENTERPRISE_NOTIFICATION_QUEUE,
      `enterprise-notification:${payload.scheduledFor}`,
      JSON.stringify(payload),
      payload.scheduledFor,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Inserts one idempotent recurring retention job. */
export async function scheduleEnterpriseRetentionJob(
  writer: EnterpriseJobWriter,
  value: EnterpriseRetentionJobPayload,
): Promise<boolean> {
  const payload = parseEnterpriseRetentionJobPayload(value);
  const result = await writer.query(
    `insert into "enterprise_jobs"
       (id, queue, dedupe_key, payload, available_at)
     values ($1, $2, $3, $4::jsonb, $5)
     on conflict (dedupe_key) do nothing`,
    [
      randomUUID(),
      ENTERPRISE_RETENTION_QUEUE,
      `enterprise-retention:${payload.scheduledFor}`,
      JSON.stringify(payload),
      payload.scheduledFor,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Deletes one bounded page of expired completed inbox metadata.
 *
 * Pending and leased rows are excluded regardless of age. `SKIP LOCKED` lets
 * two workers overlap safely without broad locks or an unbounded delete.
 */
export async function cleanupCompletedEventInbox(
  writer: EnterpriseJobWriter,
  now: Date = new Date(),
): Promise<number> {
  if (Number.isNaN(now.getTime())) {
    throw new Error("[@megaui/engine] invalid event-inbox cleanup clock");
  }
  const cutoff = new Date(now.getTime() - EVENT_INBOX_RETENTION_MS);
  const result = await writer.query(
    `with expired as (
       select inbox.id
         from "enterprise_event_inbox" as inbox
        where inbox.state = 'done' and inbox.completed_at < $1
          and not exists (
            select 1
              from "enterprise_jobs" as job
             where job.dedupe_key = 'verified-event-hint:' || inbox.id
               and job.state <> 'done'
          )
        order by inbox.completed_at, inbox.id
        limit $2
        for update of inbox skip locked
     )
     delete from "enterprise_event_inbox" as inbox
      using expired
      where inbox.id = expired.id`,
    [cutoff, EVENT_INBOX_CLEANUP_BATCH_LIMIT],
  );
  return result.rowCount ?? 0;
}

/** Runs one bounded cleanup page and durably schedules the next hourly slot. */
export function createEventInboxCleanupJobHandler(options: {
  writer: EnterpriseJobWriter;
  now?: () => Date;
}): EnterpriseJobHandler {
  return async (job) => {
    if (job.queue !== EVENT_INBOX_CLEANUP_QUEUE) {
      throw new Error("[@megaui/engine] event-inbox cleanup received another queue");
    }
    const payload = parseEventInboxCleanupJobPayload(job.payload);
    await cleanupCompletedEventInbox(options.writer, options.now?.() ?? new Date());
    await scheduleEventInboxCleanupJob(options.writer, {
      scheduledFor: nextEventInboxCleanupSchedule(payload.scheduledFor).toISOString(),
    });
  };
}
