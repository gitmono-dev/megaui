// FSL-124 (success path) and FSL-151 (failure path and concurrency) of `POST /feishu-login/verify`,
// driven through the real `createAuth` handler against a one-shot PostgreSQL with a preset user and
// Feishu identity binding.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDatabaseClient,
  createFeishuLoginCodeStore,
  feishuLoginCodeHmac,
  feishuLoginEmailHmac,
  type DatabaseClient,
} from "@megaui/database";
import { createIsolatedPostgres, isDockerAvailable, type IsolatedPostgres } from "@megaui/database/test-support";
import { createAuth } from "../create-auth";
import { FEISHU_LOGIN_FLOW_COOKIE } from "./cookie";
import { FEISHU_LOGIN_VERIFY_PATH } from "./plugin";
import { FEISHU_LOGIN_SESSION_TTL_SECONDS, feishuLoginOpenIdHmac } from "./verify";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error("[@megaui/auth] feishu-login/verify.test.ts: a docker daemon is required (the fixture owns its own Postgres).");
}

const ORIGIN = "http://127.0.0.1:3000";
const URL_VERIFY = `${ORIGIN}/api/auth${FEISHU_LOGIN_VERIFY_PATH}`;
const URL_REQUEST = `${ORIGIN}/api/auth/feishu-login/request`;
const URL_SESSION = `${ORIGIN}/api/auth/get-session`;
const SESSION_COOKIE = "better-auth.session_token";

const APP_ID = "cli_fsl124_app";
const KEY = new Uint8Array(randomBytes(32));
const USER_ID = "fsl124-user";
const USER_EMAIL = "alice@example.com";
const OPEN_ID = "ou_fsl124_alice";
const CODE = "A2B3C4D5";

let isolated: IsolatedPostgres;
let database: DatabaseClient;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The identity HMAC of the plan, computed independently of `verify.ts`. */
function expectedOpenIdHmac(openId: string): string {
  return createHmac("sha256", KEY).update(`feishu-identity:v1:${APP_ID}:${openId}`, "utf8").digest("hex");
}

function buildAuth(withVerify = true) {
  return createAuth({
    appName: "megaui-test",
    secret: "test-secret-at-least-32-characters-long",
    baseURL: ORIGIN,
    db: database.db,
    email: { sendVerificationEmail: vi.fn(), sendResetPasswordEmail: vi.fn() } as never,
    nodeEnv: "test",
    feishuLogin: {
      issue: { reserve: async () => undefined, deliver: async () => undefined },
      ...(withVerify ? { verify: { pool: database.pool, appId: APP_ID, otpHmacKey: KEY } } : {}),
    },
  });
}

type Auth = ReturnType<typeof buildAuth>;

function newFlow(): string {
  return randomBytes(32).toString("base64url");
}

async function verify(auth: Auth, body: unknown, flow?: string, contentType = "application/json"): Promise<Response> {
  const headers: Record<string, string> = { "content-type": contentType, origin: ORIGIN };
  if (flow !== undefined) headers.cookie = `${FEISHU_LOGIN_FLOW_COOKIE}=${flow}`;
  return auth.handler(new Request(URL_VERIFY, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

/** Reserves and activates a code for `flow` through the issue store, as the issue service does. */
async function activeCode(flow: string, code = CODE, openId = OPEN_ID): Promise<string> {
  const store = createFeishuLoginCodeStore(database.pool);
  const emailHmac = feishuLoginEmailHmac(KEY, USER_EMAIL);
  // The cooldown counts every row of the email; earlier cases' rows are moved out of it.
  await database.pool.query("update feishu_login_codes set created_at = created_at - interval '1 hour'");
  const reserved = await store.reserve({ flowHash: sha256Hex(flow), emailHmac });
  if (reserved.kind !== "reserved") throw new Error(`reserve: ${reserved.kind}`);
  const activated = await store.activate({
    id: reserved.id,
    emailHmac,
    email: USER_EMAIL,
    openId,
    displayName: "Alice",
    codeHmac: feishuLoginCodeHmac(KEY, reserved.id, code),
  });
  if (activated.kind !== "active") throw new Error(`activate: ${activated.kind}`);
  return reserved.id;
}

interface CodeRow {
  state: string;
  email: string | null;
  open_id: string | null;
  display_name: string | null;
  code_hmac: string | null;
}

async function failedAttempts(id: string): Promise<number> {
  return (await database.pool.query<{ failed_attempts: number }>(
    "select failed_attempts from feishu_login_codes where id = $1",
    [id],
  )).rows[0]!.failed_attempts;
}

async function codeRow(id: string): Promise<CodeRow> {
  return (await database.pool.query<CodeRow>(
    "select state, email, open_id, display_name, code_hmac from feishu_login_codes where id = $1",
    [id],
  )).rows[0]!;
}

function sessionCookie(response: Response): string | undefined {
  const line = response.headers.getSetCookie().find(entry => entry.startsWith(`${SESSION_COOKIE}=`));
  return line?.split(";")[0];
}

async function sessionRows(): Promise<Array<Record<string, unknown>>> {
  return (await database.pool.query(
    "select id, user_id, expires_at from session order by created_at",
  )).rows;
}

describe("feishu login verify (FSL-124 success path, FSL-151 failure path and concurrency)", () => {
  let auth: Auth;

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    database = createDatabaseClient({ connectionString: isolated.databaseUrl, max: 10, onPoolError: () => {} });
  }, 120_000);

  beforeEach(async () => {
    await database.pool.query(`delete from feishu_login_sessions; delete from session; delete from feishu_identities;
      delete from feishu_login_codes; delete from "user"`);
    await database.pool.query(
      `insert into "user" (id, name, email, email_verified) values ($1, 'Alice', $2, true)`,
      [USER_ID, USER_EMAIL],
    );
    await database.pool.query(
      "insert into feishu_identities (app_id, open_id_hmac, user_id) values ($1, $2, $3)",
      [APP_ID, expectedOpenIdHmac(OPEN_ID), USER_ID],
    );
    auth = buildAuth();
    await auth.$context;
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
    if (errors.length) throw new AggregateError(errors, "FSL-124 cleanup failed");
  }, 120_000);

  it("derives open_id_hmac as HMAC-SHA256(key, \"feishu-identity:v1:\" + app_id + \":\" + open_id)", () => {
    expect(feishuLoginOpenIdHmac(KEY, APP_ID, OPEN_ID)).toBe(expectedOpenIdHmac(OPEN_ID));
    expect(feishuLoginOpenIdHmac(KEY, APP_ID, OPEN_ID)).toMatch(/^[0-9a-f]{64}$/);
    expect(feishuLoginOpenIdHmac(KEY, "cli_other", OPEN_ID)).not.toBe(expectedOpenIdHmac(OPEN_ID));
  });

  it("AC1: answers 200 for the correct code of a member with a binding", async () => {
    const flow = newFlow();
    await activeCode(flow);
    const response = await verify(auth, { code: CODE }, flow);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("AC2: sets the Better Auth session cookie of the bound user", async () => {
    const flow = newFlow();
    await activeCode(flow);
    const response = await verify(auth, { code: CODE }, flow);
    expect(response.status).toBe(200);
    const cookie = sessionCookie(response);
    expect(cookie).toBeDefined();
    const line = response.headers.getSetCookie().find(entry => entry.startsWith(`${SESSION_COOKIE}=`))!.toLowerCase();
    expect(line).toContain("httponly");
    expect(line).toContain(`max-age=${FEISHU_LOGIN_SESSION_TTL_SECONDS}`);

    const session = await auth.handler(new Request(URL_SESSION, { headers: { cookie: cookie!, origin: ORIGIN } }));
    expect(session.status).toBe(200);
    const body = await session.json() as { user?: { id?: string }; session?: { userId?: string } } | null;
    expect(body?.user?.id).toBe(USER_ID);
    expect(body?.session?.userId).toBe(USER_ID);
  });

  it("AC3: records the issued session in feishu_login_sessions", async () => {
    const flow = newFlow();
    await activeCode(flow);
    expect((await verify(auth, { code: CODE }, flow)).status).toBe(200);
    const sessions = await sessionRows();
    expect(sessions).toHaveLength(1);
    const marks = (await database.pool.query<{ session_id: string }>("select session_id from feishu_login_sessions")).rows;
    expect(marks).toEqual([{ session_id: sessions[0]!.id }]);
  });

  it("AC4: issues an eight-hour session without any enterprise field", async () => {
    const flow = newFlow();
    await activeCode(flow);
    const before = Date.now();
    expect((await verify(auth, { code: CODE }, flow)).status).toBe(200);
    const after = Date.now();
    const [session] = await sessionRows();
    expect(session).toMatchObject({ user_id: USER_ID });
    // FSL-168 dropped the four enterprise session columns: the issued row cannot carry any of them.
    const columns = (await database.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'session' order by column_name`,
    )).rows.map(row => row.column_name);
    expect(columns).toEqual(["created_at", "expires_at", "id", "impersonated_by", "ip_address", "token",
      "updated_at", "user_agent", "user_id"]);
    expect(columns.filter(name => name.startsWith("enterprise") || name.startsWith("auth"))).toEqual([]);
    const expiresAt = new Date(session!.expires_at as string).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + FEISHU_LOGIN_SESSION_TTL_SECONDS * 1000 - 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + FEISHU_LOGIN_SESSION_TTL_SECONDS * 1000 + 1000);
  });

  it("consumes the code and clears its hold on success", async () => {
    const flow = newFlow();
    const id = await activeCode(flow);
    expect((await verify(auth, { code: CODE }, flow)).status).toBe(200);
    expect(await codeRow(id)).toEqual({ state: "consumed", email: null, open_id: null, display_name: null, code_hmac: null });
  });

  it("accepts the code with surrounding blanks and in lower case", async () => {
    const flow = newFlow();
    await activeCode(flow);
    expect((await verify(auth, { code: ` ${CODE.toLowerCase()} ` }, flow)).status).toBe(200);
  });

  it("AC7: answers 401 invalid when the consumed code is submitted again", async () => {
    const flow = newFlow();
    await activeCode(flow);
    expect((await verify(auth, { code: CODE }, flow)).status).toBe(200);
    const again = await verify(auth, { code: CODE }, flow);
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ status: "invalid" });
    expect(sessionCookie(again)).toBeUndefined();
    expect(await sessionRows()).toHaveLength(1);
  });

  const WRONG = "Z9Y8X7W6";

  /** The response is the one 401 of every verify failure, and it issues no session. */
  async function expectInvalid(response: Response): Promise<void> {
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ status: "invalid" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(sessionCookie(response)).toBeUndefined();
  }

  it("FSL-151 AC1: a wrong code answers 401 { status: invalid } and leaves the row active", async () => {
    const flow = newFlow();
    const id = await activeCode(flow);
    await expectInvalid(await verify(auth, { code: WRONG }, flow));
    expect((await codeRow(id)).state).toBe("active");
    expect(await sessionRows()).toHaveLength(0);
  });

  it("FSL-151 AC2: a wrong code adds one to the row's failed_attempts", async () => {
    const flow = newFlow();
    const id = await activeCode(flow);
    expect(await failedAttempts(id)).toBe(0);
    await expectInvalid(await verify(auth, { code: WRONG }, flow));
    expect(await failedAttempts(id)).toBe(1);
    await expectInvalid(await verify(auth, { code: WRONG }, flow));
    expect(await failedAttempts(id)).toBe(2);
  });

  it("FSL-151 AC3: the row turns void with its hold cleared after the fifth wrong code", async () => {
    const flow = newFlow();
    const id = await activeCode(flow);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expectInvalid(await verify(auth, { code: WRONG }, flow));
      expect((await codeRow(id)).state, `attempt ${attempt}`).toBe("active");
    }
    await expectInvalid(await verify(auth, { code: WRONG }, flow));
    expect(await codeRow(id)).toEqual({ state: "void", email: null, open_id: null, display_name: null, code_hmac: null });
    expect(await failedAttempts(id)).toBe(5);
  });

  it("FSL-151 AC4: the correct code after the fifth wrong code answers 401", async () => {
    const flow = newFlow();
    const id = await activeCode(flow);
    for (let attempt = 1; attempt <= 5; attempt += 1) await expectInvalid(await verify(auth, { code: WRONG }, flow));
    await expectInvalid(await verify(auth, { code: CODE }, flow));
    expect((await codeRow(id)).state).toBe("void");
    expect(await failedAttempts(id)).toBe(5);
    expect(await sessionRows()).toHaveLength(0);
  });

  it("FSL-151 AC5: an expired code answers 401 and the row is neither consumed nor counted", async () => {
    const flow = newFlow();
    const id = await activeCode(flow);
    await database.pool.query(
      "update feishu_login_codes set expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [id],
    );
    await expectInvalid(await verify(auth, { code: CODE }, flow));
    await expectInvalid(await verify(auth, { code: WRONG }, flow));
    expect((await codeRow(id)).state).toBe("active");
    expect(await failedAttempts(id)).toBe(0);
    expect(await sessionRows()).toHaveLength(0);
  });

  it("FSL-151 AC6: a request without a flow cookie answers 401 and touches no row", async () => {
    const flow = newFlow();
    const id = await activeCode(flow);
    await expectInvalid(await verify(auth, { code: CODE }));
    await expectInvalid(await verify(auth, { code: WRONG }));
    expect((await codeRow(id)).state).toBe("active");
    expect(await failedAttempts(id)).toBe(0);
    expect(await sessionRows()).toHaveLength(0);
  });

  it("FSL-151 AC7: of two concurrent requests with the same correct code exactly one answers 200", async () => {
    const flow = newFlow();
    const id = await activeCode(flow);
    const responses = await Promise.all([verify(auth, { code: CODE }, flow), verify(auth, { code: CODE }, flow)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    const loser = responses.find((response) => response.status === 401)!;
    await expectInvalid(loser);
    expect(await sessionRows()).toHaveLength(1);
    expect((await codeRow(id)).state).toBe("consumed");
    expect(await failedAttempts(id)).toBe(0);
  });

  it("answers the same 401 without a flow cookie and for a flow without a code", async () => {
    await activeCode(newFlow());
    for (const flow of [undefined, newFlow()]) {
      const response = await verify(auth, { code: CODE }, flow);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ status: "invalid" });
    }
    expect(await sessionRows()).toHaveLength(0);
  });

  it("answers 409 account_conflict for a member without a binding whose email the preset user holds, consuming the code (FSL-152)", async () => {
    const flow = newFlow();
    const id = await activeCode(flow, CODE, "ou_fsl124_unbound");
    const response = await verify(auth, { code: CODE }, flow);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "account_conflict" });
    expect((await codeRow(id)).state).toBe("consumed");
    expect(await sessionRows()).toHaveLength(0);
    expect((await database.pool.query("select count(*)::int as n from \"user\"")).rows[0]!.n).toBe(1);
  });

  it("answers 400 INVALID_INPUT for a malformed body before reading any row", async () => {
    const flow = newFlow();
    const id = await activeCode(flow);
    const cases: Array<[unknown, string?]> = [
      [{}],
      [{ code: CODE, extra: 1 }],
      [{ code: 12345678 }],
      [{ code: "A2B3C4D" }],
      [{ code: "A2B3C4D5E" }],
      [{ code: "A2B3C4D1" }],
      ["not json"],
      [JSON.stringify({ code: CODE }) + " ".repeat(4096)],
      [{ code: CODE }, "text/plain"],
    ];
    for (const [body, contentType] of cases) {
      const response = await verify(auth, body, flow, contentType);
      expect(response.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(await response.json()).toEqual({ code: "INVALID_INPUT" });
    }
    expect((await codeRow(id)).state).toBe("active");
    expect(await sessionRows()).toHaveLength(0);
  });

  it("is registered only with the verify option and leaves the request endpoint unchanged", async () => {
    const withoutVerify = buildAuth(false);
    const flow = newFlow();
    await activeCode(flow);
    expect((await verify(withoutVerify, { code: CODE }, flow)).status).toBe(404);
    const request = await auth.handler(new Request(URL_REQUEST, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: USER_EMAIL }),
    }));
    expect(request.status).toBe(202);
  });

  it("refuses a verify option without a 32-byte key or an app id", () => {
    expect(() => createAuth({
      appName: "megaui-test",
      secret: "test-secret-at-least-32-characters-long",
      baseURL: ORIGIN,
      db: database.db,
      email: {} as never,
      feishuLogin: { issue: { reserve: async () => undefined, deliver: async () => undefined }, verify: { pool: database.pool, appId: APP_ID, otpHmacKey: new Uint8Array(16) } },
    })).toThrow("INVALID_FEISHU_LOGIN_PLUGIN_CONFIG");
    expect(() => createAuth({
      appName: "megaui-test",
      secret: "test-secret-at-least-32-characters-long",
      baseURL: ORIGIN,
      db: database.db,
      email: {} as never,
      feishuLogin: { issue: { reserve: async () => undefined, deliver: async () => undefined }, verify: { pool: database.pool, appId: " ", otpHmacKey: KEY } },
    })).toThrow("INVALID_FEISHU_LOGIN_PLUGIN_CONFIG");
  });
});
