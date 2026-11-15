// FS-10: real-PostgreSQL authority joins for unified enterprise eligibility.
//
// This suite owns and migrates an isolated PostgreSQL 16 instance. It does not
// read DATABASE_URL or any environment sample file.
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createEnterpriseDirectoryStore } from "@megaui/database";
import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "@megaui/database/test-support";

import {
  createEnterpriseEligibilityService,
  createPostgresAuthenticationEligibilityReader,
  type EligibilitySqlClient,
} from "./eligibility";
import { DIRECTORY_FRESHNESS_LIMIT_MS, reconcileDirectory } from "./directory-sync";
import {
  scopeHashOf,
  type DirectoryMember,
  type DirectoryScope,
} from "./feishu/directory";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error(
    "[@megaui/engine] eligibility.integration.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

const NOW = new Date("2026-11-09T20:00:00.000Z");
const DIRECTORY_SCOPE: DirectoryScope = {
  tenantKey: "tenant-1",
  appId: "app-1",
  departmentIds: ["od-approved"],
};
const DIRECTORY_SCOPE_HASH = scopeHashOf(DIRECTORY_SCOPE);
const POLICY_SCOPE = "instance-1";
const USER_ID = "user-1";
const IDENTITY_ID = "identity-1";
const AUTH_EPOCH = 7;
const GENERATION = 4;

function directoryMember(isFrozen: boolean): DirectoryMember {
  return {
    openId: "ou-1",
    name: "Eligible User",
    notificationEmail: "eligible@example.test",
    departmentIds: ["od-approved"],
    status: {
      isActivated: true,
      isFrozen,
      isResigned: false,
      isExited: false,
    },
  };
}

let isolated: IsolatedPostgres;
let pool: Pool;

async function insertBaseline(): Promise<void> {
  await pool.query(
    `insert into "user" (id, name, email, email_verified, banned, ban_expires)
     values ($1, 'Eligible User', 'eligible@example.test', false, false, null)`,
    [USER_ID],
  );
  await pool.query(
    `insert into "enterprise_identity"
       (id, local_user_id, tenant_key, app_id, open_id, status)
     values ($1, $2, $3, $4, 'ou-1', 'active')`,
    [IDENTITY_ID, USER_ID, DIRECTORY_SCOPE.tenantKey, DIRECTORY_SCOPE.appId],
  );
  await pool.query(
    `insert into "enterprise_policy"
       (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
     values ('policy-1', $1, 'megaui', 'test', 'test', $2, 'enterprise')`,
    [POLICY_SCOPE, AUTH_EPOCH],
  );
  await pool.query(
    `insert into "enterprise_directory_watermarks" (id, scope_hash, generation)
     values ('scope-watermark-1', $1, $2)`,
    [DIRECTORY_SCOPE_HASH, GENERATION],
  );
  await pool.query(
    `insert into "enterprise_directory_identity_watermarks"
       (id, identity_id, scope_hash, generation)
     values ('identity-watermark-1', $1, $2, $3)`,
    [IDENTITY_ID, DIRECTORY_SCOPE_HASH, GENERATION],
  );
  await pool.query(
    `insert into "enterprise_directory_snapshots"
       (id, scope_hash, generation, complete, member_count, observed_at, completed_at)
     values ('snapshot-1', $1, $2, true, 1, $3, $3)`,
    [
      DIRECTORY_SCOPE_HASH,
      GENERATION,
      new Date(NOW.getTime() - DIRECTORY_FRESHNESS_LIMIT_MS),
    ],
  );
}

function eligibility(client: EligibilitySqlClient = pool) {
  return createEnterpriseEligibilityService({
    directoryScope: DIRECTORY_SCOPE,
    policyScope: POLICY_SCOPE,
    authMode: "enterprise",
    databaseReader: createPostgresAuthenticationEligibilityReader(client),
    directoryReader: {
      tenantKey: DIRECTORY_SCOPE.tenantKey,
      appId: DIRECTORY_SCOPE.appId,
      read: async () => Promise.reject(new Error("authentication must not call the provider")),
    },
    now: () => new Date(NOW),
  });
}

async function expectRejected(
  localUserId = USER_ID,
  identityId = IDENTITY_ID,
  epoch = AUTH_EPOCH,
): Promise<void> {
  await expect(
    eligibility().authenticationEligibility(localUserId, identityId, epoch),
  ).resolves.toBe(false);
}

describe("PostgreSQL enterprise eligibility authority read (FS-10)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
  }, 120_000);

  beforeEach(async () => {
    await pool.query(`delete from "enterprise_directory_identity_watermarks"`);
    await pool.query(`delete from "enterprise_directory_snapshots"`);
    await pool.query(`delete from "enterprise_directory_watermarks"`);
    await pool.query(`delete from "enterprise_identity"`);
    await pool.query(`delete from "enterprise_policy"`);
    await pool.query(`delete from "user"`);
    await insertBaseline();
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    if (pool) {
      try {
        await pool.end();
      } catch (error) {
        failures.push(error);
      }
    }
    if (isolated) {
      try {
        await isolated.destroy();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "FS-10 PostgreSQL fixture cleanup failed");
    }
  }, 120_000);

  it("approves the complete positive case with exactly one SQL statement", async () => {
    let statements = 0;
    const countingClient: EligibilitySqlClient = {
      query: async (text, values) => {
        statements += 1;
        const result = await pool.query(text, values);
        return { rows: result.rows };
      },
    };

    await expect(
      eligibility(countingClient).authenticationEligibility(USER_ID, IDENTITY_ID, AUTH_EPOCH),
    ).resolves.toBe(true);
    expect(statements).toBe(1);
  });

  it("uses the explicit ban flag with a PostgreSQL infinity expiry", async () => {
    await pool.query(
      `update "user" set banned = false, ban_expires = 'infinity'::timestamptz where id = $1`,
      [USER_ID],
    );
    await expect(
      eligibility().authenticationEligibility(USER_ID, IDENTITY_ID, AUTH_EPOCH),
    ).resolves.toBe(true);

    await pool.query(`update "user" set banned = true where id = $1`, [USER_ID]);
    await expectRejected();
  });

  it("does not advance eligibility for a frozen provider member", async () => {
    await pool.query(`delete from "enterprise_directory_identity_watermarks"`);
    await pool.query(`delete from "enterprise_directory_snapshots"`);
    await pool.query(`delete from "enterprise_directory_watermarks"`);
    const store = createEnterpriseDirectoryStore(pool);

    await expect(
      reconcileDirectory({
        scope: DIRECTORY_SCOPE,
        store,
        readSnapshot: async () => ({
          scopeHash: DIRECTORY_SCOPE_HASH,
          generation: 1,
          complete: true,
          members: [directoryMember(true)],
        }),
        now: () => NOW.getTime(),
      }),
    ).resolves.toMatchObject({ kind: "applied" });
    const frozenScope = await pool.query<{ generation: number }>(
      `select generation from "enterprise_directory_watermarks" where scope_hash = $1`,
      [DIRECTORY_SCOPE_HASH],
    );
    const frozenSnapshot = await pool.query<{
      complete: boolean;
      generation: number;
      memberCount: number;
    }>(
      `select complete, generation, member_count as "memberCount"
         from "enterprise_directory_snapshots"
        where scope_hash = $1`,
      [DIRECTORY_SCOPE_HASH],
    );
    const frozenIdentity = await pool.query<{ count: number }>(
      `select count(*)::int as count
         from "enterprise_directory_identity_watermarks"
        where identity_id = $1`,
      [IDENTITY_ID],
    );
    expect(frozenScope.rows).toEqual([{ generation: 1 }]);
    expect(frozenSnapshot.rows).toEqual([
      { complete: true, generation: 1, memberCount: 1 },
    ]);
    expect(frozenIdentity.rows).toEqual([{ count: 0 }]);
    await expectRejected();

    await expect(
      reconcileDirectory({
        scope: DIRECTORY_SCOPE,
        store,
        readSnapshot: async () => ({
          scopeHash: DIRECTORY_SCOPE_HASH,
          generation: 2,
          complete: true,
          members: [directoryMember(false)],
        }),
        now: () => NOW.getTime(),
      }),
    ).resolves.toMatchObject({ kind: "applied" });
    const activeIdentity = await pool.query<{ generation: number }>(
      `select generation
         from "enterprise_directory_identity_watermarks"
        where identity_id = $1`,
      [IDENTITY_ID],
    );
    expect(activeIdentity.rows).toEqual([{ generation: 2 }]);
    await expect(
      eligibility().authenticationEligibility(USER_ID, IDENTITY_ID, AUTH_EPOCH),
    ).resolves.toBe(true);
  });

  it("rejects a non-active identity and an incomplete snapshot", async () => {
    await pool.query(`update "enterprise_identity" set status = 'suspended' where id = $1`, [
      IDENTITY_ID,
    ]);
    await expectRejected();

    await pool.query(`update "enterprise_identity" set status = 'active' where id = $1`, [
      IDENTITY_ID,
    ]);
    await pool.query(`update "enterprise_directory_snapshots" set complete = false`);
    await expectRejected();
  });

  it("rejects a non-exact binding and fixed tenant, app, or scope mismatches", async () => {
    await expectRejected("user-other");
    await expectRejected(USER_ID, "identity-other");

    await pool.query(
      `update "enterprise_directory_identity_watermarks" set scope_hash = 'scope-other'`,
    );
    await expectRejected();
  });

  it("rejects an active ban, epoch mismatch, and non-enterprise effective mode", async () => {
    await pool.query(`update "user" set banned = true, ban_expires = null where id = $1`, [USER_ID]);
    await expectRejected();

    await pool.query(`update "user" set banned = false where id = $1`, [USER_ID]);
    await expectRejected(USER_ID, IDENTITY_ID, AUTH_EPOCH + 1);

    await pool.query(
      `update "enterprise_policy" set activation_state = 'maintenance' where scope = $1`,
      [POLICY_SCOPE],
    );
    await expectRejected();
  });

  it("rejects generation drift plus stale and future observations", async () => {
    await pool.query(
      `update "enterprise_directory_identity_watermarks" set generation = $1 where identity_id = $2`,
      [GENERATION - 1, IDENTITY_ID],
    );
    await expectRejected();

    await pool.query(
      `update "enterprise_directory_identity_watermarks" set generation = $1 where identity_id = $2`,
      [GENERATION, IDENTITY_ID],
    );
    await pool.query(`update "enterprise_directory_snapshots" set observed_at = $1`, [
      new Date(NOW.getTime() - DIRECTORY_FRESHNESS_LIMIT_MS - 1),
    ]);
    await expectRejected();

    await pool.query(`update "enterprise_directory_snapshots" set observed_at = $1`, [
      new Date(NOW.getTime() + 1),
    ]);
    await expectRejected();
  });

  it("keeps a quarantined active identity ineligible and requires a new watermark after repair", async () => {
    await expect(eligibility().authenticationEligibility(USER_ID, IDENTITY_ID, AUTH_EPOCH)).resolves.toBe(true);
    await pool.query("insert into enterprise_quarantine(id,user_id,reason,state) values ('fs38-q',$1,'approved isolation','quarantined')", [USER_ID]);
    await expectRejected();
    await pool.query("update enterprise_quarantine set state='invalid-persisted-state' where user_id=$1", [USER_ID]);
    await expectRejected();
    await pool.query("update enterprise_quarantine set state='released',released_at=now() where user_id=$1", [USER_ID]);
    await pool.query("delete from enterprise_directory_identity_watermarks where identity_id=$1", [IDENTITY_ID]);
    await expectRejected();
    await createEnterpriseDirectoryStore(pool).applyCompleteSnapshot({
      tenantKey: DIRECTORY_SCOPE.tenantKey, appId: DIRECTORY_SCOPE.appId, scopeHash: DIRECTORY_SCOPE_HASH,
      generation: GENERATION + 1, observedAt: NOW, memberOpenIds: ["ou-1"],
    });
    await expect(eligibility().authenticationEligibility(USER_ID, IDENTITY_ID, AUTH_EPOCH)).resolves.toBe(true);
    await pool.query("update enterprise_policy set activation_state='maintenance' where scope=$1", [POLICY_SCOPE]);
    await expectRejected();
  });

  it("rejects a missing identity watermark or expected-scope policy", async () => {
    await pool.query(`delete from "enterprise_directory_identity_watermarks"`);
    await expectRejected();

    await pool.query(
      `insert into "enterprise_directory_identity_watermarks"
         (id, identity_id, scope_hash, generation)
       values ('identity-watermark-restored', $1, $2, $3)`,
      [IDENTITY_ID, DIRECTORY_SCOPE_HASH, GENERATION],
    );
    await pool.query(`delete from "enterprise_policy" where scope = $1`, [POLICY_SCOPE]);
    await pool.query(
      `insert into "enterprise_policy"
         (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
       values ('policy-other', 'instance-other', 'megaui', 'test', 'test', $1, 'enterprise')`,
      [AUTH_EPOCH],
    );
    await expectRejected();
  });
});
