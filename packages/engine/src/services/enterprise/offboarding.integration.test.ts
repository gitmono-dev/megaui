// FS-18: one isolated PostgreSQL transaction for identity offboarding.
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createEnterpriseOffboardingStore } from "@megaui/database";
import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "@megaui/database/test-support";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error("[@megaui/engine] offboarding.integration.test.ts: a docker daemon is required");
}

const NOW = new Date("2026-11-12T21:00:00.000Z");
const USER = "fs18-user";
const IDENTITY = "fs18-identity";
const SCOPE = "fs18-scope";
const CHALLENGE = "00000000-0000-4000-8000-000000000018";
const PAIRING = "00000000-0000-4000-8000-000000000019";
const GRANT = "00000000-0000-4000-8000-000000000020";
const FLOW = "a".repeat(64);
const CHALLENGE_CREATED = NOW;
const CHALLENGE_EXPIRES = new Date(NOW.getTime() + 300_000);
const PAIRING_EXPIRES = new Date(NOW.getTime() + 120_000);
const RECOVER_UNTIL = new Date(NOW.getTime() + 390_000);

let isolated: IsolatedPostgres;
let pool: Pool;

async function seed(): Promise<void> {
  await pool.query(
    `insert into "user" (id, name, email, email_verified, banned, ban_expires)
     values ($1, 'FS18 User', 'fs18@example.test', false, false, null)`,
    [USER],
  );
  await pool.query(
    `insert into enterprise_policy
       (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
     values ('fs18-policy', $1, 'megaui', 'test', 'test', 7, 'enterprise')`,
    [SCOPE],
  );
  await pool.query(
    `insert into enterprise_identity
       (id, local_user_id, tenant_key, app_id, open_id, status, identity_version)
     values ($1, $2, 'tenant-fs18', 'app-fs18', 'ou-fs18', 'active', 3)`,
    [IDENTITY, USER],
  );
  await pool.query(
    `insert into mega_docs (id, title, author_id, status)
     values ('fs18-doc', 'Retained content', $1, 'published')`,
    [USER],
  );
  await pool.query(
    `insert into enterprise_pairings
       (id, scope, deployment_role, tenant_key, app_id, flow_hash, generation,
        token_hash, intended_identity_id, state, created_at, expires_at, retain_until)
     values ($1, $2, 'test', 'tenant-fs18', 'app-fs18', $3, 1,
        $4, $5, 'pending', $6, $7, $7)`,
    [PAIRING, SCOPE, FLOW, "b".repeat(64), IDENTITY, NOW, PAIRING_EXPIRES],
  );
  await pool.query(
    `insert into enterprise_challenges
       (id, scope, deployment_role, local_user_id, identity_id, identity_version,
        flow_hash, generation, purpose, code_hmac, hmac_key_id, state,
        failed_attempts, created_at, expires_at, secret_expires_at)
     values ($1, $2, 'test', $3, $4, 3, $5, 1, 'login', $6, 'fs18-hmac', 'active', 0, $7, $8, $8)`,
    [CHALLENGE, SCOPE, USER, IDENTITY, FLOW, "c".repeat(64), CHALLENGE_CREATED, CHALLENGE_EXPIRES],
  );
  await pool.query(
    `insert into enterprise_login_grants
       (id, challenge_id, scope, deployment_role, local_user_id, identity_id,
        identity_version, auth_epoch, flow_hash, generation, purpose, created_at, recover_until)
     values ($1, $2, $3, 'test', $4, $5, 3, 7, $6, 1, 'login', $7, $8)`,
    [GRANT, CHALLENGE, SCOPE, USER, IDENTITY, FLOW, NOW, RECOVER_UNTIL],
  );
  await pool.query(
    `insert into "session"
       (id, expires_at, token, user_id, enterprise_grant_id, enterprise_identity_id, auth_epoch, auth_method)
     values ('fs18-enterprise-session', $1, 'fs18-enterprise-token', $2, $3, $4, 7, 'enterprise'),
            ('fs18-legacy-session', $1, 'fs18-legacy-token', $2, null, null, null, null)`,
    [new Date(NOW.getTime() + 86_400_000), USER, GRANT, IDENTITY],
  );
}

describe("enterprise offboarding transaction (FS-18)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
  }, 120_000);

  beforeEach(async () => {
    await pool.query(
      `delete from enterprise_revocations;
       delete from enterprise_dm_deliveries;
       delete from enterprise_login_grants;
       delete from enterprise_challenges;
       delete from enterprise_pairings;
       delete from session;
       delete from mega_docs;
       delete from enterprise_identity;
       delete from enterprise_policy;
       delete from "user"`,
    );
    await seed();
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    try { await pool?.end(); } catch (error) { failures.push(error); }
    try { await isolated?.destroy(); } catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(failures, "FS-18 fixture cleanup failed");
  }, 120_000);

  it("atomically resigns identity, advances epoch, invalidates auth, and preserves content ownership", async () => {
    const store = createEnterpriseOffboardingStore(pool);
    const result = await store.offboard({
      localUserId: USER,
      identityId: IDENTITY,
      scope: SCOPE,
      reason: "directory-resigned",
      expectedIdentityVersion: 3,
      now: NOW,
    });
    expect(result).toMatchObject({
      localUserId: USER,
      identityId: IDENTITY,
      identityVersion: 4,
      authEpoch: 8,
      sessionsRevoked: 2,
      challengesRevoked: 1,
      grantsRevoked: 1,
      pairingFlowsExpired: 1,
      changed: true,
    });
    expect((await pool.query("select status, identity_version from enterprise_identity where id=$1", [IDENTITY])).rows)
      .toEqual([{ status: "resigned", identity_version: 4 }]);
    expect((await pool.query("select auth_epoch from enterprise_policy where scope=$1", [SCOPE])).rows)
      .toEqual([{ auth_epoch: 8 }]);
    expect((await pool.query("select count(*)::int as count from session where user_id=$1", [USER])).rows[0]?.count).toBe(0);
    expect((await pool.query("select state, code_hmac, hmac_key_id, secret_cleared_at from enterprise_challenges where id=$1", [CHALLENGE])).rows[0])
      .toMatchObject({ state: "revoked", code_hmac: null, hmac_key_id: null });
    expect((await pool.query("select count(*)::int as count from enterprise_login_grants where local_user_id=$1", [USER])).rows[0]?.count).toBe(0);
    expect((await pool.query("select state from enterprise_pairings where id=$1", [PAIRING])).rows[0]?.state).toBe("expired");
    expect((await pool.query("select author_id from mega_docs where id='fs18-doc'")).rows[0]?.author_id).toBe(USER);
    expect((await pool.query("select user_id,auth_epoch,state,reason from enterprise_revocations where user_id=$1", [USER])).rows)
      .toEqual([{ user_id: USER, auth_epoch: 8, state: "pending", reason: "directory-resigned" }]);
  });

  it("is idempotent and rejects stale identity versions without partial writes", async () => {
    const store = createEnterpriseOffboardingStore(pool);
    const first = await store.offboard({ localUserId: USER, identityId: IDENTITY, scope: SCOPE, reason: "quarantine", now: NOW });
    const replay = await store.offboard({ localUserId: USER, identityId: IDENTITY, scope: SCOPE, reason: "quarantine-again", now: NOW });
    expect(replay).toMatchObject({ changed: false, authEpoch: first.authEpoch, identityVersion: first.identityVersion, revocationId: first.revocationId });
    expect((await pool.query("select count(*)::int as count from enterprise_revocations where user_id=$1", [USER])).rows[0]?.count).toBe(1);
    await expect(store.offboard({
      localUserId: USER,
      identityId: IDENTITY,
      scope: SCOPE,
      reason: "stale",
      expectedIdentityVersion: 99,
      now: NOW,
    })).rejects.toThrow("ENTERPRISE_IDENTITY_CONFLICT");
    expect((await pool.query("select auth_epoch from enterprise_policy where scope=$1", [SCOPE])).rows[0]?.auth_epoch).toBe(first.authEpoch);
  });

  it("rolls back identity, epoch, session and outbox together on a downstream failure", async () => {
    await pool.query(
      `create function fs18_fail() returns trigger language plpgsql as $$ begin raise exception 'fs18 injected failure'; end $$;
       create trigger fs18_fail before update on enterprise_challenges for each row execute function fs18_fail()`,
    );
    try {
      const store = createEnterpriseOffboardingStore(pool);
      await expect(store.offboard({ localUserId: USER, identityId: IDENTITY, scope: SCOPE, reason: "rollback", now: NOW }))
        .rejects.toThrow("fs18 injected failure");
      expect((await pool.query("select status, identity_version from enterprise_identity where id=$1", [IDENTITY])).rows)
        .toEqual([{ status: "active", identity_version: 3 }]);
      expect((await pool.query("select auth_epoch from enterprise_policy where scope=$1", [SCOPE])).rows[0]?.auth_epoch).toBe(7);
      expect((await pool.query("select count(*)::int as count from session where user_id=$1", [USER])).rows[0]?.count).toBe(2);
      expect((await pool.query("select count(*)::int as count from enterprise_revocations where user_id=$1", [USER])).rows[0]?.count).toBe(0);
    } finally {
      await pool.query("drop trigger fs18_fail on enterprise_challenges; drop function fs18_fail()");
    }
  });
});
