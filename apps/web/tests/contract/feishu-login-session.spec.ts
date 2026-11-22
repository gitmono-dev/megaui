// megaui-only (FSL-126): the Web session entry in Feishu mode (AUTH_MODE=enterprise,
// AUTH_PROVIDER=feishu), driven through the real middleware, `resolveWebActor` and the
// `/api/auth/[...all]` route against a one-shot PostgreSQL. FSL-132 adds the legacy entry
// (AUTH_MODE=legacy): an email and password sign-in through the real route, `get-session`,
// `resolveWebActor` returning a legacy actor, and sign-out ending the session.
//
// Sessions and `feishu_login_sessions` rows are written directly: the Feishu session the
// way verify issues it (`createSession(userId, false, { expiresAt: +8h }, true)` followed by
// `recordFeishuLoginSession`), the password session through Better Auth's own e-mail
// sign-up. The Web wiring of the Feishu-mode Auth instance is FSL-150, so `getAuth()` is
// replaced by a real `createAuth` instance over the same database; the shared Pool that
// reads the marker rows is the real `@megaui/database` singleton on DATABASE_URL.
import { createHmac, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth } from "@megaui/auth";
import {
  closeDatabaseClient,
  createDatabaseClient,
  recordFeishuLoginSession,
  type DatabaseClient,
} from "@megaui/database";
import { createIsolatedPostgres, isDockerAvailable, type IsolatedPostgres } from "@megaui/database/test-support";

const authHolder = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@/lib/auth", () => ({
  getAuth: () => {
    if (!authHolder.current) throw new Error("test Auth instance is not ready");
    return authHolder.current;
  },
}));

import { GET as authRouteGet, POST as authRoutePost } from "@/app/api/auth/[...all]/route";
import { resolveWebActor } from "@/lib/enterprise-session";
import { authMiddleware } from "@/middlewares/auth";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error("[@megaui/web] feishu-login-session.spec.ts: a docker daemon is required (the fixture owns its own Postgres).");
}

const ORIGIN = "http://127.0.0.1:3000";
const SECRET = "fsl126-contract-secret-at-least-32-characters";
const SESSION_COOKIE = "better-auth.session_token";
const HOUR = 60 * 60 * 1000;
const EMAIL = "member@example.test";
const PASSWORD = "fsl126-password-long-enough";
const APP_ID = "cli_fsl126_app";
const MANAGED = ["AUTH_MODE", "AUTH_PROVIDER", "DATABASE_URL", "ENTERPRISE_PROCESS_ROLE", "ENTERPRISE_OWNER_FINGERPRINT",
  "ENTERPRISE_DB_INSTANCE_ID", "ENTERPRISE_DEPLOYMENT_ROLE", "ENTERPRISE_APPROVED_TARGETS"] as const;
const saved = new Map(MANAGED.map(key => [key, process.env[key]]));

let isolated: IsolatedPostgres | undefined;
let database: DatabaseClient | undefined;

function buildAuth(db: DatabaseClient) {
  return createAuth({
    appName: "megaui-fsl126",
    secret: SECRET,
    baseURL: ORIGIN,
    db: db.db,
    email: { sendVerificationEmail: vi.fn(), sendResetPasswordEmail: vi.fn() } as never,
    nodeEnv: "test",
    trustedOrigins: { appBaseUrl: ORIGIN },
  });
}
type Auth = ReturnType<typeof buildAuth>;
let auth: Auth;

/** Better Auth's signed cookie: `<token>.<base64 HMAC-SHA256(secret, token)>`, URI-encoded. */
function signedSessionCookie(token: string): string {
  const signature = createHmac("sha256", SECRET).update(token).digest("base64");
  return `${SESSION_COOKIE}=${encodeURIComponent(`${token}.${signature}`)}`;
}

interface Member {
  readonly userId: string;
  readonly passwordCookie: string;
  readonly passwordSessionId: string;
}

/** A bound member who first signed in with a password (as before the switch to Feishu mode). */
async function boundMember(): Promise<Member> {
  const response = await auth.api.signUpEmail({
    body: { email: EMAIL, password: PASSWORD, name: "Member" },
    asResponse: true,
  });
  const line = response.headers.getSetCookie().find(entry => entry.startsWith(`${SESSION_COOKIE}=`));
  if (!line) throw new Error("password sign-up issued no session cookie");
  const passwordCookie = line.split(";", 1)[0]!;
  const session = await auth.api.getSession({ headers: new Headers({ cookie: passwordCookie }) });
  if (!session) throw new Error("password session is not readable");
  await database!.pool.query(
    "insert into feishu_identities (app_id, open_id_hmac, user_id) values ($1, $2, $3)",
    [APP_ID, randomBytes(32).toString("hex"), session.user.id],
  );
  return { userId: session.user.id, passwordCookie, passwordSessionId: session.session.id };
}

/** A Feishu session exactly as verify issues it. */
async function feishuSession(userId: string): Promise<{ cookie: string; sessionId: string }> {
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(userId, false, { expiresAt: new Date(Date.now() + 8 * HOUR) }, true);
  await recordFeishuLoginSession(database!.pool, session.id);
  return { cookie: signedSessionCookie(session.token), sessionId: session.id };
}

function pageRequest(cookie?: string, path = "/en/workspace"): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
}

function redirectTarget(response: Response | undefined): string | undefined {
  const value = response?.headers.get("location");
  if (!value) return undefined;
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
}

/** `GET /api/auth/get-session` through the middleware and then the real route. */
async function getSession(cookie?: string): Promise<{ status: number; body: unknown }> {
  const request = new NextRequest(`${ORIGIN}/api/auth/get-session`, { headers: cookie ? { cookie, origin: ORIGIN } : { origin: ORIGIN } });
  const blocked = await authMiddleware(request);
  if (blocked) return { status: blocked.status, body: await blocked.json() };
  const response = await authRouteGet(request);
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  isolated = await createIsolatedPostgres();
  await isolated.migrate();
  database = createDatabaseClient({ connectionString: isolated.databaseUrl, max: 4, onPoolError: () => {} });
  for (const key of MANAGED) delete process.env[key];
  process.env.DATABASE_URL = isolated.databaseUrl;
  auth = buildAuth(database);
  authHolder.current = auth;
  await auth.$context;
}, 180_000);

beforeEach(async () => {
  await database!.pool.query(`delete from feishu_login_sessions; delete from session; delete from feishu_identities;
    delete from account; delete from "user"`);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  const errors: unknown[] = [];
  for (const end of [() => closeDatabaseClient(), () => database?.close(), () => isolated?.destroy()]) {
    try { await end(); } catch (error) { errors.push(error); }
  }
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (errors.length) throw new AggregateError(errors, "FSL-126 cleanup failed");
}, 120_000);

describe("FSL-126 Web session entry in Feishu mode", () => {
  beforeEach(() => {
    process.env.AUTH_MODE = "enterprise";
    process.env.AUTH_PROVIDER = "feishu";
  });

  it("AC1: a page request with a valid Feishu session gets that user", async () => {
    const member = await boundMember();
    const feishu = await feishuSession(member.userId);
    expect(await authMiddleware(pageRequest(feishu.cookie))).toBeUndefined();
    await expect(resolveWebActor(new Headers({ cookie: feishu.cookie }))).resolves.toEqual({
      kind: "feishu",
      userId: member.userId,
      email: EMAIL,
      sessionId: feishu.sessionId,
    });
    // Signed-in Feishu users are sent from the sign-in page to the workspace.
    expect(redirectTarget(await authMiddleware(pageRequest(feishu.cookie, "/en/signin")))).toBe("/en/workspace");
  });

  it("AC2: a non-Feishu session of the same bound user is signed out", async () => {
    const member = await boundMember();
    const feishu = await feishuSession(member.userId);
    // Better Auth itself still accepts the password session: only the Web entry refuses it.
    expect((await auth.api.getSession({ headers: new Headers({ cookie: member.passwordCookie }) }))?.session.id)
      .toBe(member.passwordSessionId);
    await expect(resolveWebActor(new Headers({ cookie: member.passwordCookie }))).resolves.toBeNull();
    const page = await authMiddleware(pageRequest(member.passwordCookie));
    expect(page?.status).toBe(302);
    expect(redirectTarget(page)).toBe("/en/signin?callbackUrl=%2Fen%2Fworkspace");
    expect(await authMiddleware(pageRequest(member.passwordCookie, "/en/signin"))).toBeUndefined();
    // The same user's Feishu session, side by side, is accepted.
    await expect(resolveWebActor(new Headers({ cookie: feishu.cookie }))).resolves.toMatchObject({ userId: member.userId });
    // A marker row of another session does not mark this one.
    expect((await database!.pool.query("select count(*)::int as n from feishu_login_sessions")).rows[0]).toEqual({ n: 1 });
  });

  it("AC3: a Feishu session issued more than eight hours ago is signed out even while in continuous use", async () => {
    const member = await boundMember();
    const start = Date.now();
    const feishu = await feishuSession(member.userId);
    // Two clocks move together: the Web process Date (Better Auth's expiry and refresh) is faked,
    // and the database clock, which the age is measured on, is advanced by moving the marker
    // row's created_at back by the same amount.
    let advancedMs = 0;
    const advanceTo = async (elapsedMs: number) => {
      vi.setSystemTime(start + elapsedMs);
      await database!.pool.query(
        "update feishu_login_sessions set created_at = created_at - make_interval(secs => $2::float8 / 1000) where session_id = $1",
        [feishu.sessionId, elapsedMs - advancedMs],
      );
      advancedMs = elapsedMs;
    };
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    for (let hour = 0; hour < 8; hour += 1) {
      await advanceTo(hour * HOUR + 59 * 60 * 1000);
      // Continuous use, including Better Auth's own refresh, which moves the session expiry on.
      const refreshed = await auth.api.getSession({ headers: new Headers({ cookie: feishu.cookie }) });
      expect(refreshed?.session.id).toBe(feishu.sessionId);
      expect(await authMiddleware(pageRequest(feishu.cookie))).toBeUndefined();
      expect((await getSession(feishu.cookie)).body).toMatchObject({ session: { id: feishu.sessionId } });
    }
    await advanceTo(8 * HOUR + 60 * 1000);
    const stillValid = await auth.api.getSession({ headers: new Headers({ cookie: feishu.cookie }) });
    // Better Auth would keep the session: its expiry was extended past the eight hours by use.
    expect(stillValid?.session.id).toBe(feishu.sessionId);
    expect(new Date(stillValid!.session.expiresAt).getTime()).toBeGreaterThan(start + 8 * HOUR + 60 * 1000);
    await expect(resolveWebActor(new Headers({ cookie: feishu.cookie }))).resolves.toBeNull();
    const page = await authMiddleware(pageRequest(feishu.cookie));
    expect(redirectTarget(page)).toBe("/en/signin?callbackUrl=%2Fen%2Fworkspace");
    expect(await getSession(feishu.cookie)).toEqual({ status: 200, body: null });
  });

  it("AC3: the age is measured on the database clock, not on the Web process clock", async () => {
    const member = await boundMember();
    const feishu = await feishuSession(member.userId);
    const setAge = (interval: string) => database!.pool.query(
      `update feishu_login_sessions set created_at = clock_timestamp() - $2::interval where session_id = $1`,
      [feishu.sessionId, interval],
    );
    // The Web process clock is untouched here; only the marker's age on the database clock changes.
    await setAge("7 hours 59 minutes");
    await expect(resolveWebActor(new Headers({ cookie: feishu.cookie }))).resolves.toMatchObject({ kind: "feishu" });
    await setAge("8 hours 1 minute");
    await expect(resolveWebActor(new Headers({ cookie: feishu.cookie }))).resolves.toBeNull();
    // A row dated in the database clock's future gains no extra time.
    await setAge("-1 hour");
    await expect(resolveWebActor(new Headers({ cookie: feishu.cookie }))).resolves.toBeNull();
    expect(await getSession(feishu.cookie)).toEqual({ status: 200, body: null });
  });

  it("AC4: a protected page without a session redirects to /[lang]/signin", async () => {
    for (const [path, target] of [
      ["/en/workspace", "/en/signin?callbackUrl=%2Fen%2Fworkspace"],
      ["/zh-CN/workspace/docs", "/zh-CN/signin?callbackUrl=%2Fzh-CN%2Fworkspace%2Fdocs"],
    ] as const) {
      const response = await authMiddleware(pageRequest(undefined, path));
      expect(response?.status).toBe(302);
      expect(redirectTarget(response)).toBe(target);
    }
    const stale = await authMiddleware(pageRequest(signedSessionCookie("not-a-session")));
    expect(redirectTarget(stale)).toBe("/en/signin?callbackUrl=%2Fen%2Fworkspace");
  });

  it("AC5: get-session returns the Feishu session", async () => {
    const member = await boundMember();
    const feishu = await feishuSession(member.userId);
    const response = await getSession(feishu.cookie);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      session: { id: feishu.sessionId },
      user: { id: member.userId, email: EMAIL },
    });
  });

  it("AC6: get-session returns null for a non-Feishu session", async () => {
    const member = await boundMember();
    await feishuSession(member.userId);
    expect(await getSession(member.passwordCookie)).toEqual({ status: 200, body: null });
    expect(await getSession()).toEqual({ status: 200, body: null });
    // Deleting the marker row turns a Feishu session into a non-Feishu one.
    const other = await feishuSession(member.userId);
    await database!.pool.query("delete from feishu_login_sessions where session_id = $1", [other.sessionId]);
    expect(await getSession(other.cookie)).toEqual({ status: 200, body: null });
  });
});

/** `POST /api/auth/<path>` through the middleware and then the real route. */
async function authPost(path: string, body: unknown, cookie?: string): Promise<Response> {
  const request = new NextRequest(`${ORIGIN}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const blocked = await authMiddleware(request);
  if (blocked) return blocked;
  return authRoutePost(request);
}

function sessionCookieOf(response: Response): string | undefined {
  const line = response.headers.getSetCookie().find(entry => entry.startsWith(`${SESSION_COOKIE}=`));
  return line?.split(";", 1)[0];
}

describe("FSL-132 Web session entry in legacy mode", () => {
  beforeEach(() => {
    process.env.AUTH_MODE = "legacy";
    delete process.env.AUTH_PROVIDER;
  });

  it.each([
    ["AUTH_MODE=legacy", "legacy", undefined],
    ["AUTH_MODE unset, AUTH_PROVIDER=local", undefined, "local"],
  ] as const)("AC28 %s: sign in with email and password, read the session, sign out", async (_label, mode, provider) => {
    if (mode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = mode;
    if (provider === undefined) delete process.env.AUTH_PROVIDER; else process.env.AUTH_PROVIDER = provider;
    const signUp = await auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: "Legacy Member" } });
    const userId = signUp.user.id;
    await database!.pool.query("delete from session");

    // Sign in through the middleware and the real `/api/auth/[...all]` route.
    const signIn = await authPost("/sign-in/email", { email: EMAIL, password: PASSWORD });
    expect(signIn.status).toBe(200);
    const cookie = sessionCookieOf(signIn);
    expect(cookie).toBeDefined();

    // get-session returns that user, and the Web actor is legacy.
    const session = await getSession(cookie);
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ user: { id: userId, email: EMAIL, name: "Legacy Member" } });
    const sessionId = (session.body as { session: { id: string } }).session.id;
    await expect(resolveWebActor(new Headers({ cookie: cookie! }))).resolves.toEqual({
      kind: "legacy",
      userId,
      email: EMAIL,
      sessionId,
    });
    expect(await authMiddleware(pageRequest(cookie))).toBeUndefined();
    // A legacy session needs no Feishu marker row.
    expect((await database!.pool.query("select count(*)::int as n from feishu_login_sessions")).rows[0]).toEqual({ n: 0 });

    // Sign out ends the session: get-session is null and the actor is gone.
    const signOut = await authPost("/sign-out", {}, cookie);
    expect(signOut.status).toBe(200);
    expect(await getSession(cookie)).toEqual({ status: 200, body: null });
    await expect(resolveWebActor(new Headers({ cookie: cookie! }))).resolves.toBeNull();
    expect(redirectTarget(await authMiddleware(pageRequest(cookie)))).toBe("/en/signin?callbackUrl=%2Fen%2Fworkspace");
    expect((await database!.pool.query("select count(*)::int as n from session where id = $1", [sessionId])).rows[0])
      .toEqual({ n: 0 });
  });

  it("AC28: a wrong password signs nobody in", async () => {
    await auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: "Legacy Member" } });
    const response = await authPost("/sign-in/email", { email: EMAIL, password: `${PASSWORD}-wrong` });
    expect(response.status).toBe(401);
    expect(sessionCookieOf(response)).toBeUndefined();
  });
});
