// FS-08：目录对账与新鲜度失效。
//
// The suite drives the reconciler, the atomic store, and durable scheduling
// against an isolated Postgres. It proves every acceptance criterion without
// reading a developer database or an environment file.
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createEnterpriseDirectoryStore, type EnterpriseDirectoryStore } from "@megaui/database";
import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "@megaui/database/test-support";

import {
  DIRECTORY_FRESHNESS_LIMIT_MS,
  DIRECTORY_SYNC_PERIOD_MS,
  isDirectoryFresh,
  mayAdvanceGeneration,
  nextIdentityState,
  reconcileDirectory,
} from "./directory-sync";
import {
  createDirectorySyncJobHandler,
  DIRECTORY_SYNC_QUEUE,
  nextDirectorySyncSchedule,
  scheduleDirectorySyncJob,
} from "./jobs";
import { scopeHashOf, type DirectoryMember, type DirectoryScope, type DirectorySnapshot } from "./feishu/directory";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error(
    "[@megaui/engine] directory-sync.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

const SCOPE: DirectoryScope = {
  tenantKey: "tenant-1",
  appId: "app-1",
  departmentIds: ["od-a", "od-b"],
};
const NARROW_SCOPE: DirectoryScope = {
  tenantKey: "tenant-1",
  appId: "app-1",
  departmentIds: ["od-a"],
};

function member(openId: string, departmentIds: string[] = ["od-a"]): DirectoryMember {
  return {
    openId,
    name: `Member ${openId}`,
    notificationEmail: `${openId}@example.com`,
    status: { isActivated: true, isFrozen: false, isResigned: false, isExited: false },
    departmentIds,
  };
}

function snapshot(
  scope: DirectoryScope,
  generation: number,
  members: DirectoryMember[],
  complete = true,
): DirectorySnapshot {
  return { scopeHash: scopeHashOf(scope), generation, complete, members };
}

let isolated: IsolatedPostgres;
let pool: Pool;
let store: EnterpriseDirectoryStore;

async function insertIdentity(identityId: string, openId: string): Promise<void> {
  const userId = `user-${identityId}`;
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, false)`,
    [userId, `User ${identityId}`, `${identityId}@example.test`],
  );
  await pool.query(
    `insert into "enterprise_identity"
       (id, local_user_id, tenant_key, app_id, open_id)
     values ($1, $2, $3, $4, $5)`,
    [identityId, userId, SCOPE.tenantKey, SCOPE.appId, openId],
  );
}

async function reconcile(
  currentScope: DirectoryScope,
  next: DirectorySnapshot,
  previousScope?: DirectoryScope,
) {
  return reconcileDirectory({
    scope: currentScope,
    previousScope,
    store,
    readSnapshot: async () => next,
    now: () => Date.parse("2026-11-09T00:00:00.000Z"),
  });
}

describe("directory reconciliation and freshness (FS-08)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    store = createEnterpriseDirectoryStore(pool);
  }, 120_000);

  beforeEach(async () => {
    await pool.query(`delete from "enterprise_jobs"`);
    await pool.query(`delete from "enterprise_directory_identity_watermarks"`);
    await pool.query(`delete from "enterprise_directory_snapshots"`);
    await pool.query(`delete from "enterprise_directory_watermarks"`);
    await pool.query(`delete from "enterprise_identity"`);
    await pool.query(`delete from "user"`);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (isolated) await isolated.destroy();
  }, 120_000);

  it("schedules one idempotent durable run every five minutes without credentials", async () => {
    const scheduledFor = "2026-11-09T00:00:00.000Z";
    expect(DIRECTORY_SYNC_PERIOD_MS).toBe(5 * 60 * 1000);
    expect(nextDirectorySyncSchedule(scheduledFor).toISOString()).toBe(
      "2026-11-09T00:05:00.000Z",
    );

    const payload = { scope: SCOPE, scheduledFor };
    expect(await scheduleDirectorySyncJob(pool, payload)).toBe(true);
    expect(await scheduleDirectorySyncJob(pool, payload)).toBe(false);

    const jobs = await pool.query<{ queue: string; payload: Record<string, unknown> }>(
      `select queue, payload from "enterprise_jobs"`,
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.queue).toBe(DIRECTORY_SYNC_QUEUE);
    expect(jobs.rows[0]?.payload).toEqual({ scope: SCOPE, scheduledFor });
    expect(JSON.stringify(jobs.rows[0]?.payload)).not.toContain("secret");
  });

  it("consumes a scope transition once when it schedules the next slot", async () => {
    const seen: unknown[] = [];
    const handler = createDirectorySyncJobHandler({
      writer: pool,
      reconcile: async (payload) => {
        seen.push(payload.previousScope);
        return { kind: "applied", missing: [], outOfScope: [] };
      },
    });
    await handler({
      id: "directory-job-1",
      queue: DIRECTORY_SYNC_QUEUE,
      payload: {
        scope: NARROW_SCOPE,
        previousScope: SCOPE,
        scheduledFor: "2026-11-09T00:00:00.000Z",
      },
    });

    expect(seen).toEqual([SCOPE]);
    const next = await pool.query<{ payload: Record<string, unknown> }>(
      `select payload from "enterprise_jobs"`,
    );
    expect(next.rows[0]?.payload).toEqual({
      scope: NARROW_SCOPE,
      scheduledFor: "2026-11-09T00:05:00.000Z",
    });
  });

  it("retains the old scope until an applied retry consumes it monotonically", async () => {
    const source = {
      id: "directory-job-incomplete",
      queue: DIRECTORY_SYNC_QUEUE,
      payload: {
        scope: NARROW_SCOPE,
        previousScope: SCOPE,
        scheduledFor: "2026-11-09T00:00:00.000Z",
      },
    };
    const skippedHandler = createDirectorySyncJobHandler({
      writer: pool,
      reconcile: async () => ({ kind: "skipped", reason: "incomplete" }),
    });
    await skippedHandler(source);

    const retained = await pool.query<{ payload: Record<string, unknown> }>(
      `select payload from "enterprise_jobs"`,
    );
    expect(retained.rows).toHaveLength(1);
    expect(retained.rows[0]?.payload).toEqual({
      scope: NARROW_SCOPE,
      previousScope: SCOPE,
      scheduledFor: "2026-11-09T00:05:00.000Z",
    });

    // Simulate source-job redelivery after successor enqueue. An applied retry
    // removes the transition baseline from the existing successor. A later
    // stale/incomplete retry cannot add it back.
    const appliedHandler = createDirectorySyncJobHandler({
      writer: pool,
      reconcile: async () => ({ kind: "applied", missing: [], outOfScope: [] }),
    });
    await appliedHandler(source);
    await skippedHandler(source);

    const consumed = await pool.query<{ payload: Record<string, unknown> }>(
      `select payload from "enterprise_jobs"`,
    );
    expect(consumed.rows).toHaveLength(1);
    expect(consumed.rows[0]?.payload).toEqual({
      scope: NARROW_SCOPE,
      scheduledFor: "2026-11-09T00:05:00.000Z",
    });
  });

  it("processes a missing member only from a complete snapshot of the same scope", async () => {
    await insertIdentity("identity-1", "ou-1");
    await insertIdentity("identity-2", "ou-2");
    expect(
      await reconcile(SCOPE, snapshot(SCOPE, 1, [member("ou-1"), member("ou-2")])),
    ).toMatchObject({ kind: "applied", missing: [] });

    const outcome = await reconcile(SCOPE, snapshot(SCOPE, 2, [member("ou-1")]));
    expect(outcome).toEqual({
      kind: "applied",
      missing: [{ identityId: "identity-2", openId: "ou-2" }],
      outOfScope: [],
    });
    const watermark = await pool.query<{ generation: number }>(
      `select generation from "enterprise_directory_watermarks" where scope_hash = $1`,
      [scopeHashOf(SCOPE)],
    );
    expect(watermark.rows[0]?.generation).toBe(2);
  });

  it("keeps the previous complete snapshot when a page fails", async () => {
    await insertIdentity("identity-1", "ou-1");
    await reconcile(SCOPE, snapshot(SCOPE, 1, [member("ou-1")]));
    const incomplete = {
      ...snapshot(SCOPE, 2, [], false),
      interruptedAt: { departmentId: "od-b", reason: "timeout" },
    };

    expect(await reconcile(SCOPE, incomplete)).toEqual({ kind: "skipped", reason: "incomplete" });
    const state = await pool.query<{ generation: number }>(
      `select generation from "enterprise_directory_watermarks" where scope_hash = $1`,
      [scopeHashOf(SCOPE)],
    );
    const snapshots = await pool.query<{ count: number }>(
      `select count(*)::int as count from "enterprise_directory_snapshots"`,
    );
    expect(state.rows[0]?.generation).toBe(1);
    expect(snapshots.rows[0]?.count).toBe(1);
  });

  it("refuses a complete incoming snapshot of another scope before persistence", async () => {
    const other = { ...snapshot(SCOPE, 2, [member("ou-1")]), scopeHash: "another-scope" };
    expect(await reconcile(SCOPE, other)).toEqual({ kind: "skipped", reason: "scope_changed" });
    const watermarks = await pool.query<{ count: number }>(
      `select count(*)::int as count from "enterprise_directory_watermarks"`,
    );
    expect(watermarks.rows[0]?.count).toBe(0);
  });

  it("classifies an identity omitted by a real scope shrink as out_of_scope", async () => {
    await insertIdentity("identity-1", "ou-1");
    await insertIdentity("identity-2", "ou-2");
    await reconcile(
      SCOPE,
      snapshot(SCOPE, 1, [member("ou-1", ["od-a"]), member("ou-2", ["od-b"])]),
    );

    const outcome = await reconcile(
      NARROW_SCOPE,
      snapshot(NARROW_SCOPE, 2, [member("ou-1", ["od-a"])]),
      SCOPE,
    );
    expect(outcome).toEqual({
      kind: "applied",
      missing: [],
      outOfScope: [{ identityId: "identity-2", openId: "ou-2" }],
    });
  });

  it("uses an atomic CAS so overlapping and stale generations cannot restore state", async () => {
    await insertIdentity("identity-1", "ou-1");
    await reconcile(SCOPE, snapshot(SCOPE, 5, [member("ou-1")]));

    await Promise.all([
      reconcile(SCOPE, snapshot(SCOPE, 6, [member("ou-1")])),
      reconcile(SCOPE, snapshot(SCOPE, 7, [member("ou-1")])),
    ]);
    expect(await reconcile(SCOPE, snapshot(SCOPE, 6, [member("ou-1")]))).toEqual({
      kind: "skipped",
      reason: "stale_generation",
    });
    expect(mayAdvanceGeneration(7, 6)).toBe(false);
    expect(mayAdvanceGeneration(7, 8)).toBe(true);

    const scopeWatermark = await pool.query<{ generation: number }>(
      `select generation from "enterprise_directory_watermarks" where scope_hash = $1`,
      [scopeHashOf(SCOPE)],
    );
    const identityWatermark = await pool.query<{ generation: number }>(
      `select generation from "enterprise_directory_identity_watermarks"
       where identity_id = 'identity-1'`,
    );
    expect(scopeWatermark.rows[0]?.generation).toBe(7);
    expect(identityWatermark.rows[0]?.generation).toBe(7);
  });

  it("denies eligibility to an identity older than fifteen minutes", () => {
    expect(DIRECTORY_FRESHNESS_LIMIT_MS).toBe(15 * 60 * 1000);
    expect(isDirectoryFresh(0, DIRECTORY_FRESHNESS_LIMIT_MS)).toBe(true);
    expect(isDirectoryFresh(0, DIRECTORY_FRESHNESS_LIMIT_MS + 1)).toBe(false);
    expect(
      nextIdentityState({ localBan: false, directoryActive: true, fresh: false, advanced: true }),
    ).toBe("stale");
    expect(
      nextIdentityState({ localBan: false, directoryActive: true, fresh: true, advanced: true }),
    ).toBe("active");
  });

  it("never overrides a local ban with a directory recovery", () => {
    expect(
      nextIdentityState({ localBan: true, directoryActive: true, fresh: true, advanced: true }),
    ).toBe("inactive");
    expect(
      nextIdentityState({ localBan: true, directoryActive: false, fresh: false, advanced: false }),
    ).toBe("inactive");
  });
});
