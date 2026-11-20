// FSL-161: the consistency check of `ENTERPRISE_OTP_HMAC_KEY` and `FEISHU_APP_ID` against the
// fingerprint of `feishu_login_key_check` (FSL-159). Driven through the real `createAuth` handler
// against a one-shot PostgreSQL; the issue ports reserve through the issue store and mock the
// Feishu side (a directory mapping each email to the member's open_id, and the direct message).
import { createHash, createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDatabaseClient,
  createFeishuLoginCodeStore,
  ensureKeyCheck,
  feishuLoginCodeHmac,
  feishuLoginEmailHmac,
  feishuLoginKeyFingerprint,
  type DatabaseClient,
} from "@megaui/database";
import { createIsolatedPostgres, isDockerAvailable, type IsolatedPostgres } from "@megaui/database/test-support";
import { createAuth } from "../create-auth";
import { FEISHU_LOGIN_FLOW_COOKIE } from "./cookie";
import { FEISHU_LOGIN_REQUEST_PATH, FEISHU_LOGIN_VERIFY_PATH } from "./plugin";
import { FEISHU_LOGIN_KEY_MISMATCH } from "./request";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error("[@megaui/auth] feishu-login/key-check.test.ts: a docker daemon is required (the fixture owns its own Postgres).");
}

const ORIGIN = "http://127.0.0.1:3000";
const URL_REQUEST = `${ORIGIN}/api/auth${FEISHU_LOGIN_REQUEST_PATH}`;
const URL_VERIFY = `${ORIGIN}/api/auth${FEISHU_LOGIN_VERIFY_PATH}`;
const SESSION_COOKIE = "better-auth.session_token";

const APP_ID = "cli_fsl161_app";
const NEW_APP_ID = "cli_fsl161_other_app";
const KEY = new Uint8Array(randomBytes(32));
const NEW_KEY = new Uint8Array(randomBytes(32));
const EMAIL = "li.si@example.com";
const NEW_EMAIL = "lisi@corp.example.com";
const UNKNOWN_EMAIL = "nobody@example.com";
const OPEN_ID = "ou_fsl161_lisi";
const NAME = "李四 Li Si";
const CODE = "A2B3C4D5";

let isolated: IsolatedPostgres;
let database: DatabaseClient;

interface Config {
  readonly key: Uint8Array;
  readonly appId: string;
}

const ORIGINAL: Config = { key: KEY, appId: APP_ID };

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The fingerprint of the plan (FSL-159), computed independently of the store. */
function expectedFingerprint(config: Config): string {
  return createHmac("sha256", config.key).update(`feishu-login-key-check:v1:${config.appId}`, "utf8").digest("hex");
}

function newFlow(): string {
  return randomBytes(32).toString("base64url");
}

/** The mocked Feishu directory: which member an email belongs to. */
const directory = new Map<string, string>();

interface MockReservation {
  readonly config: Config;
  readonly email: string;
  readonly emailHmac: string;
  readonly result: Awaited<ReturnType<ReturnType<typeof createFeishuLoginCodeStore>["reserve"]>>;
}

/** The issue ports of one configuration: `reserve` is the issue store's, `deliver` mocks Feishu. */
function mockIssue(config: Config) {
  const deliveries: Promise<unknown>[] = [];
  const reserve = vi.fn(async ({ flowHash, email }: { readonly flowHash: string; readonly email: string }) => {
    const emailHmac = feishuLoginEmailHmac(config.key, email);
    const result = await createFeishuLoginCodeStore(database.pool).reserve({ flowHash, emailHmac });
    return { config, email, emailHmac, result } satisfies MockReservation;
  });
  const deliver = vi.fn((reservation: unknown) => {
    const run = (async () => {
      const { email, emailHmac, result } = reservation as MockReservation;
      const openId = directory.get(email);
      if (result.kind !== "reserved" || openId === undefined) return;
      await createFeishuLoginCodeStore(database.pool).activate({
        id: result.id,
        emailHmac,
        email,
        openId,
        displayName: NAME,
        codeHmac: feishuLoginCodeHmac(config.key, result.id, CODE),
      });
    })();
    deliveries.push(run);
    return run;
  });
  return { reserve, deliver, deliveries };
}

function buildAuth(
  config: Config,
  options: { readonly pool?: DatabaseClient["pool"]; readonly nodeEnv?: string; readonly reserveFails?: boolean } = {},
) {
  const log = vi.fn();
  const issue = mockIssue(config);
  if (options.reserveFails) issue.reserve.mockRejectedValue(new Error("reserve failed"));
  const auth = createAuth({
    appName: "megaui-test",
    secret: "test-secret-at-least-32-characters-long",
    baseURL: ORIGIN,
    db: database.db,
    email: { sendVerificationEmail: vi.fn(), sendResetPasswordEmail: vi.fn() } as never,
    nodeEnv: options.nodeEnv ?? "test",
    feishuLogin: {
      issue: { reserve: issue.reserve, deliver: issue.deliver },
      log,
      verify: { pool: options.pool ?? database.pool, appId: config.appId, otpHmacKey: config.key, log },
    },
  });
  return { auth, log, issue };
}

type Built = ReturnType<typeof buildAuth>;

async function request(built: Built, body: unknown, flow?: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN, ...extraHeaders };
  if (flow !== undefined) headers.cookie = `${FEISHU_LOGIN_FLOW_COOKIE}=${flow}`;
  return built.auth.handler(new Request(URL_REQUEST, { method: "POST", headers, body: JSON.stringify(body) }));
}

/** Waits until every `deliver` scheduled so far has run. */
async function delivered(built: Built): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await Promise.all(built.issue.deliveries);
}

async function verify(built: Built, body: unknown, flow: string): Promise<Response> {
  return built.auth.handler(new Request(URL_VERIFY, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie: `${FEISHU_LOGIN_FLOW_COOKIE}=${flow}` },
    body: JSON.stringify(body),
  }));
}

/** Reserves and activates a code for `flow` directly through the issue store, as `config` would issue it. */
async function activeCode(config: Config, flow: string, email: string): Promise<string> {
  const store = createFeishuLoginCodeStore(database.pool);
  const emailHmac = feishuLoginEmailHmac(config.key, email);
  await database.pool.query("update feishu_login_codes set created_at = created_at - interval '1 hour'");
  const reserved = await store.reserve({ flowHash: sha256Hex(flow), emailHmac });
  if (reserved.kind !== "reserved") throw new Error(`reserve: ${reserved.kind}`);
  const activated = await store.activate({
    id: reserved.id,
    emailHmac,
    email,
    openId: OPEN_ID,
    displayName: NAME,
    codeHmac: feishuLoginCodeHmac(config.key, reserved.id, CODE),
  });
  if (activated.kind !== "active") throw new Error(`activate: ${activated.kind}`);
  return reserved.id;
}

async function storedFingerprints(): Promise<{ id: number; key_check: string }[]> {
  return (await database.pool.query<{ id: number; key_check: string }>("select id, key_check from feishu_login_key_check")).rows;
}

async function storeFingerprint(config: Config): Promise<void> {
  await database.pool.query("insert into feishu_login_key_check (id, key_check) values (1, $1)", [expectedFingerprint(config)]);
}

async function count(table: string): Promise<number> {
  return (await database.pool.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;
}

interface CodeRow {
  state: string;
  failed_attempts: number;
  email: string | null;
  open_id: string | null;
  display_name: string | null;
  code_hmac: string | null;
}

async function codeRow(id: string): Promise<CodeRow> {
  return (await database.pool.query<CodeRow>(
    "select state, failed_attempts, email, open_id, display_name, code_hmac from feishu_login_codes where id = $1",
    [id],
  )).rows[0]!;
}

function hasSessionCookie(response: Response): boolean {
  return (response.headers.get("set-cookie") ?? "").includes(SESSION_COOKIE);
}

describe("feishu login key consistency check (FSL-161)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    database = createDatabaseClient({ connectionString: isolated.databaseUrl, max: 10, onPoolError: () => {} });
  }, 120_000);

  beforeEach(async () => {
    await database.pool.query(`delete from feishu_login_sessions; delete from session; delete from feishu_identities;
      delete from feishu_login_codes; delete from "user"; delete from feishu_login_key_check`);
    directory.clear();
    directory.set(EMAIL, OPEN_ID);
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
    if (errors.length) throw new AggregateError(errors, "FSL-161 cleanup failed");
  }, 120_000);

  describe("the store's ensureKeyCheck", () => {
    it("computes the fingerprint of the plan and stores it once, never overwriting it", async () => {
      expect(feishuLoginKeyFingerprint(KEY, APP_ID)).toBe(expectedFingerprint(ORIGINAL));
      const first = expectedFingerprint(ORIGINAL);
      const other = expectedFingerprint({ key: NEW_KEY, appId: APP_ID });
      expect(await ensureKeyCheck(database.pool, first)).toBe(first);
      expect(await ensureKeyCheck(database.pool, other)).toBe(first);
      expect(await storedFingerprints()).toEqual([{ id: 1, key_check: first }]);
    });

    it("rejects a value that is not 64 lowercase hex characters without writing", async () => {
      await expect(ensureKeyCheck(database.pool, "A".repeat(64))).rejects.toThrow("INVALID_FEISHU_LOGIN_KEY_CHECK");
      await expect(ensureKeyCheck(database.pool, Buffer.from(KEY).toString("hex").slice(0, 63))).rejects.toThrow("INVALID_FEISHU_LOGIN_KEY_CHECK");
      expect(await storedFingerprints()).toEqual([]);
    });

    it("concurrent first checks all return the one value that was stored", async () => {
      for (let round = 0; round < 5; round += 1) {
        await database.pool.query("delete from feishu_login_key_check");
        const values = Array.from({ length: 8 }, () => randomBytes(32).toString("hex"));
        const results = await Promise.all(values.map(value => ensureKeyCheck(database.pool, value)));
        const stored = await storedFingerprints();
        expect(stored).toHaveLength(1);
        expect(values).toContain(stored[0]!.key_check);
        expect(new Set(results)).toEqual(new Set([stored[0]!.key_check]));
      }
    });
  });

  it("AC1: the first check stores the fingerprint of the current key and app ID, not the key", async () => {
    const built = buildAuth(ORIGINAL);
    expect(await storedFingerprints()).toEqual([]);
    const response = await request(built, { email: EMAIL });
    expect(response.status).toBe(202);
    const stored = await storedFingerprints();
    expect(stored).toEqual([{ id: 1, key_check: expectedFingerprint(ORIGINAL) }]);
    const keyHex = Buffer.from(KEY).toString("hex");
    expect(stored[0]!.key_check).not.toBe(keyHex);
    expect(stored[0]!.key_check).not.toContain(keyHex);
    expect(stored[0]!.key_check).not.toContain(Buffer.from(KEY).toString("base64"));
    expect(built.log).not.toHaveBeenCalled();
  });

  it("AC1: a verify that comes first stores the fingerprint too", async () => {
    const built = buildAuth(ORIGINAL);
    const response = await verify(built, { code: CODE }, newFlow());
    expect(response.status).toBe(401);
    expect(await storedFingerprints()).toEqual([{ id: 1, key_check: expectedFingerprint(ORIGINAL) }]);
  });

  it("AC2: with a matching fingerprint the request answers 202 and reserves", async () => {
    await storeFingerprint(ORIGINAL);
    const built = buildAuth(ORIGINAL);
    const response = await request(built, { email: EMAIL });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(response.headers.get("set-cookie")).toContain(`${FEISHU_LOGIN_FLOW_COOKIE}=`);
    expect(built.issue.reserve).toHaveBeenCalledTimes(1);
    expect(await count("feishu_login_codes")).toBe(1);
    expect(built.log).not.toHaveBeenCalled();
  });

  for (const [label, stored] of [
    ["another key", { key: NEW_KEY, appId: APP_ID }],
    ["another app ID", { key: KEY, appId: NEW_APP_ID }],
  ] as const) {
    it(`AC3/AC4: a fingerprint of ${label} answers every request 503 unavailable and reserves nothing`, async () => {
      await storeFingerprint(stored);
      const built = buildAuth(ORIGINAL);
      const flow = newFlow();
      const answers: { status: number; body: unknown; cookie: string | null }[] = [];
      for (const [email, cookieFlow] of [[EMAIL, undefined], [UNKNOWN_EMAIL, undefined], [EMAIL, flow]] as const) {
        const response = await request(built, { email }, cookieFlow);
        answers.push({ status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") });
      }
      for (const answer of answers) {
        expect(answer).toEqual({ status: 503, body: { status: "unavailable" }, cookie: null });
      }
      await delivered(built);
      expect(built.issue.reserve).not.toHaveBeenCalled();
      expect(built.issue.deliver).not.toHaveBeenCalled();
      expect(await count("feishu_login_codes")).toBe(0);
      expect(built.log.mock.calls).toEqual([[FEISHU_LOGIN_KEY_MISMATCH], [FEISHU_LOGIN_KEY_MISMATCH], [FEISHU_LOGIN_KEY_MISMATCH]]);
      // The stored fingerprint is never replaced.
      expect(await storedFingerprints()).toEqual([{ id: 1, key_check: expectedFingerprint(stored) }]);
      // Invalid input still answers 400 first (ADR-FSL-11 order).
      expect((await request(built, { email: "not-an-email" })).status).toBe(400);
    });
  }

  it("AC3: the response order is 400, then 429, then 503 unavailable, then 503 retry (ADR-FSL-11)", async () => {
    await storeFingerprint({ key: NEW_KEY, appId: APP_ID });
    // A mismatch together with a failing reservation answers unavailable, never retry.
    const failing = buildAuth(ORIGINAL, { reserveFails: true });
    const unavailable = await request(failing, { email: EMAIL });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: "unavailable" });
    expect(failing.issue.reserve).not.toHaveBeenCalled();
    // Without the mismatch the same failing reservation answers retry.
    await database.pool.query("update feishu_login_key_check set key_check = $1", [expectedFingerprint(ORIGINAL)]);
    const retry = await request(buildAuth(ORIGINAL, { reserveFails: true }), { email: EMAIL });
    expect(retry.status).toBe(503);
    expect(await retry.json()).toEqual({ status: "retry" });

    // Under the production limit with a mismatch: unavailable until the address is limited, then
    // 429; invalid input still answers 400.
    await database.pool.query("update feishu_login_key_check set key_check = $1", [expectedFingerprint({ key: NEW_KEY, appId: APP_ID })]);
    const limitedAuth = buildAuth(ORIGINAL, { nodeEnv: "production" });
    const address = { "x-forwarded-for": "198.51.100.61" };
    let limited: Response | undefined;
    for (let attempt = 0; attempt < 500 && !limited; attempt += 1) {
      const response = await request(limitedAuth, { email: EMAIL }, undefined, address);
      if (response.status === 429) limited = response;
      else expect(await response.json()).toEqual({ status: "unavailable" });
    }
    expect(limited?.status).toBe(429);
    expect((await request(limitedAuth, { email: "not-an-email" }, undefined, address)).status).toBe(400);
    expect(limitedAuth.issue.reserve).not.toHaveBeenCalled();
  });

  it("AC3/AC4: a check that fails answers 503 unavailable and reserves nothing", async () => {
    const unreachable = createDatabaseClient({
      connectionString: "postgres://unused:unused@127.0.0.1:1/unused",
      max: 1,
      onPoolError: () => {},
    });
    try {
      const built = buildAuth(ORIGINAL, { pool: unreachable.pool });
      const response = await request(built, { email: EMAIL });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable" });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(built.issue.reserve).not.toHaveBeenCalled();
      expect(built.log.mock.calls).toEqual([[FEISHU_LOGIN_KEY_MISMATCH]]);
      const verified = await verify(built, { code: CODE }, newFlow());
      expect(verified.status).toBe(503);
      expect(await verified.json()).toEqual({ status: "unavailable" });
    } finally {
      await unreachable.close();
    }
  });

  for (const [label, changed] of [
    ["a new key", { key: NEW_KEY, appId: APP_ID }],
    ["a new app ID", { key: KEY, appId: NEW_APP_ID }],
  ] as const) {
    it(`AC5/AC6: after ${label}, verify answers 503 unavailable and leaves the code unconsumed`, async () => {
      await storeFingerprint(ORIGINAL);
      const flow = newFlow();
      // The code row as the changed configuration would issue it: without the check, a new app ID
      // would consume it (and create a user), a new key would count a failed attempt.
      const id = await activeCode(changed, flow, EMAIL);
      const before = await codeRow(id);
      const built = buildAuth(changed);
      for (const body of [{ code: CODE }, { code: "Z9Y8X7W6" }]) {
        const response = await verify(built, body, flow);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ status: "unavailable" });
        expect(hasSessionCookie(response)).toBe(false);
      }
      expect(await codeRow(id)).toEqual(before);
      expect(before.state).toBe("active");
      expect(before.failed_attempts).toBe(0);
      expect(await count(`"user"`)).toBe(0);
      expect(await count("feishu_identities")).toBe(0);
      expect(await count("session")).toBe(0);
      expect(built.log.mock.calls).toEqual([[FEISHU_LOGIN_KEY_MISMATCH], [FEISHU_LOGIN_KEY_MISMATCH]]);
      // A malformed body still answers 400 first.
      expect((await verify(built, { code: "short" }, flow)).status).toBe(400);
    });
  }

  it("keeps a consistent result in the instance; a mismatch is checked again on every call", async () => {
    const built = buildAuth(ORIGINAL);
    expect((await request(built, { email: EMAIL })).status).toBe(202);
    await database.pool.query("update feishu_login_key_check set key_check = $1", [expectedFingerprint({ key: NEW_KEY, appId: APP_ID })]);
    await database.pool.query("update feishu_login_codes set created_at = created_at - interval '1 hour'");
    // The consistent result of this instance is kept: no further check runs.
    expect((await request(built, { email: EMAIL })).status).toBe(202);
    // A new instance (a restart) checks again and sees the mismatch.
    const restarted = buildAuth(ORIGINAL);
    expect((await request(restarted, { email: EMAIL })).status).toBe(503);
    // A mismatch is not kept: once the stored value matches, the same instance answers 202.
    await database.pool.query("update feishu_login_key_check set key_check = $1", [expectedFingerprint(ORIGINAL)]);
    expect((await request(restarted, { email: EMAIL })).status).toBe(202);
  });

  for (const [label, changed] of [
    ["the key", { key: NEW_KEY, appId: APP_ID }],
    ["FEISHU_APP_ID", { key: KEY, appId: NEW_APP_ID }],
  ] as const) {
    it(`AC7: after ${label} changes, a member whose email changed logs in again without a second user`, async () => {
      // First login under the original configuration: one user and its binding.
      const original = buildAuth(ORIGINAL);
      const flow = newFlow();
      expect((await request(original, { email: EMAIL }, flow)).status).toBe(202);
      await delivered(original);
      const first = await verify(original, { code: CODE }, flow);
      expect(first.status).toBe(200);
      expect(await count(`"user"`)).toBe(1);
      expect(await count("feishu_identities")).toBe(1);
      const sessions = await count("session");

      // The configuration changes and the directory now gives the member another email.
      directory.delete(EMAIL);
      directory.set(NEW_EMAIL, OPEN_ID);
      const changedAuth = buildAuth(changed);
      const secondFlow = newFlow();
      const requested = await request(changedAuth, { email: NEW_EMAIL }, secondFlow);
      expect(requested.status).toBe(503);
      expect(await requested.json()).toEqual({ status: "unavailable" });
      await delivered(changedAuth);
      expect(changedAuth.issue.reserve).not.toHaveBeenCalled();

      // Even a code issued under the changed configuration (as a deployment without the check
      // would have issued it) is refused before it is read.
      const thirdFlow = newFlow();
      const id = await activeCode(changed, thirdFlow, NEW_EMAIL);
      const verified = await verify(changedAuth, { code: CODE }, thirdFlow);
      expect(verified.status).toBe(503);
      expect(await verified.json()).toEqual({ status: "unavailable" });
      expect(hasSessionCookie(verified)).toBe(false);
      expect((await codeRow(id)).state).toBe("active");
      expect(await count(`"user"`)).toBe(1);
      expect(await count("feishu_identities")).toBe(1);
      expect(await count("session")).toBe(sessions);

      // Control: the same code with the check bypassed (the fingerprint removed, which the
      // documentation forbids) would create a second user for the same member.
      await database.pool.query("delete from feishu_login_key_check");
      const bypassed = await verify(changedAuth, { code: CODE }, thirdFlow);
      expect(bypassed.status).toBe(200);
      expect(await count(`"user"`)).toBe(2);
    });
  }
});
