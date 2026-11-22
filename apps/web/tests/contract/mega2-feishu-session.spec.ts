// megaui-only (FSL-156): the Mega2 principal of a Feishu session, driven through the real
// middleware and `/api/auth/[...all]` route (`get-session`, `sign-out`) against a one-shot
// PostgreSQL. Feishu members sign in through the real verify endpoint (FSL-124/FSL-125): codes
// are written with the issue store's `reserve` / `activate`, as the issue service does, so the
// first login creates the user and its `feishu_identities` binding and later logins find it.
//
// The Web wiring of the Feishu-mode Auth instance is FSL-150, so `getAuth()` is replaced by a
// real `createAuth` instance (with the Feishu login plugin) over the same database; the shared
// Pool that reads the FSL-126 marker rows and runs the principal conflict check is the real
// `@megaui/database` singleton on DATABASE_URL.
//
// Mega2's side is not run: `mega2Username` restates `WebsiteAuthUserJson::into_login_user`
// (mega2 `src/api/oauth/model.rs`): a non-blank `name` is the `LoginUser.username`.
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth, FEISHU_LOGIN_CODE_ALPHABET, FEISHU_LOGIN_CODE_LENGTH, FEISHU_LOGIN_FLOW_COOKIE } from "@megaui/auth";
import {
  closeDatabaseClient,
  createDatabaseClient,
  createFeishuLoginCodeStore,
  feishuLoginCodeHmac,
  feishuLoginEmailHmac,
  getPool,
  type DatabaseClient,
} from "@megaui/database";
import { createIsolatedPostgres, isDockerAvailable, type IsolatedPostgres } from "@megaui/database/test-support";

const authHolder = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@/lib/auth", () => ({
  getAuth: () => {
    if (!authHolder.current) throw new Error("test Auth instance is not ready");
    return authHolder.current;
  },
  prepareWebAuth: () => { throw new Error("Feishu mode must not prepare the enterprise assembly"); },
  resolveCurrentWebAuthMode: async () => { throw new Error("Feishu mode must not read the enterprise mode"); },
}));

import { GET as authRouteGet, POST as authRoutePost } from "@/app/api/auth/[...all]/route";
import { resolveWebActor } from "@/lib/enterprise-session";
import { FEISHU_LOGIN_PRINCIPAL_CONFLICT } from "@/lib/mega2-session";
import { authMiddleware } from "@/middlewares/auth";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error("[@megaui/web] mega2-feishu-session.spec.ts: a docker daemon is required (the fixture owns its own Postgres).");
}

const ORIGIN = "http://127.0.0.1:3000";
const SECRET = "fsl156-contract-secret-at-least-32-characters";
const SESSION_COOKIE = "better-auth.session_token";
const APP_ID = "cli_fsl156_app";
const KEY = new Uint8Array(randomBytes(32));
const MANAGED = ["AUTH_MODE", "AUTH_PROVIDER", "DATABASE_URL", "ENTERPRISE_PROCESS_ROLE", "ENTERPRISE_OWNER_FINGERPRINT",
  "ENTERPRISE_DB_INSTANCE_ID", "ENTERPRISE_DEPLOYMENT_ROLE", "ENTERPRISE_APPROVED_TARGETS"] as const;
const saved = new Map(MANAGED.map(key => [key, process.env[key]]));

let isolated: IsolatedPostgres | undefined;
let database: DatabaseClient | undefined;
const verifyLog = vi.fn();

function buildAuth(db: DatabaseClient) {
  return createAuth({
    appName: "megaui-fsl156",
    secret: SECRET,
    baseURL: ORIGIN,
    db: db.db,
    email: { sendVerificationEmail: vi.fn(), sendResetPasswordEmail: vi.fn() } as never,
    nodeEnv: "test",
    trustedOrigins: { appBaseUrl: ORIGIN },
    feishuLogin: {
      // Codes are written directly with the issue store; the request endpoint is not used.
      issue: {
        reserve: async () => { throw new Error("FSL-156 does not use the request endpoint"); },
        deliver: async () => undefined,
      },
      verify: { pool: db.pool, appId: APP_ID, otpHmacKey: KEY, log: verifyLog },
    },
  });
}
type Auth = ReturnType<typeof buildAuth>;
let auth: Auth;

/** WebsiteAuthUserJson::into_login_user (mega2 `src/api/oauth/model.rs`), restated. */
function mega2Username(user: { name: string; email: string | null; banned?: boolean }): string | undefined {
  if (user.banned === true) return undefined;
  const trim = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const email = user.email ?? "";
  let username: string;
  if (trim(user.name) === "") {
    const at = email.indexOf("@");
    username = at < 0 ? "" : trim(email.slice(0, at));
  } else {
    username = user.name;
  }
  return trim(username) === "" ? undefined : username;
}

interface Member {
  readonly email: string;
  readonly openId: string;
  readonly name: string;
}

let codeCounter = 0;
function nextCode(): string {
  // A distinct code of the verify alphabet for every login.
  const alphabet = FEISHU_LOGIN_CODE_ALPHABET;
  codeCounter += 1;
  let value = codeCounter;
  let code = "";
  for (let index = 0; index < FEISHU_LOGIN_CODE_LENGTH; index += 1) {
    code += alphabet[value % alphabet.length];
    value = Math.floor(value / alphabet.length);
  }
  return code;
}

/** Reserves and activates a code for a new flow and submits it to the real verify endpoint. */
async function feishuLogin(member: Member): Promise<{ cookie: string; userId: string }> {
  const flow = randomBytes(32).toString("base64url");
  const code = nextCode();
  const store = createFeishuLoginCodeStore(database!.pool);
  const emailHmac = feishuLoginEmailHmac(KEY, member.email);
  // The cooldown counts every row of the email; earlier rows are moved out of it.
  await database!.pool.query("update feishu_login_codes set created_at = created_at - interval '1 hour'");
  const reserved = await store.reserve({ flowHash: createHash("sha256").update(flow, "utf8").digest("hex"), emailHmac });
  if (reserved.kind !== "reserved") throw new Error(`reserve: ${reserved.kind}`);
  const activated = await store.activate({
    id: reserved.id,
    emailHmac,
    email: member.email,
    openId: member.openId,
    displayName: member.name,
    codeHmac: feishuLoginCodeHmac(KEY, reserved.id, code),
  });
  if (activated.kind !== "active") throw new Error(`activate: ${activated.kind}`);
  const response = await auth.handler(new Request(`${ORIGIN}/api/auth/feishu-login/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie: `${FEISHU_LOGIN_FLOW_COOKIE}=${flow}` },
    body: JSON.stringify({ code }),
  }));
  expect(response.status).toBe(200);
  const line = response.headers.getSetCookie().find(entry => entry.startsWith(`${SESSION_COOKIE}=`));
  if (!line) throw new Error("verify issued no session cookie");
  const cookie = line.split(";", 1)[0]!;
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  if (!session) throw new Error("Feishu session is not readable");
  return { cookie, userId: session.user.id };
}

interface Projection {
  readonly session: { id: string };
  readonly user: { id: string; name: string; email: string | null; image: string | null; banned: boolean };
}

/** `GET /api/auth/get-session` through the middleware and then the real route. */
async function getSession(cookie?: string): Promise<Projection | null> {
  const request = new NextRequest(`${ORIGIN}/api/auth/get-session`, { headers: cookie ? { cookie, origin: ORIGIN } : { origin: ORIGIN } });
  const blocked = await authMiddleware(request);
  if (blocked) throw new Error(`middleware refused get-session: ${blocked.status}`);
  const response = await authRouteGet(request);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return await response.json() as Projection | null;
}

/** `POST /api/auth/sign-out` through the middleware and then the real route. */
async function signOut(cookie: string): Promise<void> {
  const request = new NextRequest(`${ORIGIN}/api/auth/sign-out`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: "{}",
  });
  expect(await authMiddleware(request)).toBeUndefined();
  expect((await authRoutePost(request)).status).toBe(200);
}

async function insertLocalUser(id: string, name: string, email: string): Promise<void> {
  await database!.pool.query(
    `insert into "user" (id, name, email, email_verified, role) values ($1, $2, $3, true, 'user')`,
    [id, name, email],
  );
}

async function userCounts(): Promise<{ users: number; identities: number }> {
  const users = (await database!.pool.query<{ n: number }>(`select count(*)::int as n from "user"`)).rows[0]!.n;
  const identities = (await database!.pool.query<{ n: number }>("select count(*)::int as n from feishu_identities")).rows[0]!.n;
  return { users, identities };
}

function captureWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("FSL-156 Mega2 principal of Feishu sessions", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    database = createDatabaseClient({ connectionString: isolated.databaseUrl, max: 4, onPoolError: () => {} });
    for (const key of MANAGED) delete process.env[key];
    process.env.AUTH_MODE = "enterprise";
    process.env.AUTH_PROVIDER = "feishu";
    process.env.DATABASE_URL = isolated.databaseUrl;
    auth = buildAuth(database);
    authHolder.current = auth;
    await auth.$context;
  }, 180_000);

  beforeEach(async () => {
    verifyLog.mockClear();
    await database!.pool.query(`delete from feishu_login_sessions; delete from session; delete from feishu_identities;
      delete from feishu_login_codes; delete from enterprise_profile; delete from account; delete from "user"`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const end of [() => closeDatabaseClient(), () => database?.close(), () => isolated?.destroy()]) {
      try { await end(); } catch (error) { errors.push(error); }
    }
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (errors.length) throw new AggregateError(errors, "FSL-156 cleanup failed");
  }, 120_000);

  it("AC1: get-session projects fs_<user ID> as the Mega2 user name", async () => {
    const member = { email: "wang.wu@example.test", openId: "ou_fsl156_wangwu", name: "王五 Wang Wu" };
    const login = await feishuLogin(member);
    const body = await getSession(login.cookie);
    expect(body?.user).toEqual({ id: login.userId, name: `fs_${login.userId}`, email: member.email, image: null, banned: false });
    expect(mega2Username(body!.user)).toBe(`fs_${login.userId}`);
    // The display name stays on the user for page display; it is not the Mega2 principal.
    expect((await database!.pool.query(`select name from "user" where id = $1`, [login.userId])).rows[0]).toEqual({ name: member.name });
    expect(JSON.stringify(body)).not.toContain("Wang Wu");
    expect(verifyLog).not.toHaveBeenCalled();
  });

  it("AC2: two Feishu users with the same display name get different user names", async () => {
    const first = await feishuLogin({ email: "li.si@example.test", openId: "ou_fsl156_lisi_a", name: "李四" });
    const second = await feishuLogin({ email: "lisi@corp.example.test", openId: "ou_fsl156_lisi_b", name: "李四" });
    expect(first.userId).not.toBe(second.userId);
    const firstName = mega2Username((await getSession(first.cookie))!.user);
    const secondName = mega2Username((await getSession(second.cookie))!.user);
    expect(firstName).toBe(`fs_${first.userId}`);
    expect(secondName).toBe(`fs_${second.userId}`);
    expect(firstName).not.toBe(secondName);
  });

  it("AC3: the same member signing out and in again keeps the user name", async () => {
    const member = { email: "zhao.liu@example.test", openId: "ou_fsl156_zhaoliu", name: "赵六" };
    const first = await feishuLogin(member);
    expect(await userCounts()).toEqual({ users: 1, identities: 1 });
    const before = mega2Username((await getSession(first.cookie))!.user);
    await signOut(first.cookie);
    expect(await getSession(first.cookie)).toBeNull();
    const second = await feishuLogin(member);
    expect(second.cookie).not.toBe(first.cookie);
    expect(second.userId).toBe(first.userId);
    expect(await userCounts()).toEqual({ users: 1, identities: 1 });
    expect(mega2Username((await getSession(second.cookie))!.user)).toBe(before);
    expect(before).toBe(`fs_${first.userId}`);
  });

  it("AC4: a changed display name keeps the user name", async () => {
    const member = { email: "sun.qi@example.test", openId: "ou_fsl156_sunqi", name: "孙七" };
    const login = await feishuLogin(member);
    const before = mega2Username((await getSession(login.cookie))!.user);
    await database!.pool.query(`update "user" set name = $2 where id = $1`, [login.userId, "孙七（新）"]);
    expect(mega2Username((await getSession(login.cookie))!.user)).toBe(before);
    // A later login whose directory read carries another display name keeps it too.
    const again = await feishuLogin({ ...member, name: "Sun Qi Renamed" });
    expect(again.userId).toBe(login.userId);
    expect(mega2Username((await getSession(again.cookie))!.user)).toBe(before);
    expect(before).toBe(`fs_${login.userId}`);
  });

  it("AC5: a Feishu user named like a Mega2 administrator does not get the administrator's user name", async () => {
    await insertLocalUser("fsl156-admin", "mega-admin", "admin@example.test");
    const login = await feishuLogin({ email: "imitator@example.test", openId: "ou_fsl156_imitator", name: "mega-admin" });
    const name = mega2Username((await getSession(login.cookie))!.user);
    expect(name).toBe(`fs_${login.userId}`);
    expect(name).not.toBe("mega-admin");
    // The administrator's own Mega2 user name, derived by the same rule, is unchanged.
    expect(mega2Username({ name: "mega-admin", email: "admin@example.test" })).toBe("mega-admin");
  });

  describe("AC7: another local user deriving fs_<user ID> makes the Feishu session null", () => {
    async function member() {
      const login = await feishuLogin({ email: "zhou.ba@example.test", openId: "ou_fsl156_zhouba", name: "周八" });
      const principal = `fs_${login.userId}`;
      expect((await getSession(login.cookie))?.user.name).toBe(principal);
      return { ...login, principal };
    }

    async function expectConflict(cookie: string, userId: string): Promise<void> {
      const warn = captureWarn();
      expect(await getSession(cookie)).toBeNull();
      expect(warn.mock.calls).toEqual([[FEISHU_LOGIN_PRINCIPAL_CONFLICT]]);
      warn.mockRestore();
      // The session itself is still a valid Feishu session: only the projection refuses it.
      await expect(resolveWebActor(new Headers({ cookie }))).resolves.toMatchObject({ kind: "feishu", userId });
    }

    it("a local user whose name is exactly fs_<user ID>", async () => {
      const login = await member();
      await insertLocalUser("fsl156-other", login.principal, "other@example.test");
      await expectConflict(login.cookie, login.userId);
      await database!.pool.query(`delete from "user" where id = 'fsl156-other'`);
      expect((await getSession(login.cookie))?.user.name).toBe(login.principal);
    });

    it("a local user with a blank name whose email local part, trimmed, is fs_<user ID>", async () => {
      const login = await member();
      await insertLocalUser("fsl156-other", "\u0085 \t\u3000", `\u2003${login.principal}\t@example.test`);
      await expectConflict(login.cookie, login.userId);
    });

    it("a local user whose frozen enterprise principal is fs_<user ID>", async () => {
      const login = await member();
      await insertLocalUser("fsl156-other", "Someone Else", "someone@example.test");
      await database!.pool.query(
        `insert into enterprise_profile (user_id, tenant_key, login_name, backend_username) values ($1, $2, $3, $4)`,
        ["fsl156-other", "tenant-fsl156", "someone", login.principal],
      );
      await expectConflict(login.cookie, login.userId);
    });

    it("a failed check query", async () => {
      const login = await member();
      const pool = getPool();
      const original = pool.query.bind(pool) as (...args: unknown[]) => unknown;
      vi.spyOn(pool, "query").mockImplementation(((...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0].includes("left join enterprise_profile")) {
          return Promise.reject(new Error("injected principal check failure"));
        }
        return original(...args);
      }) as never);
      await expectConflict(login.cookie, login.userId);
      vi.mocked(pool.query).mockRestore();
      expect((await getSession(login.cookie))?.user.name).toBe(login.principal);
    });

    it("near misses derive another user name and do not conflict", async () => {
      const login = await member();
      // A frozen enterprise principal wins over a name equal to the principal.
      await insertLocalUser("fsl156-frozen", login.principal, "frozen@example.test");
      await database!.pool.query(
        `insert into enterprise_profile (user_id, tenant_key, login_name, backend_username) values ($1, $2, $3, $4)`,
        ["fsl156-frozen", "tenant-fsl156", "frozen", "frozen.backend"],
      );
      // A non-blank name wins over an email local part equal to the principal.
      await insertLocalUser("fsl156-named", "Named", `${login.principal}@example.test`);
      // A non-blank name is used verbatim, padding included.
      await insertLocalUser("fsl156-padded", ` ${login.principal}`, "padded@example.test");
      // A longer name or local part is not equal.
      await insertLocalUser("fsl156-longer", `${login.principal}x`, `${login.principal}x@example.test`);
      await insertLocalUser("fsl156-blank", " ", `${login.principal}.x@example.test`);
      const warn = captureWarn();
      expect((await getSession(login.cookie))?.user.name).toBe(login.principal);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
