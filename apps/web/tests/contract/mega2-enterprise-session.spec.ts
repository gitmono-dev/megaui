import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "@megaui/auth";
import { createDatabaseClient, type DatabaseClient } from "@megaui/database";
import { createIsolatedPostgres, isDockerAvailable, type IsolatedPostgres } from "@megaui/database/test-support";
import {
  createMega2SessionResponseHandler,
  deriveMega2Actor,
  projectMega2Session,
  type Mega2RawSession,
} from "@/lib/mega2-session";
import { createWebActorResolver, type WebActor } from "@/lib/enterprise-session";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error("FS-45 mega2-enterprise-session.spec.ts requires Docker for its owned PostgreSQL fixture");
}

const email = {
  sendVerificationEmail: async () => ({ success: true as const }),
  sendResetPasswordEmail: async () => ({ success: true as const }),
  sendEmail: async () => ({ success: true as const }),
  sendProductNotificationEmail: async () => ({ success: true as const }),
} as never;

let isolated: IsolatedPostgres;
let database: DatabaseClient;
let auth: ReturnType<typeof createAuth>;
let qualified = true;
let enterpriseActor: WebActor;

function rawSession(headers: Headers): Promise<Mega2RawSession | null> {
  return auth.api.getSession({
    headers,
    query: { disableCookieCache: true, disableRefresh: true },
  }).then(result => result ? {
    session: { id: result.session.id, expiresAt: result.session.expiresAt },
    user: {
      id: result.user.id,
      name: result.user.name,
      email: result.user.email ?? null,
      image: result.user.image ?? null,
    },
  } : null);
}

async function sessionCookie(): Promise<{ cookie: string; userId: string }> {
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
  expect(session?.user.id).toBeTruthy();
  return { cookie, userId: session!.user.id };
}

beforeAll(async () => {
  isolated = await createIsolatedPostgres();
  await isolated.migrate();
  database = createDatabaseClient({ connectionString: isolated.databaseUrl });
}, 120_000);

beforeEach(async () => {
  await database.pool.query(`delete from session; delete from account; delete from "user"`);
  qualified = true;
  auth = createAuth({
    appName: "megaui-fs45",
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
    db: database.db,
    email,
    nodeEnv: "test",
    trustedOrigins: { appBaseUrl: "http://localhost:3000" },
  });
  enterpriseActor = {
    kind: "enterprise",
    userId: "pending",
    identityId: "fs45-identity",
    authEpoch: 3,
    backendUsername: "Frozen.Backend_User",
    email: "notify@example.test",
    sessionId: "pending-session",
  };
});

afterAll(async () => {
  await database?.close();
  await isolated?.destroy();
}, 120_000);

describe("FS-45 mega2 get-session compatibility projection", () => {
  it("returns a qualified stable actor projection without internal identity fields", async () => {
    const { cookie, userId } = await sessionCookie();
    const resolver = createWebActorResolver({
      mode: "enterprise",
      readSession: async headers => {
        const session = await rawSession(headers);
        return session ? { user: { id: session.user.id, email: session.user.email }, session: { id: session.session.id } } : null;
      },
      readEnterpriseAuthority: async snapshot => ({
        localUserId: snapshot.user.id,
        identityId: enterpriseActor.identityId!,
        tenantKey: "tenant",
        appId: "app",
        authEpoch: enterpriseActor.authEpoch!,
        authMethod: "enterprise",
        enterpriseGrantId: "fs45-grant",
        backendUsername: enterpriseActor.backendUsername!,
        notificationEmail: enterpriseActor.email,
      }),
      qualifyEnterprise: async () => qualified,
    });
    const handler = createMega2SessionResponseHandler({ readSession: rawSession, resolveActor: resolver });
    const response = await handler(new Request("http://localhost:3000/api/auth/get-session", { headers: { cookie } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as Record<string, unknown>;
    expect(body.user).toEqual({
      id: userId,
      name: "Frozen.Backend_User",
      email: "notify@example.test",
      image: null,
      banned: false,
    });
    expect(body.session).toHaveProperty("id");
    expect(JSON.stringify(body)).not.toContain("internal@example.test");
    expect(JSON.stringify(body)).not.toContain("fs45-grant");
    expect(JSON.stringify(body)).not.toContain("otp");
    enterpriseActor = { ...enterpriseActor, userId, sessionId: (body.session as { id: string }).id };
  });

  it("returns 200 null for failed qualification and stale cookies", async () => {
    const { cookie } = await sessionCookie();
    const resolver = createWebActorResolver({
      mode: "enterprise",
      readSession: async headers => {
        const session = await rawSession(headers);
        return session ? { user: { id: session.user.id }, session: { id: session.session.id } } : null;
      },
      readEnterpriseAuthority: async snapshot => ({
        localUserId: snapshot.user.id,
        identityId: "fs45-identity",
        tenantKey: "tenant",
        appId: "app",
        authEpoch: 3,
        authMethod: "enterprise",
        enterpriseGrantId: "fs45-grant",
        backendUsername: "Frozen.Backend_User",
      }),
      qualifyEnterprise: async () => false,
    });
    const handler = createMega2SessionResponseHandler({ readSession: rawSession, resolveActor: resolver });
    expect(await (await handler(new Request("http://localhost:3000/api/auth/get-session", { headers: { cookie } }))).json()).toBeNull();
    expect(await (await handler(new Request("http://localhost:3000/api/auth/get-session", { headers: { cookie: "session_token=stale" } }))).json()).toBeNull();
  });

  it("keeps REF-10 fallback actor derivation byte-stable for legacy users", () => {
    const session: Mega2RawSession = {
      session: { id: "legacy-session", expiresAt: new Date("2030-01-01T00:00:00Z") },
      user: { id: "legacy-user", name: "\u0085\t", email: "  ada  @example.test", image: null },
    };
    expect(deriveMega2Actor(session.user)).toBe("ada");
    expect(projectMega2Session(session, {
      kind: "legacy",
      userId: "legacy-user",
      sessionId: "legacy-session",
    })).toMatchObject({ user: { id: "legacy-user", name: "ada", email: "  ada  @example.test", banned: false } });
    expect(projectMega2Session(session, { kind: "legacy", userId: "other", sessionId: "legacy-session" })).toBeNull();
  });
});
