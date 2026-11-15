// megaui-only (FS-36): PostgreSQL OTP consumption, recovery and failure budget.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "@megaui/database";
import { createIsolatedPostgres, isDockerAvailable, type IsolatedPostgres } from "@megaui/database/test-support";
import { createEnterpriseOtpConsumer } from "./consume";
import { createEnterpriseOtpCrypto } from "./crypto";
import type { EnterpriseOtpBinding } from "./types";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error("[@megaui/auth] consume.integration.test.ts: a docker daemon is required (the fixture owns its own Postgres).");
}

const SCOPE = "fs36-scope";
const ROLE = "test" as const;
const TENANT = "fs36-tenant";
const APP = "fs36-app";
const USER = "fs36-user";
const IDENTITY = "fs36-identity";
const AUTH_EPOCH = 7;
const CREATED = new Date("2026-11-13T03:00:00.000Z");
const CODE = "A2B3C4D5";
const WRONG = "A2B3C4D6";

let isolated: IsolatedPostgres;
let database: DatabaseClient;
let pool: DatabaseClient["pool"];
let now = new Date(CREATED);
let challengeId: string;
let flowHash: string;
let generation: number;
let consumer: ReturnType<typeof createEnterpriseOtpConsumer>;

const crypto = createEnterpriseOtpCrypto({
  hmacKeyId: "fs36-hmac-v1",
  hmacKey: Buffer.alloc(32, 0x36),
  deliveryKeyId: "fs36-delivery-v1",
  deliveryKey: Buffer.alloc(32, 0x63),
});

function binding(id: string, flow: string, createdAt: Date, expiresAt: Date, generationValue: number): EnterpriseOtpBinding {
  return {
    scope: SCOPE,
    deploymentRole: ROLE,
    tenantKey: TENANT,
    appId: APP,
    challengeId: id,
    localUserId: USER,
    identityId: IDENTITY,
    identityVersion: 1,
    purpose: "login",
    flowHash: flow,
    generation: generationValue,
    expiresAtMs: expiresAt.getTime(),
  };
}

async function insertChallenge(options: {
  readonly id?: string;
  readonly flow?: string;
  readonly generation?: number;
  readonly state?: string;
  readonly createdAt?: Date;
  readonly failedAttempts?: number;
  readonly code?: string;
} = {}): Promise<string> {
  const id = options.id ?? randomUUID();
  const flow = options.flow ?? flowHash;
  const generationValue = options.generation ?? generation;
  const createdAt = options.createdAt ?? now;
  const expiresAt = new Date(createdAt.getTime() + 300_000);
  const state = options.state ?? "active";
  const digest = crypto.digest(options.code ?? CODE, binding(id, flow, createdAt, expiresAt, generationValue));
  await pool.query(
    `insert into enterprise_challenges
       (id,scope,deployment_role,local_user_id,identity_id,identity_version,flow_hash,
        generation,purpose,code_hmac,hmac_key_id,state,failed_attempts,created_at,
        expires_at,secret_expires_at)
     values ($1,$2,$3,$4,$5,1,$6,$7,'login',$8,$9,$10,$11,$12,$13,$13)`,
    [id, SCOPE, ROLE, USER, IDENTITY, flow, generationValue, digest.codeHmac, digest.hmacKeyId,
      state, options.failedAttempts ?? 0, createdAt, expiresAt],
  );
  return id;
}

async function insertBaseline(): Promise<void> {
  await pool.query(
    `insert into "user" (id,name,email,email_verified,banned,ban_expires)
     values ($1,'FS36 User','fs36@example.test',false,false,null)`, [USER],
  );
  await pool.query(
    `insert into enterprise_policy
       (id,scope,owner_fingerprint,deployment_role,environment,auth_epoch,activation_state)
     values ('fs36-policy',$1,'megaui',$2,$2,$3,'enterprise')`, [SCOPE, ROLE, AUTH_EPOCH],
  );
  await pool.query(
    `insert into enterprise_identity
       (id,local_user_id,tenant_key,app_id,open_id,status,identity_version)
     values ($1,$2,$3,$4,'ou-fs36','active',1)`, [IDENTITY, USER, TENANT, APP],
  );
}

function makeConsumer(qualify: (input: { identityVersion: number; authEpoch: number }) => Promise<boolean> = async () => true) {
  return createEnterpriseOtpConsumer({
    pool,
    scope: SCOPE,
    deploymentRole: ROLE,
    tenantKey: TENANT,
    appId: APP,
    crypto,
    now: () => new Date(now),
    qualify: async (input) => qualify({ identityVersion: input.identityVersion, authEpoch: input.authEpoch }),
  });
}

describe("enterprise OTP consume transaction (FS-36)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    database = createDatabaseClient({ connectionString: isolated.databaseUrl, max: 10 });
    pool = database.pool;
  }, 120_000);

  beforeEach(async () => {
    await pool.query(`delete from session; delete from enterprise_login_grants; delete from enterprise_dm_deliveries;
      delete from enterprise_challenges; delete from enterprise_pairings; delete from enterprise_login_budgets;
      delete from enterprise_identity; delete from enterprise_policy; delete from "user"`);
    now = new Date(CREATED);
    flowHash = "a".repeat(64);
    generation = 1;
    await insertBaseline();
    challengeId = await insertChallenge();
    consumer = makeConsumer();
  });

  afterAll(async () => {
    if (database) await database.close();
    if (isolated) await isolated.destroy();
  }, 120_000);

  it("creates one grant under concurrent correct validation and recovers the same grant", async () => {
    const results = await Promise.all([
      consumer.consume({ challengeId, flowHash, code: CODE }),
      consumer.consume({ challengeId, flowHash, code: CODE }),
    ]);
    expect(results.every((result) => result.kind === "accepted")).toBe(true);
    expect(new Set(results.map((result) => result.kind === "accepted" ? result.grantId : "")).size).toBe(1);
    expect((await pool.query("select count(*)::int as count from enterprise_login_grants")).rows[0]?.count).toBe(1);
  });

  it("serializes concurrent failures without losing attempts", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => consumer.consume({ challengeId, flowHash, code: WRONG })));
    expect(results).toEqual(Array.from({ length: 5 }, () => ({ kind: "invalid" })));
    expect((await pool.query("select failed_attempts from enterprise_challenges where id=$1", [challengeId])).rows[0]?.failed_attempts).toBe(5);
    expect((await pool.query("select sum(used)::int as used from enterprise_login_budgets where budget_kind='verify-failure'")).rows[0]?.used).toBe(5);
  });

  it("caps one challenge at five failures", async () => {
    for (let index = 0; index < 6; index++) {
      await expect(consumer.consume({ challengeId, flowHash, code: WRONG })).resolves.toEqual({ kind: "invalid" });
    }
    expect((await pool.query("select failed_attempts from enterprise_challenges where id=$1", [challengeId])).rows[0]?.failed_attempts).toBe(5);
    expect((await pool.query("select sum(used)::int as used from enterprise_login_budgets where budget_kind='verify-failure'")).rows[0]?.used).toBe(5);
  });

  it("preserves the failure budget when a flow receives a new challenge", async () => {
    for (let index = 0; index < 4; index++) await consumer.consume({ challengeId, flowHash, code: WRONG });
    await pool.query("update enterprise_challenges set state='superseded' where id=$1", [challengeId]);
    generation = 2;
    const replacement = await insertChallenge({ generation });
    await expect(consumer.consume({ challengeId: replacement, flowHash, code: WRONG })).resolves.toEqual({ kind: "invalid" });
    await expect(consumer.consume({ challengeId: replacement, flowHash, code: CODE })).resolves.toEqual({ kind: "invalid" });
    expect((await pool.query("select failed_attempts from enterprise_challenges where id=$1", [replacement])).rows[0]?.failed_attempts).toBe(1);
    expect((await pool.query("select count(*)::int as count from enterprise_login_grants")).rows[0]?.count).toBe(0);
  });

  it("binds the grant to the original flow", async () => {
    const accepted = await consumer.consume({ challengeId, flowHash, code: CODE });
    expect(accepted.kind).toBe("accepted");
    await expect(consumer.consume({ challengeId, flowHash: "b".repeat(64), code: CODE })).resolves.toEqual({ kind: "invalid" });
    expect((await pool.query("select state from enterprise_challenges where id=$1", [challengeId])).rows[0]?.state).toBe("consumed");
  });

  it("does not consume a challenge for a suspended identity", async () => {
    await pool.query("update enterprise_identity set status='suspended' where id=$1", [IDENTITY]);
    await expect(consumer.consume({ challengeId, flowHash, code: CODE })).resolves.toEqual({ kind: "invalid" });
    expect((await pool.query("select state from enterprise_challenges where id=$1", [challengeId])).rows[0]?.state).toBe("active");
    expect((await pool.query("select count(*)::int as count from enterprise_login_grants")).rows[0]?.count).toBe(0);
  });

  it("never reverts a consumed challenge to active", async () => {
    await expect(consumer.consume({ challengeId, flowHash, code: CODE })).resolves.toMatchObject({ kind: "accepted" });
    now = new Date(CREATED.getTime() + 91_000);
    await expect(consumer.consume({ challengeId, flowHash, code: CODE })).resolves.toEqual({ kind: "invalid" });
    expect((await pool.query("select state,consumed_at,recover_until from enterprise_challenges where id=$1", [challengeId])).rows[0]?.state).toBe("consumed");
  });

  it("clears HMAC only after the recovery window with bounded cleanup", async () => {
    await expect(consumer.consume({ challengeId, flowHash, code: CODE })).resolves.toMatchObject({ kind: "accepted" });
    now = new Date(CREATED.getTime() + 91_000);
    await expect(consumer.cleanupExpiredSecrets({ now, limit: 100 })).resolves.toBe(1);
    const row = (await pool.query("select state,code_hmac,hmac_key_id,secret_cleared_at from enterprise_challenges where id=$1", [challengeId])).rows[0];
    expect(row).toMatchObject({ state: "consumed", code_hmac: null, hmac_key_id: null });
    expect(row.secret_cleared_at).toEqual(now);
  });
});
