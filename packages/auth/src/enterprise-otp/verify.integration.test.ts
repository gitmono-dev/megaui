// megaui-only (FS-14): Better Auth session/cookie integration on real PG.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "@megaui/database";
import { createIsolatedPostgres, isDockerAvailable, type IsolatedPostgres } from "@megaui/database/test-support";
import type { EmailSender } from "@megaui/email";
import { createAuth } from "../create-auth";
import type { EnterpriseOtpVerifyPort } from "./types";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error("[@megaui/auth] verify.integration.test.ts: a docker daemon is required (the fixture owns its own Postgres).");
}

const SCOPE = "fs14-scope";
const USER = "fs14-user";
const IDENTITY = "fs14-identity";
const TENANT = "fs14-tenant";
const APP = "fs14-app";
const EPOCH = 7;
const FLOW = randomBytes(32).toString("base64url");
const FLOW_HASH = createHash("sha256").update(FLOW, "utf8").digest("hex");
const CHALLENGE = randomUUID();
const GRANT = randomUUID();
const CREATED = new Date();
const RECOVER = new Date(CREATED.getTime() + 90_000);

let isolated: IsolatedPostgres;
let database: DatabaseClient;
let auth: ReturnType<typeof createAuth>;

const email = {
  sendVerificationEmail: async () => ({ success: true as const }),
  sendResetPasswordEmail: async () => ({ success: true as const }),
  sendEmail: async () => ({ success: true as const }),
  sendProductNotificationEmail: async () => ({ success: true as const }),
} as unknown as EmailSender;

function grantPort(): EnterpriseOtpVerifyPort {
  return async (input) => input.flowHash === FLOW_HASH ? {
    kind: "accepted",
    grantId: GRANT,
    challengeId: CHALLENGE,
    localUserId: USER,
    identityId: IDENTITY,
    identityVersion: 1,
    authEpoch: EPOCH,
    flowHash: FLOW_HASH,
    recoverUntil: RECOVER,
  } : { kind: "invalid" };
}

function request(flow = FLOW): Request {
  return new Request("http://localhost:3000/api/auth/enterprise/verify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `__Host-megaui.enterprise-flow=${flow}`,
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({ challengeId: CHALLENGE, code: "A2B3C4D5" }),
  });
}

async function insertFixture(): Promise<void> {
  const pool = database.pool;
  await pool.query(`insert into "user" (id,name,email,email_verified,banned,ban_expires)
    values ($1,'FS14 User','fs14@example.test',false,false,null)`, [USER]);
  await pool.query(`insert into enterprise_policy
    (id,scope,owner_fingerprint,deployment_role,environment,auth_epoch,activation_state)
    values ('fs14-policy',$1,'megaui','test','test',$2,'enterprise')`, [SCOPE, EPOCH]);
  await pool.query(`insert into enterprise_identity
    (id,local_user_id,tenant_key,app_id,open_id,status,identity_version)
    values ($1,$2,$3,$4,'ou-fs14','active',1)`, [IDENTITY, USER, TENANT, APP]);
  await pool.query(`insert into enterprise_challenges
    (id,scope,deployment_role,local_user_id,identity_id,identity_version,flow_hash,generation,
     purpose,code_hmac,hmac_key_id,state,failed_attempts,created_at,expires_at,consumed_at,
     recover_until,secret_expires_at)
    values ($1,$2,'test',$3,$4,1,$5,1,'login',$6,'fs14-hmac','consumed',0,$7,$8,$9,$10,$10)`,
    [CHALLENGE, SCOPE, USER, IDENTITY, FLOW_HASH, "a".repeat(64), CREATED,
      new Date(CREATED.getTime() + 300_000), CREATED, RECOVER]);
  await pool.query(`insert into enterprise_login_grants
    (id,challenge_id,scope,deployment_role,local_user_id,identity_id,identity_version,
     auth_epoch,flow_hash,generation,purpose,created_at,recover_until)
    values ($1,$2,$3,'test',$4,$5,1,$6,$7,1,'login',$8,$9)`,
    [GRANT, CHALLENGE, SCOPE, USER, IDENTITY, EPOCH, FLOW_HASH, CREATED, RECOVER]);
}

describe("Better Auth enterprise OTP verify (FS-14)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    database = createDatabaseClient({ connectionString: isolated.databaseUrl, max: 10 });
  }, 120_000);

  beforeEach(async () => {
    await database.pool.query(`delete from session; delete from enterprise_login_grants; delete from enterprise_challenges;
      delete from enterprise_identity; delete from enterprise_policy; delete from "user"`);
    await insertFixture();
    auth = createAuth({
      appName: "megaui-test",
      secret: "test-secret-at-least-32-characters-long",
      baseURL: "http://localhost:3000",
      db: database.db,
      email,
      nodeEnv: "test",
      trustedOrigins: { appBaseUrl: "http://localhost:3000" },
      enterprisePairing: {
        pairingPort: async () => ({ kind: "unavailable" as const }),
        resolveTransport: () => ({ peerAddress: "127.0.0.1" }),
        verifyPort: grantPort(),
      },
    });
    await auth.$context;
  });

  afterAll(async () => {
    if (database) await database.close();
    if (isolated) await isolated.destroy();
  }, 120_000);

  it("uses overrideAll for an eight-hour server session and never returns the token", async () => {
    const response = await auth.handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const row = (await database.pool.query(`select token,expires_at,enterprise_grant_id,enterprise_identity_id,auth_epoch,auth_method
      from session where enterprise_grant_id=$1`, [GRANT])).rows[0];
    expect(row.enterprise_grant_id).toBe(GRANT);
    expect(row.enterprise_identity_id).toBe(IDENTITY);
    expect(row.auth_epoch).toBe(EPOCH);
    expect(row.auth_method).toBe("enterprise");
    expect(new Date(row.expires_at).getTime() - Date.now()).toBeGreaterThan(7 * 60 * 60 * 1000);
    expect(new Date(row.expires_at).getTime() - Date.now()).toBeLessThan(8 * 60 * 60 * 1000 + 5_000);
    expect(typeof row.token).toBe("string");
  });

  it("reads the unique-conflict winner and recovers the same session", async () => {
    const responses = await Promise.all([auth.handler(request()), auth.handler(request())]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200]);
    expect((await database.pool.query("select count(*)::int as count from session where enterprise_grant_id=$1", [GRANT])).rows[0]?.count).toBe(1);
  });

  it("recover rejects a different flow and keeps the private-message user unverified", async () => {
    const wrongFlow = randomBytes(32).toString("base64url");
    const response = await auth.handler(request(wrongFlow));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "INVALID_CREDENTIALS" });
    expect((await database.pool.query("select email_verified from \"user\" where id=$1", [USER])).rows[0]?.email_verified).toBe(false);
  });
});
