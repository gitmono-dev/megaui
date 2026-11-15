import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth, type EnterpriseSessionAuthority } from "@megaui/auth";
import { createDatabaseClient, type DatabaseClient } from "@megaui/database";
import { createIsolatedPostgres, isDockerAvailable, type IsolatedPostgres } from "@megaui/database/test-support";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error("FS-39 enterprise-session-dto.spec.ts requires Docker for its owned PostgreSQL fixture");
}

const USER = "fs39-user";
const IDENTITY = "fs39-identity";
const SCOPE = "fs39-scope";
const GRANT = randomUUID();
const CHALLENGE = randomUUID();
const MODE = { value: "legacy" as "legacy" | "enterprise" | "maintenance" | "reject" };
let fixtureUserId = USER;

let isolated: IsolatedPostgres;
let database: DatabaseClient;
let auth: ReturnType<typeof createAuth>;
let qualifyEnterprise: ReturnType<typeof vi.fn<(authority: EnterpriseSessionAuthority) => Promise<boolean>>>;

const email = {
  sendVerificationEmail: async () => ({ success: true as const }),
  sendResetPasswordEmail: async () => ({ success: true as const }),
  sendEmail: async () => ({ success: true as const }),
  sendProductNotificationEmail: async () => ({ success: true as const }),
} as never;

function createFixtureAuth() {
  const resolveMode = async () => MODE.value;
  qualifyEnterprise = vi.fn(async (_authority: EnterpriseSessionAuthority) => true);
  return createAuth({
    appName: "megaui-fs39",
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
    db: database.db,
    email,
    nodeEnv: "test",
    trustedOrigins: { appBaseUrl: "http://localhost:3000" },
    enterpriseOperationPolicy: { httpBasePath: "/api/auth", resolveMode },
    enterpriseSession: {
      resolveMode,
      qualifyEnterprise,
      readEnterpriseAuthority: async () => ({
        localUserId: fixtureUserId,
        identityId: IDENTITY,
        authEpoch: 1,
        authMethod: "enterprise",
        enterpriseGrantId: GRANT,
      }),
      readEnterpriseProfile: async () => ({
        localUserId: fixtureUserId,
        displayName: "Directory Display",
        notificationEmail: "notify@example.test",
      }),
    },
  });
}

async function sessionCookie(): Promise<string> {
  const response = await auth.handler(new Request("http://localhost:3000/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ email: "internal@example.test", password: "password-at-least-12", name: "Internal Name" }),
  }));
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toMatch(/session_token=/);
  const cookie = setCookie!.split(";", 1)[0]!;
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  fixtureUserId = session!.user.id;
  return cookie;
}

beforeAll(async () => {
  isolated = await createIsolatedPostgres();
  await isolated.migrate();
  database = createDatabaseClient({ connectionString: isolated.databaseUrl });
}, 120_000);

beforeEach(async () => {
  MODE.value = "legacy";
  fixtureUserId = USER;
  await database.pool.query(`delete from session; delete from enterprise_login_grants; delete from enterprise_challenges;
    delete from enterprise_profile; delete from enterprise_identity; delete from enterprise_policy; delete from "user"`);
  auth = createFixtureAuth();
  await auth.$context;
});
afterAll(async () => {
  await database?.close();
  await isolated?.destroy();
}, 120_000);

describe("FS-39 public session and profile DTO", () => {
  it("projects legacy sessions without framework internals and exposes the same direct endpoint", async () => {
    const cookie = await sessionCookie();
    const response = await auth.handler(new Request("http://localhost:3000/api/auth/enterprise/session", {
      headers: { cookie },
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.user).toMatchObject({ id: fixtureUserId, name: "Internal Name", email: "internal@example.test", image: null });
    expect(body.session).toHaveProperty("id");
    expect(body).not.toHaveProperty("token");
    expect(JSON.stringify(body)).not.toContain("enterpriseGrantId");
    expect(JSON.stringify(body)).not.toContain("otp");

    const direct = await auth.api.getEnterpriseSession({ headers: new Headers({ cookie }) });
    expect(direct?.user).toMatchObject({ id: fixtureUserId, name: "Internal Name", email: "internal@example.test" });
  });

  it("uses display_name/notification_email only after the enterprise qualification port succeeds", async () => {
    const cookie = await sessionCookie();
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.session.id).toBeTruthy();
    await database.pool.query(`insert into enterprise_policy
      (id,scope,owner_fingerprint,deployment_role,environment,auth_epoch,activation_state)
      values ('fs39-policy',$1,'owner','test','test',1,'enterprise')`, [SCOPE]);
    await database.pool.query(`insert into enterprise_identity (id,local_user_id,tenant_key,app_id,open_id,status,identity_version)
      values ($1,$2,'tenant','app','open-id','active',1)`, [IDENTITY, fixtureUserId]);
    await database.pool.query(`insert into enterprise_profile (user_id,tenant_key,login_name,backend_username,display_name,notification_email)
      values ($1,'tenant','alias','backend-internal','Directory Display','notify@example.test')`, [fixtureUserId]);
    await database.pool.query(`insert into enterprise_challenges
        (id,scope,deployment_role,local_user_id,identity_id,identity_version,flow_hash,generation,purpose,
         code_hmac,hmac_key_id,state,created_at,expires_at,secret_expires_at)
      values ($4,$1,'test',$3,$2,1,repeat('a',64),1,'login',repeat('b',64),'fs39-key','active',now(),now()+interval '300 seconds',now()+interval '300 seconds')`,
      [SCOPE, IDENTITY, fixtureUserId, CHALLENGE]);
    await database.pool.query(`insert into enterprise_login_grants
        (id,challenge_id,scope,deployment_role,local_user_id,identity_id,identity_version,auth_epoch,flow_hash,generation,purpose,created_at,recover_until)
      values ($5,$4,$1,'test',$3,$2,1,1,repeat('c',64),1,'login',now(),now()+interval '90 seconds')`,
      [SCOPE, IDENTITY, fixtureUserId, CHALLENGE, GRANT]);
    await database.pool.query(`update session set enterprise_grant_id=$1, enterprise_identity_id=$2, auth_epoch=1, auth_method='enterprise' where id=$3`, [GRANT, IDENTITY, session!.session.id]);
    MODE.value = "enterprise";

    const response = await auth.handler(new Request("http://localhost:3000/api/auth/enterprise/session", { headers: { cookie } }));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.user).toEqual({ id: fixtureUserId, name: "Directory Display", email: "notify@example.test", image: null });
    expect((body.user as Record<string, unknown>).name).not.toBe("backend-internal");
    expect(JSON.stringify(body)).not.toContain("internal@example.test");
    expect(JSON.stringify(body)).not.toContain(GRANT);
    expect(qualifyEnterprise).toHaveBeenCalledWith(expect.objectContaining({ localUserId: fixtureUserId, identityId: IDENTITY, authEpoch: 1 }));

    qualifyEnterprise.mockResolvedValue(false);
    expect(await auth.api.getEnterpriseSession({ headers: new Headers({ cookie }) })).toBeNull();
  });
});
