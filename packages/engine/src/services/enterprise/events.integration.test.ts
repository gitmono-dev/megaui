// FS-66: durable verified-event acceptance and standard-worker registration.
//
// The suite owns an isolated PostgreSQL 16 instance, never reads an environment
// file, and proves the inbox/job transaction, replay behavior, safe hint
// dispatch, generation monotonicity, and bounded retention cleanup.
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createEnterpriseDirectoryStore,
  type EnterpriseDirectoryStore,
} from "@megaui/database";
import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "@megaui/database/test-support";

import {
  createStandardEnterpriseWorkerHandlers,
  type ClaimedJob,
} from "../../workers/enterprise";
import { reconcileDirectory } from "./directory-sync";
import {
  acceptVerifiedEvent,
  createVerifiedEventJobHandler,
  VERIFIED_EVENT_QUEUE,
  type AcceptedVerifiedEvent,
  type VerifiedContactUserUpdatedEvent,
  type VerifiedPrivateMessageEvent,
} from "./events";
import {
  cleanupCompletedEventInbox,
  CONTACT_EVENT_HINT_QUEUE,
  createEventInboxCleanupJobHandler,
  eventInboxCleanupSlot,
  EVENT_INBOX_CLEANUP_BATCH_LIMIT,
  EVENT_INBOX_CLEANUP_QUEUE,
  EVENT_INBOX_RETENTION_MS,
  ENTERPRISE_RETENTION_QUEUE,
  nextEventInboxCleanupSchedule,
  PRIVATE_MESSAGE_EVENT_HINT_QUEUE,
  scheduleEventInboxCleanupJob,
} from "./jobs";
import { scopeHashOf, type DirectoryScope } from "./feishu/directory";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error(
    "[@megaui/engine] events.integration.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

const EVENT_TIME = new Date("2026-11-09T00:00:00.000Z");
const CLEANUP_NOW = new Date("2026-11-09T12:00:00.000Z");
const PAIRING_DIGEST = "a".repeat(64);
const DIRECTORY_SCOPE: DirectoryScope = {
  tenantKey: "tenant-1",
  appId: "app-1",
  departmentIds: ["od-a", "od-b"],
};

function contactEvent(
  eventId = "evt-contact-1",
): VerifiedContactUserUpdatedEvent {
  return {
    tenantKey: "tenant-1",
    appId: "app-1",
    eventId,
    eventType: "contact.user.updated_v3",
    eventCreatedAt: EVENT_TIME,
    subjectOpenId: "ou-contact",
  };
}

function privateMessage(
  eventId = "evt-message-1",
  messageId = "om-message-1",
): VerifiedPrivateMessageEvent {
  return {
    tenantKey: "tenant-1",
    appId: "app-1",
    eventId,
    eventType: "im.message.receive_v1",
    eventCreatedAt: EVENT_TIME,
    messageId,
    senderOpenId: "ou-sender",
    senderType: "user",
    chatType: "p2p",
    messageType: "text",
    pairingTokenDigest: PAIRING_DIGEST,
  };
}

interface StoredJob {
  id: string;
  queue: string;
  payload: Record<string, unknown>;
}

async function storedJob(result: AcceptedVerifiedEvent): Promise<StoredJob> {
  const found = await pool.query<StoredJob>(
    `select id, queue, payload from "enterprise_jobs" where id = $1`,
    [result.jobId],
  );
  const row = found.rows[0];
  if (!row) throw new Error("the accepted event has no job");
  return row;
}

function claimedJob(row: StoredJob): ClaimedJob {
  return { id: row.id, queue: row.queue, payload: row.payload };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let isolated: IsolatedPostgres;
let pool: Pool;
let directoryStore: EnterpriseDirectoryStore;

describe("verified event persistence and worker dispatch (FS-66)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    directoryStore = createEnterpriseDirectoryStore(pool);
  }, 120_000);

  beforeEach(async () => {
    await pool.query(`delete from "enterprise_jobs"`);
    await pool.query(`delete from "enterprise_event_inbox"`);
    await pool.query(`delete from "enterprise_directory_identity_watermarks"`);
    await pool.query(`delete from "enterprise_directory_snapshots"`);
    await pool.query(`delete from "enterprise_directory_watermarks"`);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (isolated) await isolated.destroy();
  }, 120_000);

  it("returns the first durable result for event-id and message-id replays", async () => {
    const [firstContact, concurrentReplay] = await Promise.all([
      acceptVerifiedEvent(pool, contactEvent()),
      acceptVerifiedEvent(pool, contactEvent()),
    ]);
    expect(concurrentReplay).toEqual(firstContact);

    const firstMessage = await acceptVerifiedEvent(pool, privateMessage());
    const changedEnvelopeReplay = await acceptVerifiedEvent(
      pool,
      privateMessage("evt-message-replayed", "om-message-1"),
    );
    expect(changedEnvelopeReplay).toEqual(firstMessage);

    const inbox = await pool.query<{
      count: number;
      digests: number;
    }>(
      `select count(*)::int as count,
              count(pairing_token_digest)::int as digests
         from "enterprise_event_inbox"`,
    );
    const jobs = await pool.query<{ count: number }>(
      `select count(*)::int as count from "enterprise_jobs"`,
    );
    expect(inbox.rows[0]).toEqual({ count: 2, digests: 1 });
    expect(jobs.rows[0]?.count).toBe(2);

    const messageJob = await storedJob(firstMessage);
    expect(messageJob.queue).toBe(VERIFIED_EVENT_QUEUE);
    expect(messageJob.payload).toEqual({ inboxId: firstMessage.inboxId });
    expect(JSON.stringify(messageJob.payload)).not.toContain("/login");
  });

  it("commits the inbox and dispatch job atomically", async () => {
    await pool.query(
      `create function reject_verified_event_job() returns trigger
       language plpgsql as $$
       begin
         raise exception 'test rejects verified event job';
       end
       $$`,
    );
    await pool.query(
      `create trigger reject_verified_event_job
       before insert on "enterprise_jobs"
       for each row when (new.queue = 'enterprise.verified-event')
       execute function reject_verified_event_job()`,
    );

    try {
      await expect(
        acceptVerifiedEvent(pool, contactEvent("evt-atomic")),
      ).rejects.toThrow(/test rejects verified event job/);
    } finally {
      await pool.query(
        `drop trigger if exists reject_verified_event_job on "enterprise_jobs"`,
      );
      await pool.query(`drop function if exists reject_verified_event_job()`);
    }

    const inbox = await pool.query<{ count: number }>(
      `select count(*)::int as count from "enterprise_event_inbox"`,
    );
    const jobs = await pool.query<{ count: number }>(
      `select count(*)::int as count from "enterprise_jobs"`,
    );
    expect(inbox.rows[0]?.count).toBe(0);
    expect(jobs.rows[0]?.count).toBe(0);
  });

  it("rejects unsupported or malformed values before persistence", async () => {
    await expect(
      acceptVerifiedEvent(pool, {
        ...contactEvent("evt-unsupported"),
        eventType: "calendar.event.changed_v4",
      } as never),
    ).rejects.toThrow(/unsupported verified event type/);
    await expect(
      acceptVerifiedEvent(pool, privateMessage("evt-empty-message", "\t\n")),
    ).rejects.toThrow(/messageId must not be empty/);
    await expect(
      acceptVerifiedEvent(pool, {
        ...privateMessage("evt-bad-digest", "om-bad-digest"),
        pairingTokenDigest: "plaintext-token",
      }),
    ).rejects.toThrow(/lowercase SHA-256 digest/);

    const rows = await pool.query<{ count: number }>(
      `select count(*)::int as count from "enterprise_event_inbox"`,
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("registers the standard queues and dispatches safe Contact and IM hints", async () => {
    const contact = await acceptVerifiedEvent(pool, contactEvent("evt-dispatch-contact"));
    const message = await acceptVerifiedEvent(
      pool,
      privateMessage("evt-dispatch-message", "om-dispatch-message"),
    );
    const seenContact: unknown[] = [];
    const seenMessages: unknown[] = [];
    let incompleteOutcome: unknown;
    let storeCalls = 0;

    const handlers = createStandardEnterpriseWorkerHandlers(pool, {
      onContactHint: async (event) => {
        seenContact.push(event);
        incompleteOutcome = await reconcileDirectory({
          scope: DIRECTORY_SCOPE,
          store: {
            applyCompleteSnapshot: async () => {
              storeCalls += 1;
              throw new Error("an incomplete snapshot reached the store");
            },
          },
          readSnapshot: async () => ({
            scopeHash: scopeHashOf(DIRECTORY_SCOPE),
            generation: 1,
            complete: false,
            members: [],
            interruptedAt: { departmentId: "od-b", reason: "timeout" },
          }),
        });
      },
      onPrivateMessageHint: async (event) => {
        seenMessages.push(event);
      },
    });

    expect(Object.keys(handlers).sort()).toEqual(
      [ENTERPRISE_RETENTION_QUEUE, EVENT_INBOX_CLEANUP_QUEUE, VERIFIED_EVENT_QUEUE].sort(),
    );
    await handlers[VERIFIED_EVENT_QUEUE]!(claimedJob(await storedJob(contact)));
    await handlers[VERIFIED_EVENT_QUEUE]!(claimedJob(await storedJob(message)));

    expect(incompleteOutcome).toEqual({ kind: "skipped", reason: "incomplete" });
    expect(storeCalls).toBe(0);
    expect(seenContact).toMatchObject([
      {
        inboxId: contact.inboxId,
        eventType: "contact.user.updated_v3",
        subjectOpenId: "ou-contact",
      },
    ]);
    expect(seenMessages).toMatchObject([
      {
        inboxId: message.inboxId,
        eventType: "im.message.receive_v1",
        messageId: "om-dispatch-message",
        pairingTokenDigest: PAIRING_DIGEST,
      },
    ]);
    expect(JSON.stringify(seenMessages)).not.toContain("/login");

    const states = await pool.query<{ state: string; count: number }>(
      `select state, count(*)::int as count
         from "enterprise_event_inbox"
        group by state`,
    );
    expect(states.rows).toEqual([{ state: "done", count: 2 }]);
  });

  it("durably hands off standard Contact and IM hints when no business consumer is active", async () => {
    const contact = await acceptVerifiedEvent(pool, contactEvent("evt-durable-contact"));
    const message = await acceptVerifiedEvent(
      pool,
      privateMessage("evt-durable-message", "om-durable-message"),
    );
    const handlers = createStandardEnterpriseWorkerHandlers(pool);

    await handlers[VERIFIED_EVENT_QUEUE]!(claimedJob(await storedJob(contact)));
    await handlers[VERIFIED_EVENT_QUEUE]!(claimedJob(await storedJob(message)));

    const followUps = await pool.query<{
      queue: string;
      payload: Record<string, unknown>;
    }>(
      `select queue, payload
         from "enterprise_jobs"
        where queue = any($1::text[])
        order by queue`,
      [[CONTACT_EVENT_HINT_QUEUE, PRIVATE_MESSAGE_EVENT_HINT_QUEUE]],
    );
    expect(followUps.rows).toEqual([
      { queue: CONTACT_EVENT_HINT_QUEUE, payload: { inboxId: contact.inboxId } },
      {
        queue: PRIVATE_MESSAGE_EVENT_HINT_QUEUE,
        payload: { inboxId: message.inboxId },
      },
    ]);
    expect(JSON.stringify(followUps.rows)).not.toContain("/login");

    const states = await pool.query<{ state: string; count: number }>(
      `select state, count(*)::int as count
         from "enterprise_event_inbox"
        group by state`,
    );
    expect(states.rows).toEqual([{ state: "done", count: 2 }]);
  });

  it("releases the inbox lease when a downstream effect fails", async () => {
    const accepted = await acceptVerifiedEvent(pool, contactEvent("evt-retry"));
    const job = claimedJob(await storedJob(accepted));
    const failing = createVerifiedEventJobHandler({
      pool,
      effects: {
        onContactHint: async () => {
          throw new Error("temporary authoritative-read failure");
        },
        onPrivateMessageHint: async () => undefined,
      },
    });
    await expect(failing(job)).rejects.toThrow(/temporary authoritative-read failure/);

    const released = await pool.query<{
      state: string;
      claim_owner: string | null;
      lease_until: Date | null;
    }>(
      `select state, claim_owner, lease_until
         from "enterprise_event_inbox" where id = $1`,
      [accepted.inboxId],
    );
    expect(released.rows[0]).toEqual({
      state: "pending",
      claim_owner: null,
      lease_until: null,
    });

    await createVerifiedEventJobHandler({
      pool,
      effects: {
        onContactHint: async () => undefined,
        onPrivateMessageHint: async () => undefined,
      },
    })(job);
    const completed = await pool.query<{ state: string; attempts: number }>(
      `select state, attempts from "enterprise_event_inbox" where id = $1`,
      [accepted.inboxId],
    );
    expect(completed.rows[0]).toEqual({ state: "done", attempts: 2 });
  });

  it("renews the inbox lease while a downstream effect is still running", async () => {
    const accepted = await acceptVerifiedEvent(pool, contactEvent("evt-renew-lease"));
    const job = claimedJob(await storedJob(accepted));
    const effectStarted = deferred();
    const releaseEffect = deferred();
    let effectCalls = 0;
    const effects = {
      onContactHint: async (): Promise<void> => {
        effectCalls += 1;
        effectStarted.resolve();
        await releaseEffect.promise;
      },
      onPrivateMessageHint: async (): Promise<void> => undefined,
    };
    const first = createVerifiedEventJobHandler({
      pool,
      effects,
      leaseRenewalIntervalMs: 20,
    })(job);
    await effectStarted.promise;

    try {
      await pool.query(
        `update "enterprise_event_inbox"
            set lease_until = now() + interval '5 milliseconds'
          where id = $1`,
        [accepted.inboxId],
      );
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));

      const renewed = await pool.query<{ lease_until: Date }>(
        `select lease_until from "enterprise_event_inbox" where id = $1`,
        [accepted.inboxId],
      );
      expect(renewed.rows[0]!.lease_until.getTime()).toBeGreaterThan(
        Date.now() + 20_000,
      );
      await expect(
        createVerifiedEventJobHandler({
          pool,
          effects,
          leaseRenewalIntervalMs: 20,
        })(job),
      ).rejects.toThrow(/inbox is not claimable/);
      expect(effectCalls).toBe(1);
    } finally {
      releaseEffect.resolve();
      await first;
    }
  });

  it("keeps a newer directory generation when an older event effect finishes later", async () => {
    const scopeHash = scopeHashOf(DIRECTORY_SCOPE);
    const olderAccepted = await acceptVerifiedEvent(
      pool,
      contactEvent("evt-generation-older"),
    );
    const newerAccepted = await acceptVerifiedEvent(
      pool,
      contactEvent("evt-generation-newer"),
    );
    const olderStarted = deferred();
    const releaseOlder = deferred();
    const outcomes = new Map<
      string,
      Awaited<ReturnType<EnterpriseDirectoryStore["applyCompleteSnapshot"]>>
    >();
    const handler = createVerifiedEventJobHandler({
      pool,
      effects: {
        onContactHint: async (event) => {
          const isOlder = event.eventId === "evt-generation-older";
          if (isOlder) {
            olderStarted.resolve();
            await releaseOlder.promise;
          }
          const outcome = await directoryStore.applyCompleteSnapshot({
            tenantKey: DIRECTORY_SCOPE.tenantKey,
            appId: DIRECTORY_SCOPE.appId,
            scopeHash,
            generation: isOlder ? 8 : 9,
            observedAt: isOlder
              ? new Date(EVENT_TIME.getTime() + 1_000)
              : EVENT_TIME,
            memberOpenIds: [],
          });
          outcomes.set(event.eventId, outcome);
        },
        onPrivateMessageHint: async () => undefined,
      },
    });

    const older = handler(claimedJob(await storedJob(olderAccepted)));
    await olderStarted.promise;
    await handler(claimedJob(await storedJob(newerAccepted)));
    releaseOlder.resolve();
    await older;

    expect(outcomes.get("evt-generation-newer")?.applied).toBe(true);
    expect(outcomes.get("evt-generation-older")).toEqual({
      applied: false,
      previous: [],
    });
    const watermark = await pool.query<{ generation: number }>(
      `select generation from "enterprise_directory_watermarks"
        where scope_hash = $1`,
      [scopeHash],
    );
    expect(watermark.rows[0]?.generation).toBe(9);
    const states = await pool.query<{ state: string; count: number }>(
      `select state, count(*)::int as count
         from "enterprise_event_inbox"
        group by state`,
    );
    expect(states.rows).toEqual([{ state: "done", count: 2 }]);
  });

  it("deletes at most one hundred expired done rows and no unfinished row", async () => {
    expect(EVENT_INBOX_CLEANUP_BATCH_LIMIT).toBe(100);
    expect(EVENT_INBOX_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    await pool.query(
      `insert into "enterprise_event_inbox"
         (id, tenant_key, app_id, event_id, event_type, event_created_at,
          subject_open_id, state, completed_at, created_at, updated_at)
       select 'old-' || number, 'tenant-1', 'app-1', 'old-event-' || number,
              'contact.user.updated_v3', $1, 'ou-old', 'done',
              $2, $1, $1
         from generate_series(1, 105) as number`,
      [EVENT_TIME, new Date(CLEANUP_NOW.getTime() - EVENT_INBOX_RETENTION_MS - 1)],
    );
    await pool.query(
      `insert into "enterprise_event_inbox"
         (id, tenant_key, app_id, event_id, event_type, event_created_at,
          subject_open_id, state, claim_owner, lease_until, completed_at)
       values
         ('fresh-done', 'tenant-1', 'app-1', 'fresh-event',
          'contact.user.updated_v3', $1, 'ou-fresh', 'done', null, null, $2),
         ('pending-old', 'tenant-1', 'app-1', 'pending-event',
          'contact.user.updated_v3', $1, 'ou-pending', 'pending', null, null, null),
         ('leased-old', 'tenant-1', 'app-1', 'leased-event',
          'contact.user.updated_v3', $1, 'ou-leased', 'leased',
          'active-worker', $3, null)`,
      [
        EVENT_TIME,
        new Date(CLEANUP_NOW.getTime() - EVENT_INBOX_RETENTION_MS + 1),
        new Date(CLEANUP_NOW.getTime() + 60_000),
      ],
    );
    await pool.query(
      `insert into "enterprise_event_inbox"
         (id, tenant_key, app_id, event_id, event_type, event_created_at,
          subject_open_id, state, completed_at, created_at, updated_at)
       values ('waiting-handoff', 'tenant-1', 'app-1', 'waiting-event',
               'contact.user.updated_v3', $1, 'ou-waiting', 'done', $2, $1, $1)`,
      [EVENT_TIME, new Date(CLEANUP_NOW.getTime() - EVENT_INBOX_RETENTION_MS - 1)],
    );
    await pool.query(
      `insert into "enterprise_jobs" (id, queue, dedupe_key, payload, available_at)
       values ('waiting-handoff-job', $1, 'verified-event-hint:waiting-handoff', $2::jsonb, now())`,
      [CONTACT_EVENT_HINT_QUEUE, JSON.stringify({ inboxId: "waiting-handoff" })],
    );

    expect(await cleanupCompletedEventInbox(pool, CLEANUP_NOW)).toBe(100);
    const remaining = await pool.query<{ state: string; count: number }>(
      `select state, count(*)::int as count
         from "enterprise_event_inbox"
        group by state
        order by state`,
    );
    expect(remaining.rows).toEqual([
      { state: "done", count: 7 },
      { state: "leased", count: 1 },
      { state: "pending", count: 1 },
    ]);
    expect(await cleanupCompletedEventInbox(pool, CLEANUP_NOW)).toBe(5);

    const survivors = await pool.query<{ id: string }>(
      `select id from "enterprise_event_inbox" order by id`,
    );
    expect(survivors.rows).toEqual([
      { id: "fresh-done" },
      { id: "leased-old" },
      { id: "pending-old" },
      { id: "waiting-handoff" },
    ]);
  });

  it("deduplicates the startup cleanup slot and schedules the next hour", async () => {
    const slot = eventInboxCleanupSlot(CLEANUP_NOW);
    expect(slot.toISOString()).toBe("2026-11-09T12:00:00.000Z");
    expect(nextEventInboxCleanupSchedule(slot.toISOString()).toISOString()).toBe(
      "2026-11-09T13:00:00.000Z",
    );
    expect(
      await scheduleEventInboxCleanupJob(pool, { scheduledFor: slot.toISOString() }),
    ).toBe(true);
    expect(
      await scheduleEventInboxCleanupJob(pool, { scheduledFor: slot.toISOString() }),
    ).toBe(false);

    const current = await pool.query<StoredJob>(
      `select id, queue, payload from "enterprise_jobs"
        where queue = $1`,
      [EVENT_INBOX_CLEANUP_QUEUE],
    );
    expect(current.rows).toHaveLength(1);
    await createEventInboxCleanupJobHandler({
      writer: pool,
      now: () => CLEANUP_NOW,
    })(claimedJob(current.rows[0]!));

    const schedules = await pool.query<{ scheduledFor: string }>(
      `select payload->>'scheduledFor' as "scheduledFor"
         from "enterprise_jobs"
        where queue = $1
        order by payload->>'scheduledFor'`,
      [EVENT_INBOX_CLEANUP_QUEUE],
    );
    expect(schedules.rows).toEqual([
      { scheduledFor: "2026-11-09T12:00:00.000Z" },
      { scheduledFor: "2026-11-09T13:00:00.000Z" },
    ]);
  });
});
