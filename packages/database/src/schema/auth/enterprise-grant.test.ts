// megaui-only (FS-32): one-time grant and legacy-session compatibility contract.
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "../../test-support/isolated-pg";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error(
    "[@megaui/database] enterprise-grant.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

const SCOPE = "fs32-scope";
const USER = "fs32-user";
const IDENTITY = "fs32-identity";
const CHALLENGE = randomUUID();
const GRANT = randomUUID();
const FLOW = "b".repeat(64);
const CREATED = new Date(Date.UTC(2026, 10, 12, 12, 0, 0));
const EXPIRES = new Date(CREATED.getTime() + 300_000);
const RECOVER = new Date(CREATED.getTime() + 90_000);

let isolated: IsolatedPostgres;
let pool: Pool;

async function insertFixture(): Promise<void> {
  await pool.query(
    `insert into "user" (id, name, email, email_verified, banned, ban_expires)
     values ($1, 'FS32 User', 'fs32@example.test', false, false, null)`,
    [USER],
  );
  await pool.query(
    `insert into enterprise_policy
       (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
     values ('fs32-policy', $1, 'megaui', 'test', 'test', 7, 'enterprise')`,
    [SCOPE],
  );
  await pool.query(
    `insert into enterprise_identity
       (id, local_user_id, tenant_key, app_id, open_id, identity_version)
     values ($1, $2, 'fs32-tenant', 'fs32-app', 'ou-fs32', 3)`,
    [IDENTITY, USER],
  );
  await pool.query(
    `insert into enterprise_challenges
       (id, scope, deployment_role, local_user_id, identity_id, identity_version,
        flow_hash, generation, purpose, pairing_id, code_hmac, hmac_key_id, state,
        failed_attempts, created_at, expires_at, consumed_at, recover_until, secret_expires_at)
     values ($1, $2, 'test', $3, $4, 3, $5, 1, 'login', null, $6, 'fs32-hmac-v1',
        'consumed', 0, $7, $8, $9, $10, $10)`,
    [
      CHALLENGE,
      SCOPE,
      USER,
      IDENTITY,
      FLOW,
      "c".repeat(64),
      CREATED,
      EXPIRES,
      new Date(CREATED.getTime() + 1_000),
      new Date(CREATED.getTime() + 91_000),
    ],
  );
}

async function insertGrant(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = (overrides.id as string | undefined) ?? randomUUID();
  await pool.query(
    `insert into enterprise_login_grants
       (id, challenge_id, scope, deployment_role, local_user_id, identity_id,
        identity_version, auth_epoch, flow_hash, generation, purpose, created_at, recover_until)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 'login', $10, $11)`,
    [
      id,
      overrides.challenge_id ?? CHALLENGE,
      overrides.scope ?? SCOPE,
      overrides.deployment_role ?? "test",
      overrides.local_user_id ?? USER,
      overrides.identity_id ?? IDENTITY,
      overrides.identity_version ?? 3,
      overrides.auth_epoch ?? 7,
      overrides.flow_hash ?? FLOW,
      overrides.created_at ?? CREATED,
      overrides.recover_until ?? RECOVER,
    ],
  );
  return id;
}

async function insertSession(overrides: Record<string, unknown> = {}): Promise<void> {
  await pool.query(
    `insert into session
       (id, expires_at, token, user_id, enterprise_grant_id, enterprise_identity_id, auth_epoch, auth_method)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      overrides.id ?? randomUUID(),
      overrides.expires_at ?? new Date(CREATED.getTime() + 8 * 60 * 60_000),
      overrides.token ?? `fs32-session-${randomUUID()}`,
      overrides.user_id ?? USER,
      overrides.enterprise_grant_id !== undefined ? overrides.enterprise_grant_id : GRANT,
      overrides.enterprise_identity_id !== undefined ? overrides.enterprise_identity_id : IDENTITY,
      overrides.auth_epoch !== undefined ? overrides.auth_epoch : 7,
      overrides.auth_method !== undefined ? overrides.auth_method : "enterprise",
    ],
  );
}

describe("enterprise grant and session metadata schema (FS-32)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
  }, 120_000);

  beforeEach(async () => {
    await pool.query("delete from session; delete from enterprise_login_grants; delete from enterprise_challenges; delete from enterprise_identity; delete from enterprise_policy; delete from \"user\"");
    await insertFixture();
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (isolated) await isolated.destroy();
  }, 120_000);

  it("allows at most one grant for each challenge", async () => {
    await insertGrant({ id: GRANT });
    await expect(insertGrant()).rejects.toMatchObject({ code: "23505" });
  });

  it("allows at most one session for each grant", async () => {
    await insertGrant({ id: GRANT });
    await insertSession({ id: "fs32-session-a" });
    await expect(insertSession({ id: "fs32-session-b", token: "fs32-session-b" })).rejects.toMatchObject({ code: "23505" });
  });

  it("requires a valid challenge, user and identity binding", async () => {
    await expect(insertGrant({ challenge_id: randomUUID() })).rejects.toMatchObject({ code: "23503" });
    await expect(insertGrant({ identity_id: "missing-identity" })).rejects.toMatchObject({ code: "23503" });
    await expect(insertGrant({ local_user_id: "missing-user" })).rejects.toMatchObject({ code: "23503" });
    await insertGrant({ id: GRANT });
    await expect(insertSession({ enterprise_identity_id: "missing-identity" })).rejects.toMatchObject({ code: "23503" });
  });

  it("retains a bounded ninety-second recovery timestamp", async () => {
    await insertGrant({ id: GRANT, recover_until: RECOVER });
    await expect(insertGrant({ recover_until: CREATED })).rejects.toThrow();
    await expect(insertGrant({ recover_until: new Date(CREATED.getTime() + 391_000) })).rejects.toThrow();
    expect((await pool.query("select recover_until from enterprise_login_grants where id=$1", [GRANT])).rows[0]?.recover_until).toEqual(RECOVER);
  });

  it("does not expose a session token column in the grant table", async () => {
    const columns = (await pool.query(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='enterprise_login_grants'`,
    )).rows.map(row => row.column_name);
    expect(columns).not.toContain("token");
    expect(columns).not.toContain("session_token");
  });

  it("keeps legacy sessions readable with nullable enterprise metadata", async () => {
    await pool.query(
      `insert into session (id, expires_at, token, user_id)
       values ('fs32-legacy-session', $1, 'fs32-legacy-token', $2)`,
      [new Date(CREATED.getTime() + 8 * 60 * 60_000), USER],
    );
    const row = (await pool.query(
      `select id, token, user_id, enterprise_grant_id, enterprise_identity_id, auth_epoch, auth_method
         from session where id='fs32-legacy-session'`,
    )).rows[0];
    expect(row).toMatchObject({
      id: "fs32-legacy-session",
      token: "fs32-legacy-token",
      user_id: USER,
      enterprise_grant_id: null,
      enterprise_identity_id: null,
      auth_epoch: null,
      auth_method: null,
    });
  });

  it("rejects partial server metadata instead of creating a legacy bypass", async () => {
    await insertGrant({ id: GRANT });
    await expect(insertSession({ enterprise_identity_id: null })).rejects.toMatchObject({ code: "23514" });
    await expect(insertSession({ enterprise_grant_id: null })).rejects.toMatchObject({ code: "23514" });
  });
});
