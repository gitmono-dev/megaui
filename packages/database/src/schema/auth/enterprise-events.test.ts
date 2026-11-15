// FS-34：飞书事件 inbox schema。
//
// The suite proves the inbox constraints on a one-shot Postgres of FS-57. It
// never reads DATABASE_URL and never skips when Docker is unavailable.
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "../../test-support/isolated-pg";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error(
    "[@megaui/database] enterprise-events.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

let isolated: IsolatedPostgres;
let pool: Pool;

interface EventRow {
  id: string;
  tenantKey?: string;
  appId?: string;
  eventId: string;
  eventType?: string;
  subjectOpenId?: string | null;
  messageId?: string | null;
  senderOpenId?: string | null;
  senderType?: string | null;
  chatType?: string | null;
  messageType?: string | null;
  pairingTokenDigest?: string | null;
  state?: string;
  claimOwner?: string | null;
  leaseUntil?: string | null;
  completedAt?: string | null;
}

async function insertEvent(row: EventRow): Promise<void> {
  await pool.query(
    `insert into "enterprise_event_inbox"
       (id, tenant_key, app_id, event_id, event_type, event_created_at,
        subject_open_id, message_id, sender_open_id, sender_type, chat_type,
        message_type, pairing_token_digest, state, claim_owner, lease_until,
        completed_at)
     values ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      row.id,
      row.tenantKey ?? "tenant-events",
      row.appId ?? "app-events",
      row.eventId,
      row.eventType ?? "contact.user.updated_v3",
      row.subjectOpenId ?? null,
      row.messageId ?? null,
      row.senderOpenId ?? null,
      row.senderType ?? null,
      row.chatType ?? null,
      row.messageType ?? null,
      row.pairingTokenDigest ?? null,
      row.state ?? "pending",
      row.claimOwner ?? null,
      row.leaseUntil ?? null,
      row.completedAt ?? null,
    ],
  );
}

async function rollbackAndRelease(
  client: PoolClient,
  transactionOpen: boolean,
): Promise<void> {
  let rollbackError: Error | undefined;
  try {
    if (transactionOpen) await client.query("rollback");
  } catch (error) {
    rollbackError = error instanceof Error ? error : new Error(String(error));
  } finally {
    // A failed rollback means the connection itself is not safe to reuse.
    client.release(rollbackError);
  }
  if (rollbackError) throw rollbackError;
}

async function rollbackAndReleaseAll(
  clients: ReadonlyArray<{ client: PoolClient; transactionOpen: boolean }>,
): Promise<void> {
  const results = await Promise.allSettled(
    clients.map(({ client, transactionOpen }) => rollbackAndRelease(client, transactionOpen)),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}

describe("enterprise verified event inbox schema (FS-34)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (isolated) await isolated.destroy();
  }, 120_000);

  beforeEach(async () => {
    await pool.query(`truncate table "enterprise_event_inbox"`);
  });

  it("deduplicates Contact events by tenant, app, and event id", async () => {
    await insertEvent({ id: "contact-1", eventId: "evt-contact-1", subjectOpenId: "ou-1" });
    await expect(
      insertEvent({ id: "contact-2", eventId: "evt-contact-1", subjectOpenId: "ou-1" }),
    ).rejects.toThrow(/enterprise_event_inbox_tenant_app_event_uidx/);

    await insertEvent({
      id: "contact-other-app",
      appId: "app-other",
      eventId: "evt-contact-1",
      subjectOpenId: "ou-1",
    });
    await insertEvent({
      id: "contact-other-tenant",
      tenantKey: "tenant-other",
      eventId: "evt-contact-1",
      subjectOpenId: "ou-1",
    });
  });

  it("deduplicates IM events by tenant, app, and message id across event ids", async () => {
    const message = {
      eventType: "im.message.receive_v1",
      messageId: "om-message-1",
      senderOpenId: "ou-sender",
      senderType: "user",
      chatType: "p2p",
      messageType: "text",
    };
    await insertEvent({ id: "message-1", eventId: "evt-message-1", ...message });
    await expect(
      insertEvent({ id: "message-2", eventId: "evt-message-2", ...message }),
    ).rejects.toThrow(/enterprise_event_inbox_tenant_app_message_uidx/);

    await insertEvent({
      id: "message-other-tenant",
      tenantKey: "tenant-other",
      eventId: "evt-message-3",
      ...message,
    });
    await insertEvent({
      id: "message-other-app",
      appId: "app-other",
      eventId: "evt-message-4",
      ...message,
    });
  });

  it("requires a non-empty message id for verified IM message events", async () => {
    await expect(
      insertEvent({
        id: "message-missing-id",
        eventId: "evt-message-missing-id",
        eventType: "im.message.receive_v1",
      }),
    ).rejects.toThrow(/enterprise_event_inbox_message_id_required/);
    for (const [suffix, messageId] of [
      ["spaces", "   "],
      ["tab", "\t"],
      ["newline", "\n"],
    ] as const) {
      await expect(
        insertEvent({
          id: `message-${suffix}-id`,
          eventId: `evt-message-${suffix}-id`,
          eventType: "im.message.receive_v1",
          messageId,
        }),
      ).rejects.toThrow(/enterprise_event_inbox_message_id_required/);
    }
  });

  it("stores only the whitelisted business columns", async () => {
    const columns = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'enterprise_event_inbox'
        order by column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(
      [
        "app_id",
        "attempts",
        "available_at",
        "chat_type",
        "claim_owner",
        "completed_at",
        "created_at",
        "event_created_at",
        "event_id",
        "event_type",
        "id",
        "lease_until",
        "message_id",
        "message_type",
        "pairing_token_digest",
        "sender_open_id",
        "sender_type",
        "state",
        "subject_open_id",
        "tenant_key",
        "updated_at",
      ].sort(),
    );
    const names = new Set(columns.rows.map((row) => row.column_name));
    for (const forbidden of ["raw_body", "content", "message_text", "pairing_token"]) {
      expect(names.has(forbidden)).toBe(false);
    }
  });

  it("accepts only a pairing token digest and never a plaintext token", async () => {
    await expect(
      insertEvent({
        id: "digest-plain",
        eventId: "evt-digest-plain",
        eventType: "im.message.receive_v1",
        messageId: "om-digest-plain",
        pairingTokenDigest: "plain-pairing-token",
      }),
    ).rejects.toThrow(/enterprise_event_inbox_pairing_digest_shape/);

    const digest = "a".repeat(64);
    await insertEvent({
      id: "digest-valid",
      eventId: "evt-digest-valid",
      eventType: "im.message.receive_v1",
      messageId: "om-digest-valid",
      pairingTokenDigest: digest,
    });
    const stored = await pool.query<{ pairing_token_digest: string }>(
      `select pairing_token_digest from "enterprise_event_inbox" where id = $1`,
      ["digest-valid"],
    );
    expect(stored.rows[0]?.pairing_token_digest).toBe(digest);
  });

  it("rejects lease and completion states that cannot make progress", async () => {
    await expect(
      insertEvent({
        id: "leased-without-owner",
        eventId: "evt-leased-without-owner",
        state: "leased",
        leaseUntil: "2099-01-01 00:00:00+00",
      }),
    ).rejects.toThrow(/enterprise_event_inbox_state_fields/);
    await expect(
      insertEvent({
        id: "leased-whitespace-owner",
        eventId: "evt-leased-whitespace-owner",
        state: "leased",
        claimOwner: "\t",
        leaseUntil: "2099-01-01 00:00:00+00",
      }),
    ).rejects.toThrow(/enterprise_event_inbox_state_fields/);
    await expect(
      insertEvent({
        id: "leased-without-expiry",
        eventId: "evt-leased-without-expiry",
        state: "leased",
        claimOwner: "worker-events",
      }),
    ).rejects.toThrow(/enterprise_event_inbox_state_fields/);
    await expect(
      insertEvent({
        id: "done-without-completion",
        eventId: "evt-done-without-completion",
        state: "done",
      }),
    ).rejects.toThrow(/enterprise_event_inbox_state_fields/);

    await insertEvent({
      id: "leased-valid",
      eventId: "evt-leased-valid",
      state: "leased",
      claimOwner: "worker-events",
      leaseUntil: "2099-01-01 00:00:00+00",
    });
    await insertEvent({
      id: "done-valid",
      eventId: "evt-done-valid",
      state: "done",
      completedAt: "2026-09-01 00:00:00+00",
    });
  });

  it("supports indexed pending claims, lock skipping, and expired-lease reclaim", async () => {
    await insertEvent({ id: "lease-1", eventId: "evt-lease-1" });
    await insertEvent({ id: "lease-2", eventId: "evt-lease-2" });

    const locker = await pool.connect();
    const claimant = await pool.connect();
    let lockerOpen = false;
    let claimantOpen = false;
    let lockedId: string | undefined;
    let skippedId: string | undefined;
    try {
      await locker.query("begin");
      lockerOpen = true;
      const locked = await locker.query<{ id: string }>(
        `select id from "enterprise_event_inbox"
          where state = 'pending' and available_at <= now()
          order by available_at, id
          limit 1
          for update skip locked`,
      );
      expect(locked.rows).toHaveLength(1);
      lockedId = locked.rows[0]?.id;

      await claimant.query("begin");
      claimantOpen = true;
      const skipped = await claimant.query<{ id: string }>(
        `select id from "enterprise_event_inbox"
          where state = 'pending' and available_at <= now()
          order by available_at, id
          limit 1
          for update skip locked`,
      );
      expect(skipped.rows).toHaveLength(1);
      skippedId = skipped.rows[0]?.id;
      expect(skippedId).not.toBe(lockedId);
      await claimant.query(
        `update "enterprise_event_inbox"
            set state = 'leased', claim_owner = 'worker-initial',
                lease_until = now() - interval '1 second', attempts = attempts + 1
          where id = $1`,
        [skippedId],
      );
      await claimant.query("commit");
      claimantOpen = false;
      await locker.query("commit");
      lockerOpen = false;
    } finally {
      await rollbackAndReleaseAll([
        { client: claimant, transactionOpen: claimantOpen },
        { client: locker, transactionOpen: lockerOpen },
      ]);
    }

    const reclaimer = await pool.connect();
    let reclaimerOpen = false;
    try {
      await reclaimer.query("begin");
      reclaimerOpen = true;
      const reclaimed = await reclaimer.query<{ id: string }>(
        `select id from "enterprise_event_inbox"
          where state = 'leased' and lease_until < now()
          order by lease_until, id
          limit 1
          for update skip locked`,
      );
      expect(reclaimed.rows.map((row) => row.id)).toEqual([skippedId]);
      await reclaimer.query(
        `update "enterprise_event_inbox"
            set claim_owner = 'worker-reclaim',
                lease_until = now() + interval '30 seconds', attempts = attempts + 1
          where id = $1`,
        [skippedId],
      );
      await reclaimer.query("commit");
      reclaimerOpen = false;
    } finally {
      await rollbackAndRelease(reclaimer, reclaimerOpen);
    }

    const leased = await pool.query<{
      attempts: number;
      claim_owner: string;
    }>(
      `select attempts, claim_owner from "enterprise_event_inbox" where id = $1`,
      [skippedId],
    );
    expect(leased.rows).toEqual([{ attempts: 2, claim_owner: "worker-reclaim" }]);

    const indexes = await pool.query<{ indexdef: string; indexname: string }>(
      `select indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'enterprise_event_inbox'
          and indexname in (
            'enterprise_event_inbox_pending_claim_idx',
            'enterprise_event_inbox_lease_claim_idx'
          )
        order by indexname`,
    );
    expect(indexes.rows).toHaveLength(2);
    const indexByName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));
    const pendingIndex = indexByName.get("enterprise_event_inbox_pending_claim_idx");
    expect(pendingIndex).toContain("(available_at, id)");
    expect(pendingIndex).toContain("pending");
    const leaseIndex = indexByName.get("enterprise_event_inbox_lease_claim_idx");
    expect(leaseIndex).toContain("(lease_until, id)");
    expect(leaseIndex).toContain("leased");

    const planner = await pool.connect();
    let plannerOpen = false;
    try {
      await planner.query("begin");
      plannerOpen = true;
      await planner.query("set local enable_seqscan = off");
      const pendingPlan = await planner.query<{ "QUERY PLAN": string }>(
        `explain (costs off)
         select id from "enterprise_event_inbox"
          where state = 'pending' and available_at <= now()
          order by available_at, id
          limit 1
          for update skip locked`,
      );
      expect(pendingPlan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
        "enterprise_event_inbox_pending_claim_idx",
      );
      const leasePlan = await planner.query<{ "QUERY PLAN": string }>(
        `explain (costs off)
         select id from "enterprise_event_inbox"
          where state = 'leased' and lease_until < now()
          order by lease_until, id
          limit 1
          for update skip locked`,
      );
      expect(leasePlan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
        "enterprise_event_inbox_lease_claim_idx",
      );
      await planner.query("rollback");
      plannerOpen = false;
    } finally {
      await rollbackAndRelease(planner, plannerOpen);
    }
  });

  it("paginates TTL cleanup and never deletes unfinished leased metadata", async () => {
    await insertEvent({
      id: "ttl-done-1",
      eventId: "evt-ttl-done-1",
      state: "done",
      completedAt: "2026-09-01 00:00:00+00",
    });
    await insertEvent({
      id: "ttl-done-2",
      eventId: "evt-ttl-done-2",
      state: "done",
      completedAt: "2026-09-02 00:00:00+00",
    });
    await insertEvent({
      id: "ttl-leased",
      eventId: "evt-ttl-leased",
      state: "leased",
      claimOwner: "worker-active",
      leaseUntil: "2099-01-01 00:00:00+00",
    });

    const deleted = await pool.query<{ id: string }>(
      `with page as (
         select id from "enterprise_event_inbox"
          where state = 'done' and completed_at < $1
          order by completed_at, id
          limit 1
       )
       delete from "enterprise_event_inbox" as inbox
        using page where inbox.id = page.id
       returning inbox.id`,
      ["2026-10-01 00:00:00+00"],
    );
    expect(deleted.rows.map((row) => row.id)).toEqual(["ttl-done-1"]);

    const remaining = await pool.query<{ id: string }>(
      `select id from "enterprise_event_inbox"
        where id in ('ttl-done-1', 'ttl-done-2', 'ttl-leased') order by id`,
    );
    expect(remaining.rows.map((row) => row.id)).toEqual(["ttl-done-2", "ttl-leased"]);

    const index = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'enterprise_event_inbox'
          and indexname = 'enterprise_event_inbox_cleanup_idx'`,
    );
    expect(index.rows[0]?.indexdef).toContain("state");
    expect(index.rows[0]?.indexdef).toContain("completed_at");
    expect(index.rows[0]?.indexdef).toContain("id");
  });
});
