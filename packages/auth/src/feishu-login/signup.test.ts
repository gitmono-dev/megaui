// FSL-125: the first Feishu login creates the account; FSL-152: its conflict, rollback and
// concurrency. Driven through the real `createAuth` handler against a one-shot PostgreSQL that
// starts without any user or Feishu identity binding; codes are written through the issue store's
// `reserve` / `activate`, as the issue service does.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupFeishuLoginCodes,
  createDatabaseClient,
  createFeishuLoginCodeStore,
  FEISHU_LOGIN_IDENTITY_LOCK_CLASS,
  feishuLoginCodeHmac,
  feishuLoginEmailHmac,
  feishuLoginIdentityLockKey,
  type DatabaseClient,
} from "@megaui/database";
import { createIsolatedPostgres, isDockerAvailable, type IsolatedPostgres } from "@megaui/database/test-support";
import { createAuth } from "../create-auth";
import { FEISHU_LOGIN_FLOW_COOKIE } from "./cookie";
import { FEISHU_LOGIN_VERIFY_PATH } from "./plugin";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error("[@megaui/auth] feishu-login/signup.test.ts: a docker daemon is required (the fixture owns its own Postgres).");
}

const ORIGIN = "http://127.0.0.1:3000";
const URL_VERIFY = `${ORIGIN}/api/auth${FEISHU_LOGIN_VERIFY_PATH}`;
const URL_SESSION = `${ORIGIN}/api/auth/get-session`;
const SESSION_COOKIE = "better-auth.session_token";

const APP_ID = "cli_fsl125_app";
const KEY = new Uint8Array(randomBytes(32));
const EMAIL = "zhang.san@example.com";
const SECOND_EMAIL = "zs@corp.example.com";
const OPEN_ID = "ou_fsl125_zhangsan";
const NAME = "张三 Zhang San";
const CODE = "A2B3C4D5";
const SECOND_CODE = "E6F7G8H9";
const WRONG = "Z9Y8X7W6";

let isolated: IsolatedPostgres;
let database: DatabaseClient;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The identity HMAC of the plan, computed independently of `verify.ts`. */
function expectedOpenIdHmac(openId: string): string {
  return createHmac("sha256", KEY).update(`feishu-identity:v1:${APP_ID}:${openId}`, "utf8").digest("hex");
}

/** The verify log of the auth built by `beforeEach`; reset for every case. */
let verifyLog = vi.fn();

/** `null` builds the auth without a `log` option (the default logger). */
function buildAuth(log: ((key: string) => void) | null = verifyLog) {
  return createAuth({
    appName: "megaui-test",
    secret: "test-secret-at-least-32-characters-long",
    baseURL: ORIGIN,
    db: database.db,
    email: { sendVerificationEmail: vi.fn(), sendResetPasswordEmail: vi.fn() } as never,
    nodeEnv: "test",
    feishuLogin: {
      issue: { reserve: async () => undefined, deliver: async () => undefined },
      verify: { pool: database.pool, appId: APP_ID, otpHmacKey: KEY, ...(log === null ? {} : { log }) },
    },
  });
}

type Auth = ReturnType<typeof buildAuth>;

function newFlow(): string {
  return randomBytes(32).toString("base64url");
}

async function verify(auth: Auth, code: string, flow: string): Promise<Response> {
  return auth.handler(new Request(URL_VERIFY, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie: `${FEISHU_LOGIN_FLOW_COOKIE}=${flow}` },
    body: JSON.stringify({ code }),
  }));
}

interface Member {
  readonly email?: string;
  readonly openId?: string;
  readonly name?: string;
  readonly code?: string;
  /**
   * Computes the row's email HMAC from this string instead of the email. Only the FSL-152
   * concurrency case uses it, to hold two `active` rows of one email at once (an activation voids
   * every other `active` row of the same email HMAC).
   */
  readonly emailHmacOf?: string;
}

/** Reserves and activates a code for `flow`, holding the member's email, open_id and name. */
async function activeCode(flow: string, member: Member = {}): Promise<string> {
  const email = member.email ?? EMAIL;
  const store = createFeishuLoginCodeStore(database.pool);
  const emailHmac = feishuLoginEmailHmac(KEY, member.emailHmacOf ?? email);
  // The cooldown counts every row of the email; earlier rows are moved out of it.
  await database.pool.query("update feishu_login_codes set created_at = created_at - interval '1 hour'");
  const reserved = await store.reserve({ flowHash: sha256Hex(flow), emailHmac });
  if (reserved.kind !== "reserved") throw new Error(`reserve: ${reserved.kind}`);
  const activated = await store.activate({
    id: reserved.id,
    emailHmac,
    email,
    openId: member.openId ?? OPEN_ID,
    displayName: member.name ?? NAME,
    codeHmac: feishuLoginCodeHmac(KEY, reserved.id, member.code ?? CODE),
  });
  if (activated.kind !== "active") throw new Error(`activate: ${activated.kind}`);
  return reserved.id;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  email_verified: boolean;
  image: string | null;
  role: string | null;
  banned: boolean | null;
}

async function users(): Promise<UserRow[]> {
  return (await database.pool.query<UserRow>(
    `select id, name, email, email_verified, image, role, banned from "user" order by created_at, id`,
  )).rows;
}

interface IdentityRow {
  app_id: string;
  open_id_hmac: string;
  user_id: string;
  created_at: Date;
}

async function identities(): Promise<IdentityRow[]> {
  return (await database.pool.query<IdentityRow>(
    "select app_id, open_id_hmac, user_id, created_at from feishu_identities order by created_at",
  )).rows;
}

interface CodeRow {
  state: string;
  email: string | null;
  open_id: string | null;
  display_name: string | null;
  code_hmac: string | null;
  expires_at: Date;
}

async function codeRow(id: string): Promise<CodeRow> {
  return (await database.pool.query<CodeRow>(
    "select state, email, open_id, display_name, code_hmac, expires_at from feishu_login_codes where id = $1",
    [id],
  )).rows[0]!;
}

/** Every column of a code row, to show that nothing of it changed. */
async function fullCodeRow(id: string): Promise<Record<string, unknown>> {
  return (await database.pool.query("select * from feishu_login_codes where id = $1", [id])).rows[0]!;
}

async function sessionCount(): Promise<number> {
  return (await database.pool.query<{ n: number }>("select count(*)::int as n from session")).rows[0]!.n;
}

function sessionCookie(response: Response): string | undefined {
  const line = response.headers.getSetCookie().find(entry => entry.startsWith(`${SESSION_COOKIE}=`));
  return line?.split(";")[0];
}

/** The user `get-session` returns for the session cookie a verify response set. */
async function sessionUser(auth: Auth, response: Response): Promise<{ id?: string; email?: string; emailVerified?: boolean; name?: string } | undefined> {
  const cookie = sessionCookie(response);
  expect(cookie).toBeDefined();
  const session = await auth.handler(new Request(URL_SESSION, { headers: { cookie: cookie!, origin: ORIGIN } }));
  expect(session.status).toBe(200);
  const body = await session.json() as { user?: { id?: string; email?: string; emailVerified?: boolean; name?: string } } | null;
  return body?.user;
}

/** Every column of every user, to show that nothing of them changed. */
async function fullUsers(): Promise<Array<Record<string, unknown>>> {
  return (await database.pool.query(`select * from "user" order by id`)).rows;
}

/** A local user holding `email`, with no Feishu identity binding. */
async function insertLocalUser(id: string, email: string): Promise<void> {
  await database.pool.query(
    `insert into "user" (id, name, email, email_verified) values ($1, 'Local', $2, false)`,
    [id, email],
  );
}

/** FSL-152 AC3: a trigger that fails every insert into `table`; its message names the new row. */
async function injectFailure(table: "user" | "feishu_identities"): Promise<void> {
  await database.pool.query(`create or replace function fsl152_inject_failure() returns trigger language plpgsql as $$
    begin raise exception 'FSL-152 injected failure %', row_to_json(new)::text; end $$`);
  await database.pool.query(
    `create trigger fsl152_inject_failure before insert on "${table}" for each row execute function fsl152_inject_failure()`,
  );
}

async function removeFailure(table: "user" | "feishu_identities"): Promise<void> {
  await database.pool.query(`drop trigger if exists fsl152_inject_failure on "${table}"`);
}

/** Everything written to the console from now on, as one string (the console is silenced). */
function captureConsole(): () => string {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(arg => (typeof arg === "string" ? arg : inspect(arg, { depth: 10 }))).join(" "));
    });
  }
  return () => lines.join("\n");
}

/** The second key of the member's identity advisory lock (FSL-152). */
function identityLockKey(): number {
  return feishuLoginIdentityLockKey(expectedOpenIdHmac(OPEN_ID));
}

/** Requests for the member's identity lock that are waiting (not granted). */
async function identityLockWaiters(): Promise<number> {
  return (await database.pool.query<{ n: number }>(
    `select count(*)::int as n from pg_locks
      where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())
        and classid = $1::bigint::oid and objid = $2::bigint::oid and objsubid = 2 and not granted`,
    [FEISHU_LOGIN_IDENTITY_LOCK_CLASS, identityLockKey() >>> 0],
  )).rows[0]!.n;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** A first login of the member through its own flow; it must answer 200. */
async function firstLogin(auth: Auth, member: Member = {}): Promise<Response> {
  const flow = newFlow();
  await activeCode(flow, member);
  const response = await verify(auth, member.code ?? CODE, flow);
  expect(response.status).toBe(200);
  expect(await response.clone().json()).toEqual({ status: "ok" });
  return response;
}

describe("feishu login first-login account creation (FSL-125) and its conflict, rollback and concurrency (FSL-152)", () => {
  let auth: Auth;

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    database = createDatabaseClient({ connectionString: isolated.databaseUrl, max: 10, onPoolError: () => {} });
  }, 120_000);

  beforeEach(async () => {
    await database.pool.query(`delete from feishu_login_sessions; delete from session; delete from feishu_identities;
      delete from feishu_login_codes; delete from "user"`);
    verifyLog = vi.fn();
    auth = buildAuth();
    await auth.$context;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const end of [() => database?.close(), () => isolated?.destroy()]) {
      try {
        await end();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "FSL-125 cleanup failed");
  }, 120_000);

  it("AC1: a first login creates exactly one user, and the session belongs to it", async () => {
    expect(await users()).toHaveLength(0);
    const response = await firstLogin(auth);
    const created = await users();
    expect(created).toHaveLength(1);
    expect((await sessionUser(auth, response))?.id).toBe(created[0]!.id);
  });

  it("AC2: the new user's email is the login email", async () => {
    const response = await firstLogin(auth);
    const [created] = await users();
    expect(created!.email).toBe(EMAIL);
    expect((await sessionUser(auth, response))?.email).toBe(EMAIL);
  });

  it("AC3: the new user's emailVerified is true", async () => {
    const response = await firstLogin(auth);
    const [created] = await users();
    expect(created!.email_verified).toBe(true);
    expect((await sessionUser(auth, response))?.emailVerified).toBe(true);
  });

  it("AC4: the new user's name is the name read when the code was issued", async () => {
    const response = await firstLogin(auth);
    const [created] = await users();
    expect(created!.name).toBe(NAME);
    expect((await sessionUser(auth, response))?.name).toBe(NAME);
  });

  it("writes the user as Better Auth's admin plugin would: role user, not banned, no image", async () => {
    await firstLogin(auth);
    const [created] = await users();
    expect(created).toMatchObject({ image: null, role: "user", banned: false });
    expect(created!.id).not.toContain(OPEN_ID);
  });

  it("AC5: a first login inserts one (app_id, open_id_hmac, user_id) binding", async () => {
    await firstLogin(auth);
    const [created] = await users();
    const rows = await identities();
    expect(rows.map(({ app_id, open_id_hmac, user_id }) => ({ app_id, open_id_hmac, user_id }))).toEqual([
      { app_id: APP_ID, open_id_hmac: expectedOpenIdHmac(OPEN_ID), user_id: created!.id },
    ]);
  });

  it("AC6: a second login of the same member creates no user and signs into the same one", async () => {
    await firstLogin(auth);
    const before = await users();
    expect(before).toHaveLength(1);
    const again = await firstLogin(auth, { code: SECOND_CODE });
    expect(await users()).toEqual(before);
    expect((await sessionUser(auth, again))?.id).toBe(before[0]!.id);
    expect(await sessionCount()).toBe(2);
  });

  it("AC7: a second login of the same member creates no binding", async () => {
    await firstLogin(auth);
    const before = await identities();
    expect(before).toHaveLength(1);
    await firstLogin(auth, { code: SECOND_CODE });
    expect(await identities()).toEqual(before);
  });

  it("AC6, AC7: a later login of the same member with another email finds the binding and creates neither a user nor a binding", async () => {
    await firstLogin(auth);
    const usersBefore = await users();
    const identitiesBefore = await identities();
    const again = await firstLogin(auth, { email: SECOND_EMAIL, code: SECOND_CODE });
    expect(await users()).toEqual(usersBefore);
    expect(await identities()).toEqual(identitiesBefore);
    expect((await sessionUser(auth, again))?.id).toBe(usersBefore[0]!.id);
  });

  it("regression: the consumed row's sensitive fields are empty after the first login", async () => {
    const flow = newFlow();
    const id = await activeCode(flow);
    expect((await verify(auth, CODE, flow)).status).toBe(200);
    expect(await codeRow(id)).toMatchObject({ state: "consumed", email: null, open_id: null, display_name: null, code_hmac: null });
  });

  it("regression: feishu_identities holds no open_id in plain text", async () => {
    await firstLogin(auth);
    const columns = (await database.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = 'feishu_identities' order by column_name`,
    )).rows.map(row => row.column_name);
    expect(columns).toEqual(["app_id", "created_at", "open_id_hmac", "user_id"]);
    const dump = (await database.pool.query<{ row: string }>("select row_to_json(i)::text as row from feishu_identities i")).rows;
    expect(dump).toHaveLength(1);
    expect(dump[0]!.row).not.toContain(OPEN_ID);
  });

  it("regression: an active row of the member's second email is kept by the first login and cleared at its own expiry by the cleanup", async () => {
    const other = await activeCode(newFlow(), { email: SECOND_EMAIL, code: SECOND_CODE });
    const held = await codeRow(other);
    expect(held.state).toBe("active");
    await firstLogin(auth);
    // The first login neither consumes nor clears the other email's row: it is still `active` with
    // the same hold, code HMAC, expiry and failure count (created_at is not compared: the first
    // login's own `activeCode` shifts every row's created_at).
    const kept = await fullCodeRow(other);
    expect(kept).toMatchObject({ state: "active", email: SECOND_EMAIL, open_id: OPEN_ID, display_name: NAME });
    expect(kept.code_hmac).toBe(held.code_hmac);
    expect(kept.expires_at).toEqual(held.expires_at);
    expect(kept.failed_attempts).toBe(0);
    // Before its own expiry the cleanup leaves every column as it is ...
    const expiresAt = new Date(held.expires_at).getTime();
    await cleanupFeishuLoginCodes(database.pool, { now: new Date(expiresAt - 1000) });
    expect(await fullCodeRow(other)).toEqual(kept);
    // ... and once it has expired the cleanup voids it and clears its sensitive fields.
    const cleaned = await cleanupFeishuLoginCodes(database.pool, { now: new Date(expiresAt + 1000) });
    expect(cleaned.voided).toBe(1);
    expect(await codeRow(other)).toMatchObject({ state: "void", email: null, open_id: null, display_name: null, code_hmac: null });
    expect(await users()).toHaveLength(1);
    expect(await identities()).toHaveLength(1);
  });

  it("creates no account before the code is accepted: a wrong or an expired code answers 401", async () => {
    const flow = newFlow();
    const id = await activeCode(flow);
    expect((await verify(auth, WRONG, flow)).status).toBe(401);
    await database.pool.query(
      "update feishu_login_codes set expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [id],
    );
    expect((await verify(auth, CODE, flow)).status).toBe(401);
    expect(await users()).toHaveLength(0);
    expect(await identities()).toHaveLength(0);
    expect(await sessionCount()).toBe(0);
  });

  it("FSL-152 AC1: a local user that already holds the email answers 409 account_conflict and logs FEISHU_LOGIN_ACCOUNT_CONFLICT", async () => {
    await insertLocalUser("fsl152-local", EMAIL);
    const flow = newFlow();
    const id = await activeCode(flow);
    const response = await verify(auth, CODE, flow);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "account_conflict" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(sessionCookie(response)).toBeUndefined();
    expect(await sessionCount()).toBe(0);
    // Only the stable key is logged, once.
    expect(verifyLog.mock.calls).toEqual([["FEISHU_LOGIN_ACCOUNT_CONFLICT"]]);
    // The consumption committed: the row is consumed with its hold cleared, so the same code is
    // not accepted again.
    expect(await codeRow(id)).toMatchObject({ state: "consumed", email: null, open_id: null, display_name: null, code_hmac: null });
    const again = await verify(auth, CODE, flow);
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ status: "invalid" });
    expect(verifyLog).toHaveBeenCalledTimes(1);
  });

  it("FSL-152 AC2: the conflict creates or changes no user and writes no binding", async () => {
    await insertLocalUser("fsl152-local", EMAIL);
    await insertLocalUser("fsl152-other", "someone.else@example.com");
    const before = await fullUsers();
    const flow = newFlow();
    await activeCode(flow);
    expect((await verify(auth, CODE, flow)).status).toBe(409);
    expect(await fullUsers()).toEqual(before);
    expect(await identities()).toHaveLength(0);
  });

  it("FSL-152 AC2: a user of another member that holds the email is neither merged nor changed, and its binding is kept", async () => {
    // Another member signed up first with this email (it was reassigned since).
    await firstLogin(auth, { openId: "ou_fsl152_previous_holder" });
    const usersBefore = await fullUsers();
    const identitiesBefore = await identities();
    const flow = newFlow();
    await activeCode(flow, { code: SECOND_CODE });
    const response = await verify(auth, SECOND_CODE, flow);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "account_conflict" });
    expect(await fullUsers()).toEqual(usersBefore);
    expect(await identities()).toEqual(identitiesBefore);
    expect(await sessionCount()).toBe(1);
  });

  it("FSL-152: the default logger receives only the stable key, and a throwing logger does not change the answer", async () => {
    await insertLocalUser("fsl152-local", EMAIL);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const defaultAuth = buildAuth(null);
    await defaultAuth.$context;
    const flow = newFlow();
    await activeCode(flow);
    expect((await verify(defaultAuth, CODE, flow)).status).toBe(409);
    expect(warn.mock.calls).toEqual([["FEISHU_LOGIN_ACCOUNT_CONFLICT"]]);

    const throwingAuth = buildAuth(() => { throw new Error("logger down"); });
    await throwingAuth.$context;
    const second = newFlow();
    await activeCode(second, { code: SECOND_CODE });
    const response = await verify(throwingAuth, SECOND_CODE, second);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "account_conflict" });
  });

  it.each([
    ["the user insert", "user"],
    ["the binding insert, after the user insert", "feishu_identities"],
  ] as const)("FSL-152 AC3: a failure injected into %s rolls back the user, the binding and the consumption", async (_step, table) => {
    const flow = newFlow();
    const id = await activeCode(flow);
    const rowBefore = await fullCodeRow(id);
    const output = captureConsole();
    await injectFailure(table);
    let response: Response;
    try {
      response = await verify(auth, CODE, flow);
    } finally {
      await removeFailure(table);
    }
    expect(response.status).toBe(500);
    expect(sessionCookie(response)).toBeUndefined();
    // The database error (whose message here names the email) is not reported.
    const body = await response.text();
    expect(body).not.toContain(EMAIL);
    expect(body).not.toContain("injected failure");
    expect(output()).not.toContain(EMAIL);
    expect(output()).not.toContain("injected failure");
    expect(await users()).toHaveLength(0);
    expect(await identities()).toHaveLength(0);
    expect(await fullCodeRow(id)).toEqual(rowBefore);
    expect(await sessionCount()).toBe(0);
    expect(verifyLog).not.toHaveBeenCalled();
    // The code is still active, so the same code can be submitted again once the failure is gone.
    const retry = await verify(auth, CODE, flow);
    expect(retry.status).toBe(200);
    const created = await users();
    expect(created).toHaveLength(1);
    expect((await sessionUser(auth, retry))?.id).toBe(created[0]!.id);
  });

  /**
   * Two first logins of the member through two flows, interleaved at the identity lock: a third
   * connection holds the member's identity lock, so both verify transactions consume their own
   * row, find no binding and then wait for the lock on their own connections; once both wait, the
   * lock is released. Asserts that both answer 200 with one user and one binding.
   */
  async function interleavedFirstLogins(authUnderTest: Auth, second: Member): Promise<void> {
    const flowA = newFlow();
    const flowB = newFlow();
    const idA = await activeCode(flowA);
    const idB = await activeCode(flowB, { ...second, code: SECOND_CODE });
    expect((await codeRow(idA)).state).toBe("active");
    expect((await codeRow(idB)).state).toBe("active");
    const holder = await database.pool.connect();
    let responses: Response[];
    try {
      await holder.query("select pg_advisory_lock($1::int4, $2::int4)", [FEISHU_LOGIN_IDENTITY_LOCK_CLASS, identityLockKey()]);
      const pending = Promise.all([verify(authUnderTest, CODE, flowA), verify(authUnderTest, SECOND_CODE, flowB)]);
      await waitFor(async () => (await identityLockWaiters()) === 2);
      expect(await users()).toHaveLength(0);
      await holder.query("select pg_advisory_unlock($1::int4, $2::int4)", [FEISHU_LOGIN_IDENTITY_LOCK_CLASS, identityLockKey()]);
      responses = await pending;
    } finally {
      await holder.query("select pg_advisory_unlock_all()").catch(() => undefined);
      holder.release();
    }
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const created = await users();
    expect(created).toHaveLength(1);
    expect((await identities()).map(row => row.user_id)).toEqual([created[0]!.id]);
    for (const response of responses) expect((await sessionUser(auth, response))?.id).toBe(created[0]!.id);
    expect((await codeRow(idA)).state).toBe("consumed");
    expect((await codeRow(idB)).state).toBe("consumed");
    expect(verifyLog).not.toHaveBeenCalled();
  }

  it.each([
    ["with two emails of the member", { email: SECOND_EMAIL }],
    ["with the same email", { emailHmacOf: SECOND_EMAIL }],
  ] as const)("FSL-152 AC4: two first logins of one member interleaved at the identity lock %s create one user", async (_case, second) => {
    await interleavedFirstLogins(auth, second);
  }, 30_000);

  it.each([
    ["with two emails of the member", { email: SECOND_EMAIL }],
    ["with the same email", { emailHmacOf: SECOND_EMAIL }],
  ] as const)("FSL-152 AC4: the interleaved first logins %s create one user when the default isolation level is REPEATABLE READ", async (_case, second) => {
    // Every connection of this pool starts with REPEATABLE READ as its default isolation level;
    // the verify transaction must not depend on that default.
    const url = new URL(isolated.databaseUrl);
    url.searchParams.set("options", "-c default_transaction_isolation=repeatable\\ read");
    const repeatable = createDatabaseClient({ connectionString: url.toString(), max: 4, onPoolError: () => {} });
    try {
      expect((await repeatable.pool.query<{ level: string }>("select current_setting('default_transaction_isolation') as level")).rows[0]!.level)
        .toBe("repeatable read");
      const repeatableAuth = createAuth({
        appName: "megaui-test",
        secret: "test-secret-at-least-32-characters-long",
        baseURL: ORIGIN,
        db: repeatable.db,
        email: { sendVerificationEmail: vi.fn(), sendResetPasswordEmail: vi.fn() } as never,
        nodeEnv: "test",
        feishuLogin: {
          issue: { reserve: async () => undefined, deliver: async () => undefined },
          verify: { pool: repeatable.pool, appId: APP_ID, otpHmacKey: KEY, log: verifyLog },
        },
      });
      await repeatableAuth.$context;
      await interleavedFirstLogins(repeatableAuth, second);
    } finally {
      await repeatable.close();
    }
  }, 30_000);

  it("FSL-152 AC4: two uncontrolled concurrent first logins of one member create one user", async () => {
    for (let round = 0; round < 5; round += 1) {
      await database.pool.query(`delete from feishu_login_sessions; delete from session; delete from feishu_identities;
        delete from feishu_login_codes; delete from "user"`);
      const flowA = newFlow();
      const flowB = newFlow();
      await activeCode(flowA);
      await activeCode(flowB, { email: SECOND_EMAIL, code: SECOND_CODE });
      const responses = await Promise.all([verify(auth, CODE, flowA), verify(auth, SECOND_CODE, flowB)]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      expect(await users()).toHaveLength(1);
      expect(await identities()).toHaveLength(1);
    }
  }, 30_000);
});
