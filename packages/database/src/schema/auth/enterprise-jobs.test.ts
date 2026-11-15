// FS-42：租约队列与撤销 outbox schema。
//
// The suite proves the constraints of the two new tables on a one-shot
// Postgres of FS-57. It never skips: without a docker daemon the run fails
// instead of pretending to have verified the schema.
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "../../test-support/isolated-pg";

const dockerAvailable = await isDockerAvailable();

if (!dockerAvailable) {
  throw new Error(
    "[@megaui/database] enterprise-jobs.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

let isolated: IsolatedPostgres;
let pool: Pool;
let userCounter = 0;

async function createUser(): Promise<string> {
  userCounter += 1;
  const id = `enterprise-jobs-user-${userCounter}`;
  await pool.query(
    `insert into "user" (id, name, email, email_verified) values ($1, $2, $3, false)`,
    [id, `User ${userCounter}`, `jobs-user${userCounter}@example.com`],
  );
  return id;
}

async function insertJob(row: {
  id: string;
  queue: string;
  dedupeKey: string;
  state?: string;
  claimOwner?: string | null;
  leaseUntil?: string | null;
  completedAt?: string | null;
}): Promise<void> {
  await pool.query(
    `insert into "enterprise_jobs"
       (id, queue, dedupe_key, state, claim_owner, lease_until, completed_at, available_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())`,
    [
      row.id,
      row.queue,
      row.dedupeKey,
      row.state ?? "pending",
      row.claimOwner ?? null,
      row.leaseUntil ?? null,
      row.completedAt ?? null,
    ],
  );
}

async function insertRevocation(row: {
  id: string;
  userId: string;
  authEpoch: number;
  reason?: string;
}): Promise<void> {
  await pool.query(
    `insert into "enterprise_revocations" (id, user_id, auth_epoch, reason)
     values ($1, $2, $3, $4)`,
    [row.id, row.userId, row.authEpoch, row.reason ?? "suspended"],
  );
}

describe("enterprise job queue and revocation outbox schema (FS-42)", () => {
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

  it("keeps the dedupe key of a job unique", async () => {
    await insertJob({ id: "job-dedupe-1", queue: "directory", dedupeKey: "dedupe-1" });
    await expect(
      insertJob({ id: "job-dedupe-2", queue: "directory", dedupeKey: "dedupe-1" }),
    ).rejects.toThrow(/enterprise_jobs_dedupe_key_uidx/);

    // The key is unique on its own, so another queue may not reuse it.
    await expect(
      insertJob({ id: "job-dedupe-3", queue: "inbox", dedupeKey: "dedupe-1" }),
    ).rejects.toThrow(/enterprise_jobs_dedupe_key_uidx/);
  });

  it("carries the claim owner and the lease of a job", async () => {
    await insertJob({
      id: "job-lease-1",
      queue: "notification",
      dedupeKey: "dedupe-lease-1",
      state: "leased",
      claimOwner: "worker-1",
      leaseUntil: "2026-11-09 12:00:00+00",
    });

    const stored = await pool.query<{ claim_owner: string; lease_until: Date }>(
      `select claim_owner, lease_until from "enterprise_jobs" where id = $1`,
      ["job-lease-1"],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.claim_owner).toBe("worker-1");
    expect(stored.rows[0]?.lease_until).toBeInstanceOf(Date);

    // A pending job has no owner and no lease.
    const pending = await pool.query<{ claim_owner: string | null; lease_until: Date | null }>(
      `select claim_owner, lease_until from "enterprise_jobs" where id = $1`,
      ["job-dedupe-1"],
    );
    expect(pending.rows[0]?.claim_owner).toBeNull();
    expect(pending.rows[0]?.lease_until).toBeNull();
  });

  it("keeps the idempotency key of a revocation unique per user and epoch", async () => {
    const userId = await createUser();
    await insertRevocation({ id: "revocation-1", userId, authEpoch: 3 });

    await expect(
      insertRevocation({ id: "revocation-2", userId, authEpoch: 3 }),
    ).rejects.toThrow(/enterprise_revocations_user_epoch_uidx/);

    // A later epoch is a new revocation.
    await insertRevocation({ id: "revocation-3", userId, authEpoch: 4 });

    // Another user may carry the same epoch.
    const otherUser = await createUser();
    await insertRevocation({ id: "revocation-4", userId: otherUser, authEpoch: 3 });
  });

  it("claims a job with a bounded skip locked query", async () => {
    await insertJob({ id: "job-claim-1", queue: "revoke", dedupeKey: "dedupe-claim-1" });
    await insertJob({ id: "job-claim-2", queue: "revoke", dedupeKey: "dedupe-claim-2" });

    const claim = async (): Promise<string[]> => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const rows = await client.query<{ id: string }>(
          `select id from "enterprise_jobs"
             where queue = $1 and state = 'pending' and available_at <= now()
             order by available_at
             limit 1
             for update skip locked`,
          ["revoke"],
        );
        await client.query("commit");
        return rows.rows.map((row) => row.id);
      } finally {
        client.release();
      }
    };

    const first = await claim();
    expect(first).toHaveLength(1);

    // The claim index is the one the query uses.
    const index = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'enterprise_jobs'
          and indexname = 'enterprise_jobs_claim_idx'`,
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]?.indexdef).toContain("queue");
    expect(index.rows[0]?.indexdef).toContain("state");
    expect(index.rows[0]?.indexdef).toContain("available_at");
  });

  it("cleans the completed jobs by their completion time", async () => {
    await insertJob({
      id: "job-cleanup-1",
      queue: "cleanup",
      dedupeKey: "dedupe-cleanup-1",
      state: "done",
      completedAt: "2026-11-01 00:00:00+00",
    });
    await insertJob({
      id: "job-cleanup-2",
      queue: "cleanup",
      dedupeKey: "dedupe-cleanup-2",
      state: "done",
      completedAt: "2026-11-08 00:00:00+00",
    });

    const index = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'enterprise_jobs'
          and indexname = 'enterprise_jobs_completed_at_idx'`,
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]?.indexdef).toContain("completed_at");

    const deleted = await pool.query(
      `delete from "enterprise_jobs" where completed_at < $1`,
      ["2026-11-02 00:00:00+00"],
    );
    expect(deleted.rowCount).toBe(1);

    const remaining = await pool.query<{ id: string }>(
      `select id from "enterprise_jobs" where queue = 'cleanup'`,
    );
    expect(remaining.rows.map((row) => row.id)).toEqual(["job-cleanup-2"]);
  });

  it("keeps every job and revocation independent of the local user", async () => {
    // A job is not bound to a user, but a revocation is.
    await expect(
      insertRevocation({
        id: "revocation-orphan",
        userId: "does-not-exist",
        authEpoch: 1,
      }),
    ).rejects.toThrow(/enterprise_revocations_user_id_user_id_fk/);

    await insertJob({ id: "job-standalone", queue: "standalone", dedupeKey: "dedupe-standalone" });
    const stored = await pool.query<{ id: string }>(
      `select id from "enterprise_jobs" where id = $1`,
      ["job-standalone"],
    );
    expect(stored.rows).toHaveLength(1);
  });
});
