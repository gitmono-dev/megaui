// megaui-only (FSL-122, FSL-149): the issue main flow, its state checks and its send outcomes against a
// one-shot PostgreSQL and a real Feishu Mock process.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { admitProvider, type ProviderTarget } from "@megaui/core";
import {
  createFeishuLoginCodeStore,
  FEISHU_LOGIN_EMAIL_LOCK_CLASS,
  feishuLoginCodeHmac,
  feishuLoginEmailHmac,
  feishuLoginEmailLockKey,
} from "@megaui/database";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { FEISHU_MESSAGE_PATH } from "../enterprise/feishu/message";
import {
  createFeishuLoginIssuer,
  feishuLoginTenantKey,
  FEISHU_LOGIN_INACTIVE,
  FEISHU_LOGIN_NO_TARGET,
  FEISHU_LOGIN_PROVIDER_FAILED,
  FEISHU_LOGIN_SEND_ATTEMPT,
  FEISHU_LOGIN_SEND_REJECTED,
  FEISHU_LOGIN_SEND_UNKNOWN,
  type FeishuLoginIssueLogKey,
  type FeishuLoginIssuer,
} from "./issue";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

const ALICE = { email: "alice@example.com", openId: "ou_mock_alice", name: "Mock Alice" };
const DAVE = { email: "dave@corp.example.com", openId: "ou_mock_dave" };
const SHARED = "shared@corp.example.com";
const UNKNOWN = "nobody@example.com";
const SITE = "https://megaui.example.test";

interface MockRuntime {
  baseUrl: string;
  appId: string;
  appSecret: string;
  adminToken: string;
}

interface InboxEntry {
  messageId: string;
  receiveId: string;
  msgType: string;
  content: string;
}

interface CodeRow {
  id: string;
  flow_hash: string;
  email_hmac: string;
  state: string;
  email: string | null;
  open_id: string | null;
  display_name: string | null;
  code_hmac: string | null;
}

const flowHash = () => createHash("sha256").update(randomBytes(32)).digest("hex");

/** The timeout of one HTTP attempt of the service in this suite. */
const ATTEMPT_TIMEOUT_MS = 1_500;
const MESSAGE_PATHNAME = FEISHU_MESSAGE_PATH.slice(0, FEISHU_MESSAGE_PATH.indexOf("?"));
const SEARCH_PATHNAME = "/open-apis/directory/v1/employees/search";
const MGET_PATHNAME = "/open-apis/directory/v1/employees/mget";
const TOKEN_PATHNAME = "/open-apis/auth/v3/tenant_access_token/internal";

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** An optional hold: signal the arrival, then wait for the release before acting. */
interface Hold {
  arrived?: () => void;
  release?: Promise<void>;
}

/**
 * What the recording proxy does with the next request of a path. Without a scripted
 * action it forwards the request to the Mock.
 * - `forward`: forward to the Mock (after the optional hold);
 * - `reply`: answer itself without reaching the Mock (after the optional hold);
 * - `forward_then_hang`: forward to the Mock, so the Mock records the delivery, and never
 *   answer the service: its attempt times out although Feishu took the message;
 * - `forward_then_reply`: forward to the Mock, so the Mock records the delivery, then answer
 *   the service with the given response instead of the Mock's;
 * - `hang`: never forward and never answer: the attempt times out, nothing is delivered.
 */
type ProxyAction =
  | ({ kind: "forward" } & Hold)
  | ({ kind: "reply"; status: number; body: unknown } & Hold)
  | { kind: "forward_then_hang" }
  | { kind: "forward_then_reply"; status: number; body: unknown }
  | { kind: "hang" };

/** HTTP 429: Feishu did not take the request. */
const RATE_LIMITED = { status: 429, body: { code: 99991400, msg: "request trigger frequency limit" } };
/** An explicit business refusal. */
const REFUSED = { status: 400, body: { code: 230002, msg: "the bot can not reach the user" } };

describe("Feishu login code issue main flow with real Mock HTTP and PostgreSQL (FSL-122)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  let child: ChildProcess;
  let receiver: Server;
  /** A recording proxy in front of the Mock; the service only ever talks to it. */
  let proxy: Server;
  let runtimeFile: string;
  let runtime: MockRuntime;
  let target: ProviderTarget;
  let generateCode: () => string;
  /** The process environment of the service: exactly these four keys. */
  let env: Record<"FEISHU_APP_ID" | "FEISHU_APP_SECRET" | "ENTERPRISE_OTP_HMAC_KEY" | "BETTER_AUTH_URL", string>;
  let hmacKey: Uint8Array;

  let logs: FeishuLoginIssueLogKey[];
  let codes: string[];
  /** Message-send requests received on the Mock side (counted by the proxy on arrival). */
  let sendRequests: number;
  /** Every request body the service sent towards the Mock. */
  let sentBodies: string[];
  let issuer: FeishuLoginIssuer;
  /** Scripted proxy actions, by request pathname, consumed in arrival order. */
  let script: Map<string, ProxyAction[]>;
  /** Token requests received by the proxy. */
  let tokenRequests: number;
  /**
   * When set, a forwarded token answer carries this `expire` (seconds). 60 equals the refresh
   * margin of the token manager, so every `getToken` call starts a refresh.
   */
  let tokenExpireOverride: number | undefined;

  function plan(pathname: string, ...actions: ProxyAction[]): void {
    script.set(pathname, [...(script.get(pathname) ?? []), ...actions]);
  }

  const scenario = (name: string, fn: () => Promise<void>) => it(name, fn, 60_000);

  async function control(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(runtime.baseUrl + path, {
      method,
      headers: { authorization: "Bearer " + runtime.adminToken, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
    const result = (await response.json()) as { data: unknown };
    if (!response.ok) throw new Error("mock control request failed");
    return result.data;
  }

  async function inbox(openId: string): Promise<InboxEntry[]> {
    const state = (await control("/__mock/state")) as { inboxes: Record<string, InboxEntry[]> };
    return state.inboxes[openId] ?? [];
  }

  async function allInboxCount(): Promise<number> {
    const state = (await control("/__mock/state")) as { inboxes: Record<string, InboxEntry[]> };
    return Object.values(state.inboxes).reduce((sum, entries) => sum + entries.length, 0);
  }

  async function rows(): Promise<CodeRow[]> {
    return (
      await pool.query<CodeRow>(
        "select id, flow_hash, email_hmac, state, email, open_id, display_name, code_hmac " +
          "from feishu_login_codes order by created_at, email_seq",
      )
    ).rows;
  }

  function textOf(entry: InboxEntry): string {
    return (JSON.parse(entry.content) as { text: string }).text;
  }

  function buildIssuer(): FeishuLoginIssuer {
    return createFeishuLoginIssuer({
      pool,
      appId: env.FEISHU_APP_ID,
      appSecret: env.FEISHU_APP_SECRET,
      otpHmacKey: hmacKey,
      trustedSiteUrl: env.BETTER_AUTH_URL,
      target,
      generateCode: () => {
        const code = generateCode();
        codes.push(code);
        return code;
      },
      log: (key) => logs.push(key),
      attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
      retryBackoffMs: 10,
    });
  }

  async function waitExit(ms: number): Promise<boolean> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off("exit", done);
        resolve(false);
      }, ms);
      child.once("exit", done);
    });
  }

  beforeAll(async () => {
    // The same generator FSL-150 injects. Engine does not depend on `@megaui/auth` (ADR-FSL-11),
    // so only this test borrows the module by its source path. That path lies outside this
    // package's `rootDir` (TS6059); the module is typed by the annotation of `generateCode`.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore TS6059 only: the borrowed module is outside the engine rootDir.
    generateCode = (await import("../../../../auth/src/enterprise-otp/code")).generateEnterpriseOtpCode;
    // Member status writes emit a callback; a local receiver keeps them inside this run.
    receiver = createServer((request, response) => {
      request.resume();
      request.on("end", () => response.end("{}"));
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("missing fixture receiver");
    const callbackUrl = "http://127.0.0.1:" + address.port + "/api/integrations/feishu/events";
    // Frozen CLI protocol only: engine tests never import Mock source.
    child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "apps/feishu-mock/src/index.ts")], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        FEISHU_SIMULATOR_ENABLED: "1",
        FEISHU_SIMULATOR_PORT: "0",
        FEISHU_SIMULATOR_CALLBACK_URL: callbackUrl,
      },
    });
    child.stderr?.resume();
    const ready = await new Promise<{ baseUrl: string; runtimeFile: string }>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("mock startup timeout")), 15_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("mock exited before ready"));
      });
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
        const end = output.indexOf("\n");
        if (end < 0) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(output.slice(0, end)));
        } catch {
          reject(new Error("invalid mock receipt"));
        }
      });
    });
    runtimeFile = ready.runtimeFile;
    runtime = JSON.parse(readFileSync(runtimeFile, "utf8")) as MockRuntime;
    // The receiving side: every request is counted and recorded when it arrives, then
    // forwarded byte for byte to the real Mock; a connection the Mock drops is dropped too.
    const upstream = new URL(runtime.baseUrl);
    // FSL-149: a scripted action can hold a request, answer it itself or let it time out.
    proxy = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = Buffer.concat(chunks);
        if (incoming.url === FEISHU_MESSAGE_PATH) sendRequests += 1;
        if (body.length > 0) sentBodies.push(body.toString("utf8"));
        const pathname = (incoming.url ?? "").split("?")[0]!;
        if (pathname === TOKEN_PATHNAME) tokenRequests += 1;
        const action: ProxyAction = script.get(pathname)?.shift() ?? { kind: "forward" };
        const forward = (hang: boolean, replace?: { status: number; body: unknown }) => {
          const forwarded = httpRequest(
            {
              host: upstream.hostname,
              port: upstream.port,
              method: incoming.method,
              path: incoming.url,
              headers: { ...incoming.headers, host: upstream.host },
            },
            (answer) => {
              if (hang) {
                answer.resume();
                return;
              }
              if (replace) {
                answer.resume();
                answer.on("end", () => {
                  outgoing.writeHead(replace.status, { "content-type": "application/json" });
                  outgoing.end(JSON.stringify(replace.body));
                });
                return;
              }
              if (pathname === TOKEN_PATHNAME && tokenExpireOverride !== undefined) {
                const parts: Buffer[] = [];
                answer.on("data", (chunk: Buffer) => parts.push(chunk));
                answer.on("end", () => {
                  const parsed = JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>;
                  if (typeof parsed.expire === "number") parsed.expire = tokenExpireOverride;
                  outgoing.writeHead(answer.statusCode ?? 502, { "content-type": "application/json" });
                  outgoing.end(JSON.stringify(parsed));
                });
                return;
              }
              outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
              answer.pipe(outgoing);
            },
          );
          forwarded.on("error", () => outgoing.socket?.destroy());
          forwarded.end(body);
        };
        void (async () => {
          if (action.kind === "hang") return;
          if (action.kind === "forward_then_hang") return forward(true);
          if (action.kind === "forward_then_reply") return forward(false, action);
          action.arrived?.();
          await action.release;
          if (action.kind === "forward") return forward(false);
          outgoing.writeHead(action.status, { "content-type": "application/json" });
          outgoing.end(JSON.stringify(action.body));
        })();
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error("missing recording proxy");
    target = admitProvider({
      enabled: true,
      provider: "simulator",
      role: "test",
      nodeEnv: "test",
      simulatorOrigin: "http://127.0.0.1:" + proxyAddress.port,
    })!;
    env = {
      FEISHU_APP_ID: runtime.appId,
      FEISHU_APP_SECRET: runtime.appSecret,
      ENTERPRISE_OTP_HMAC_KEY: randomBytes(32).toString("base64url"),
      BETTER_AUTH_URL: SITE,
    };
    hmacKey = Uint8Array.from(Buffer.from(env.ENTERPRISE_OTP_HMAC_KEY, "base64url"));
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
  }, 120_000);

  beforeEach(async () => {
    await control("/__mock/reset", {});
    await pool.query("truncate feishu_login_codes");
    logs = [];
    codes = [];
    sendRequests = 0;
    sentBodies = [];
    script = new Map();
    tokenRequests = 0;
    tokenExpireOverride = undefined;
    issuer = buildIssuer();
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      if (runtime) await control("/__mock/reset", {});
    } catch (error) {
      errors.push(error);
    }
    try {
      if (proxy) {
        proxy.closeAllConnections();
        await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (receiver) {
        await new Promise<void>((resolve, reject) => receiver.close((error) => (error ? reject(error) : resolve())));
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (!(await waitExit(3000))) {
        child.kill("SIGKILL");
        if (!(await waitExit(3000))) throw new Error("mock did not stop");
      }
      if (runtimeFile && existsSync(runtimeFile)) throw new Error("mock runtime file leaked");
    } catch (error) {
      errors.push(error);
    }
    try {
      await pool?.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      await isolated?.destroy();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "FSL-122 cleanup failed");
  });

  /**
   * Common checks: logs carry stable keys only, attempts match the Mock, the label stays local,
   * and every row that is not active holds no sensitive field (regression check, FSL-149).
   */
  async function expectHygiene(): Promise<void> {
    for (const row of await rows()) {
      if (row.state === "active") continue;
      expect(row).toMatchObject({ email: null, open_id: null, display_name: null, code_hmac: null });
    }
    const sensitive = [ALICE.email, DAVE.email, SHARED, UNKNOWN, ALICE.openId, DAVE.openId, ALICE.name, ...codes];
    for (const entry of logs) {
      for (const value of sensitive) expect(entry.includes(value)).toBe(false);
    }
    const attempts = logs.filter((key) => key === FEISHU_LOGIN_SEND_ATTEMPT).length;
    expect(attempts).toBe(sendRequests);
    // `app:<FEISHU_APP_ID>` is only a token cache key; no request ever carries it.
    for (const body of sentBodies) expect(body.includes(feishuLoginTenantKey(env.FEISHU_APP_ID))).toBe(false);
  }

  scenario("AC1-AC3: a single in-office member gets an active row and exactly one message with the code", async () => {
    const flow = flowHash();
    const result = await issuer.issueFeishuLoginCode({ flowHash: flow, email: "  Alice@Example.com " });
    expect(result).toEqual({ status: "sent", send: "accepted" });

    const stored = await rows();
    expect(stored).toHaveLength(1);
    const [row] = stored;
    // AC1: the row of this request is active and holds the member and the code HMAC.
    expect(row).toMatchObject({
      flow_hash: flow,
      email_hmac: feishuLoginEmailHmac(hmacKey, ALICE.email),
      state: "active",
      email: ALICE.email,
      open_id: ALICE.openId,
      display_name: ALICE.name,
    });
    expect(codes).toHaveLength(1);
    const code = codes[0]!;
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    expect(row!.code_hmac).toBe(feishuLoginCodeHmac(hmacKey, row!.id, code));
    expect(JSON.stringify(stored)).not.toContain(code);

    // AC2: exactly one direct message, to that member.
    const messages = await inbox(ALICE.openId);
    expect(messages).toHaveLength(1);
    expect(await allInboxCount()).toBe(1);
    expect(sendRequests).toBe(1);
    // AC3: the text carries the code and the trusted site.
    expect(textOf(messages[0]!)).toContain(code);
    expect(textOf(messages[0]!)).toContain(SITE);

    expect(logs).toEqual([FEISHU_LOGIN_SEND_ATTEMPT]);
    // The request carried the row id as its stable UUID.
    const send = sentBodies.map((body) => JSON.parse(body) as Record<string, unknown>).find((body) => "receive_id" in body);
    expect(send).toMatchObject({ receive_id: ALICE.openId, msg_type: "text", uuid: row!.id });
    await expectHygiene();
  });

  scenario("AC4: an email without a member sends no message and voids the row", async () => {
    const result = await issuer.issueFeishuLoginCode({ flowHash: flowHash(), email: UNKNOWN });
    expect(result).toEqual({ status: "no_target" });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ state: "void", email: null, open_id: null, display_name: null, code_hmac: null });
    expect(await allInboxCount()).toBe(0);
    expect(sendRequests).toBe(0);
    expect(codes).toHaveLength(0);
    expect(logs).toEqual([FEISHU_LOGIN_NO_TARGET]);
    await expectHygiene();
  });

  scenario("AC5: an email shared by several members sends no message and voids the row", async () => {
    const result = await issuer.issueFeishuLoginCode({ flowHash: flowHash(), email: SHARED });
    expect(result).toEqual({ status: "no_target" });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ state: "void", email: null, open_id: null, display_name: null, code_hmac: null });
    expect(await inbox("ou_mock_erin")).toHaveLength(0);
    expect(await inbox("ou_mock_frank")).toHaveLength(0);
    expect(await allInboxCount()).toBe(0);
    expect(logs).toEqual([FEISHU_LOGIN_NO_TARGET]);
    await expectHygiene();
  });

  scenario("AC6: a member not in office sends no message and voids the row", async () => {
    await control("/__mock/users/" + DAVE.openId, { status: "suspended" }, "PATCH");
    const result = await issuer.issueFeishuLoginCode({ flowHash: flowHash(), email: DAVE.email });
    expect(result).toEqual({ status: "inactive" });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ state: "void", email: null, open_id: null, display_name: null, code_hmac: null });
    expect(await inbox(DAVE.openId)).toHaveLength(0);
    expect(await allInboxCount()).toBe(0);
    expect(codes).toHaveLength(0);
    expect(logs).toEqual([FEISHU_LOGIN_INACTIVE]);
    await expectHygiene();
  });

  scenario("AC7: a new issue voids the active row of the same email in any earlier flow", async () => {
    const first = flowHash();
    const second = flowHash();
    expect(await issuer.issueFeishuLoginCode({ flowHash: first, email: ALICE.email })).toEqual({
      status: "sent",
      send: "accepted",
    });
    expect((await rows()).map((row) => row.state)).toEqual(["active"]);
    expect(await issuer.issueFeishuLoginCode({ flowHash: second, email: ALICE.email })).toEqual({
      status: "sent",
      send: "accepted",
    });

    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      flow_hash: first,
      state: "void",
      email: null,
      open_id: null,
      display_name: null,
      code_hmac: null,
    });
    expect(stored[1]).toMatchObject({ flow_hash: second, state: "active", open_id: ALICE.openId });
    expect(stored[1]!.code_hmac).toBe(feishuLoginCodeHmac(hmacKey, stored[1]!.id, codes[1]!));
    // Both requests sent their own code once; only the newest one is held.
    const messages = await inbox(ALICE.openId);
    expect(messages.map(textOf).map((text) => codes.filter((code) => text.includes(code)))).toEqual([
      [codes[0]],
      [codes[1]],
    ]);
    expect(logs).toEqual([FEISHU_LOGIN_SEND_ATTEMPT, FEISHU_LOGIN_SEND_ATTEMPT]);
    await expectHygiene();
  });

  for (const kind of ["500", "disconnect_after_accept"] as const) {
    scenario(`logs FEISHU_LOGIN_SEND_ATTEMPT before every HTTP attempt the Mock receives (${kind} once)`, async () => {
      await control("/__mock/faults", { target: "message", kind, count: 1 });
      const result = await issuer.issueFeishuLoginCode({ flowHash: flowHash(), email: ALICE.email });
      expect(result).toEqual({ status: "sent", send: "accepted" });
      // The Mock consumed the fault on the first request, which was `unknown`, and the
      // service repeated the same payload once (FSL-149; the transport no longer retries):
      // two requests, two attempt keys, one delivered message.
      expect(((await control("/__mock/state")) as { faults: unknown[] }).faults).toEqual([]);
      expect(sendRequests).toBe(2);
      expect(logs).toEqual([FEISHU_LOGIN_SEND_ATTEMPT, FEISHU_LOGIN_SEND_ATTEMPT]);
      const messages = await inbox(ALICE.openId);
      expect(messages).toHaveLength(1);
      expect(textOf(messages[0]!)).toContain(codes[0]!);
      const sends = sentBodies.filter((body) => body.includes('"receive_id"'));
      expect(sends).toHaveLength(2);
      expect(sends[1]).toBe(sends[0]);
      expect((await rows()).map((row) => row.state)).toEqual(["active"]);
      await expectHygiene();
    });
  }

  scenario("an empty directory name is held as an empty string while the row is active", async () => {
    const store = createFeishuLoginCodeStore(pool);
    const emailHmac = feishuLoginEmailHmac(hmacKey, ALICE.email);
    const reserved = await store.reserve({ flowHash: flowHash(), emailHmac });
    expect(reserved.kind).toBe("reserved");
    const id = (reserved as { id: string }).id;
    const activated = await store.activate({
      id,
      emailHmac,
      email: ALICE.email,
      openId: ALICE.openId,
      displayName: "",
      codeHmac: feishuLoginCodeHmac(hmacKey, id, "ABCD2345"),
    });
    expect(activated).toEqual({ kind: "active" });
    expect(await rows()).toMatchObject([{ id, state: "active", display_name: "" }]);
  });

  scenario("a failed Feishu call sends no message and voids the row", async () => {
    await control("/__mock/faults", { target: "token", kind: "403", count: 1 });
    const result = await issuer.issueFeishuLoginCode({ flowHash: flowHash(), email: ALICE.email });
    expect(result).toEqual({ status: "provider_failed" });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ state: "void", email: null, open_id: null, display_name: null, code_hmac: null });
    expect(await allInboxCount()).toBe(0);
    expect(logs).toEqual([FEISHU_LOGIN_PROVIDER_FAILED]);
    await expectHygiene();
  });

  // ---------------------------------------------------------------------------------------
  // FSL-149: the state checks before activation and the three send outcomes.
  // ---------------------------------------------------------------------------------------

  /** The direct-message request bodies the service sent, parsed. */
  function sendPayloads(): Array<Record<string, unknown>> {
    return sentBodies
      .map((body) => JSON.parse(body) as Record<string, unknown>)
      .filter((body) => "receive_id" in body);
  }

  async function rowById(id: string): Promise<(CodeRow & { expired: boolean }) | undefined> {
    return (
      await pool.query<CodeRow & { expired: boolean }>(
        "select id, flow_hash, email_hmac, state, email, open_id, display_name, code_hmac, " +
          "expires_at <= now() as expired from feishu_login_codes where id = $1",
        [id],
      )
    ).rows[0];
  }

  async function onlyRowId(): Promise<string> {
    const stored = await rows();
    expect(stored).toHaveLength(1);
    return stored[0]!.id;
  }

  async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const VOID_CLEARED = { state: "void", email: null, open_id: null, display_name: null, code_hmac: null };

  scenario("FSL-149 AC1: an earlier reservation whose lookup finishes after a later one sends nothing", async () => {
    // A reserves first and its directory search is held; B reserves later and completes.
    const arrived = deferred();
    const release = deferred();
    plan(SEARCH_PATHNAME, { kind: "forward", arrived: arrived.resolve, release: release.promise });
    const earlierFlow = flowHash();
    const earlier = issuer.issueFeishuLoginCode({ flowHash: earlierFlow, email: ALICE.email });
    await arrived.promise;
    const laterFlow = flowHash();
    expect(await issuer.issueFeishuLoginCode({ flowHash: laterFlow, email: ALICE.email })).toEqual({
      status: "sent",
      send: "accepted",
    });
    release.resolve();
    expect(await earlier).toEqual({ status: "not_reserved" });

    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored.find((row) => row.flow_hash === earlierFlow)).toMatchObject(VOID_CLEARED);
    // The stale activation changed no other row: the later one is still active.
    expect(stored.find((row) => row.flow_hash === laterFlow)).toMatchObject({ state: "active", open_id: ALICE.openId });
    expect(sendRequests).toBe(1);
    const messages = await inbox(ALICE.openId);
    expect(messages).toHaveLength(1);
    expect(textOf(messages[0]!)).toContain(codes[0]!);
    expect(sendPayloads().map((body) => body.uuid)).toEqual([stored.find((row) => row.flow_hash === laterFlow)!.id]);
    expect(logs).toEqual([FEISHU_LOGIN_SEND_ATTEMPT]);
    await expectHygiene();
  });

  for (const order of ["equal", "reversed"] as const) {
    scenario(`FSL-149 AC1: only the larger email_seq activates when created_at is ${order}`, async () => {
      const store = createFeishuLoginCodeStore(pool);
      const emailHmac = feishuLoginEmailHmac(hmacKey, ALICE.email);
      const first = await store.reserve({ flowHash: flowHash(), emailHmac });
      const second = await store.reserve({ flowHash: flowHash(), emailHmac });
      expect(first.kind).toBe("reserved");
      expect(second.kind).toBe("reserved");
      const firstId = (first as { id: string }).id;
      const secondId = (second as { id: string }).id;
      // The order is decided by email_seq, never by the timestamps.
      await pool.query(
        "update feishu_login_codes set created_at = case when id = $1 then $3::timestamptz else $4::timestamptz end " +
          "where id in ($1, $2)",
        order === "equal"
          ? [firstId, secondId, "2026-11-20T00:00:00Z", "2026-11-20T00:00:00Z"]
          : [firstId, secondId, "2026-11-20T00:00:10Z", "2026-11-20T00:00:00Z"],
      );
      expect(
        (await pool.query<{ id: string; email_seq: number }>("select id, email_seq from feishu_login_codes order by email_seq")).rows,
      ).toEqual([
        { id: firstId, email_seq: 1 },
        { id: secondId, email_seq: 2 },
      ]);
      const activate = (id: string) =>
        store.activate({
          id,
          emailHmac,
          email: ALICE.email,
          openId: ALICE.openId,
          displayName: ALICE.name,
          codeHmac: feishuLoginCodeHmac(hmacKey, id, "ABCD2345"),
        });
      expect(await activate(firstId)).toEqual({ kind: "not_reserved", reason: "superseded" });
      expect(await rowById(firstId)).toMatchObject(VOID_CLEARED);
      expect(await activate(secondId)).toEqual({ kind: "active" });
      expect(await rowById(secondId)).toMatchObject({ state: "active", open_id: ALICE.openId });
      // A voided row can never come back.
      expect(await activate(firstId)).toEqual({ kind: "not_reserved", reason: "not_reserved" });
      expect(await rowById(secondId)).toMatchObject({ state: "active" });
    });
  }

  scenario("FSL-149 AC1: two connections reserving one email concurrently serialize on the email lock", async () => {
    const emailHmac = feishuLoginEmailHmac(hmacKey, ALICE.email);
    // The first reservation stops right before its commit, still holding the email lock.
    const atCommit = deferred();
    const commit = deferred();
    const gatedPool = {
      async connect() {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property, receiver) {
            if (property === "query") {
              return async (text: string, values?: unknown[]) => {
                if (text === "commit") {
                  atCommit.resolve();
                  await commit.promise;
                }
                return target.query(text, values);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        });
      },
    } as unknown as Pool;
    const order: string[] = [];
    const first = createFeishuLoginCodeStore(gatedPool)
      .reserve({ flowHash: flowHash(), emailHmac })
      .then((result) => {
        order.push("first");
        return result;
      });
    await atCommit.promise;
    const second = createFeishuLoginCodeStore(pool)
      .reserve({ flowHash: flowHash(), emailHmac })
      .then((result) => {
        order.push("second");
        return result;
      });
    try {
      // The second reservation blocks on the email lock until the first one commits.
      await waitFor(
        async () =>
          (
            await pool.query<{ n: number }>(
              "select count(*)::int as n from pg_stat_activity where datname = current_database() " +
                "and wait_event_type = 'Lock' and query like 'select pg_advisory_xact_lock%'",
            )
          ).rows[0]!.n === 1,
        "the second reservation to wait for the email lock",
      );
      expect(order).toEqual([]);
    } finally {
      commit.resolve();
    }
    const [firstResult, secondResult] = (await Promise.all([first, second])) as Array<{ kind: string; id: string }>;
    expect(firstResult!.kind).toBe("reserved");
    expect(secondResult!.kind).toBe("reserved");
    expect(order).toEqual(["first", "second"]);
    expect(
      (await pool.query<{ id: string; email_seq: number }>("select id, email_seq from feishu_login_codes order by email_seq")).rows,
    ).toEqual([
      { id: firstResult!.id, email_seq: 1 },
      { id: secondResult!.id, email_seq: 2 },
    ]);
  });

  scenario("FSL-149 AC1: a connection bypassing the email lock with the same email_seq makes reserve retry (unique index)", async () => {
    const emailHmac = feishuLoginEmailHmac(hmacKey, ALICE.email);
    // Defence in depth: the first connection bypasses the email lock and inserts email_seq 1
    // without committing, so `reserve` (under the lock) reads the same maximum and must
    // collide on the unique index of FSL-163.
    const writer = await pool.connect();
    let firstId: string;
    let second: Promise<unknown>;
    try {
      await writer.query("begin");
      firstId = (
        await writer.query<{ id: string }>(
          `insert into feishu_login_codes (id, flow_hash, flow_seq, email_hmac, email_seq, state, expires_at, created_at)
           values (gen_random_uuid(), $1, 1, $2, 1, 'reserved', now() + interval '2 minutes', now()) returning id`,
          [flowHash(), emailHmac],
        )
      ).rows[0]!.id;
      second = createFeishuLoginCodeStore(pool).reserve({ flowHash: flowHash(), emailHmac });
      await waitFor(
        async () =>
          (
            await pool.query<{ n: number }>(
              "select count(*)::int as n from pg_stat_activity " +
                "where datname = current_database() and wait_event_type = 'Lock' and query like 'insert into feishu_login_codes%'",
            )
          ).rows[0]!.n === 1,
        "the reservation to wait on the unique index",
      );
      await writer.query("commit");
    } finally {
      writer.release();
    }
    expect(await second).toEqual({ kind: "retry" });
    const stored = (await pool.query<{ id: string; email_seq: number }>("select id, email_seq from feishu_login_codes")).rows;
    expect(stored).toEqual([{ id: firstId, email_seq: 1 }]);
  });

  scenario("FSL-149 AC1: a reservation waits for an activation that checked the newest reservation", async () => {
    const store = createFeishuLoginCodeStore(pool);
    const emailHmac = feishuLoginEmailHmac(hmacKey, ALICE.email);
    const activateWith = (target: ReturnType<typeof createFeishuLoginCodeStore>, id: string) =>
      target.activate({
        id,
        emailHmac,
        email: ALICE.email,
        openId: ALICE.openId,
        displayName: ALICE.name,
        codeHmac: feishuLoginCodeHmac(hmacKey, id, "ABCD2345"),
      });
    const a = (await store.reserve({ flowHash: flowHash(), emailHmac })) as { id: string };
    // A's activation pauses after its superseded check, right before its activating write,
    // while it holds the email lock.
    const atWrite = deferred();
    const resume = deferred();
    const pausingPool = {
      async connect() {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property, receiver) {
            if (property === "query") {
              return async (text: string, values?: unknown[]) => {
                if (typeof text === "string" && text.includes("set state = 'active'")) {
                  atWrite.resolve();
                  await resume.promise;
                }
                return target.query(text, values);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        });
      },
    } as unknown as Pool;
    const order: string[] = [];
    const activationA = activateWith(createFeishuLoginCodeStore(pausingPool), a.id).then((result) => {
      order.push("A activated");
      return result;
    });
    await atWrite.promise;
    const reserveB = store.reserve({ flowHash: flowHash(), emailHmac }).then((result) => {
      order.push("B reserved");
      return result;
    });
    try {
      // B waits on the email lock A holds; nothing of B is visible yet.
      await waitFor(
        async () =>
          (
            await pool.query<{ n: number }>(
              "select count(*)::int as n from pg_stat_activity where datname = current_database() " +
                "and wait_event_type = 'Lock' and query like 'select pg_advisory_xact_lock%'",
            )
          ).rows[0]!.n === 1,
        "the reservation to wait for the email lock",
      );
      expect(order).toEqual([]);
      expect((await rows()).map((row) => row.id)).toEqual([a.id]);
    } finally {
      // Never leave A's transaction open, even when an assertion above failed.
      resume.resolve();
    }
    expect(await activationA).toEqual({ kind: "active" });
    const b = (await reserveB) as { kind: string; id: string };
    expect(b.kind).toBe("reserved");
    // B committed only after A, and took the larger email_seq.
    expect(order).toEqual(["A activated", "B reserved"]);
    expect(
      (await pool.query<{ id: string; email_seq: number }>("select id, email_seq from feishu_login_codes order by email_seq")).rows,
    ).toEqual([
      { id: a.id, email_seq: 1 },
      { id: b.id, email_seq: 2 },
    ]);
    // B's activation voids A.
    expect(await activateWith(store, b.id)).toEqual({ kind: "active" });
    expect(await rowById(a.id)).toMatchObject(VOID_CLEARED);
    expect(await rowById(b.id)).toMatchObject({ state: "active", open_id: ALICE.openId });
  });

  for (const change of ["voided", "expired"] as const) {
    const ac = change === "voided" ? "AC2" : "AC3";
    scenario(`FSL-149 ${ac}: a reservation ${change} before activation sends nothing`, async () => {
      const arrived = deferred();
      const release = deferred();
      plan(SEARCH_PATHNAME, { kind: "forward", arrived: arrived.resolve, release: release.promise });
      const pending = issuer.issueFeishuLoginCode({ flowHash: flowHash(), email: ALICE.email });
      await arrived.promise;
      const id = await onlyRowId();
      if (change === "voided") {
        await pool.query("update feishu_login_codes set state = 'void' where id = $1", [id]);
      } else {
        // The clock passes the reservation expiry while the lookup runs.
        await pool.query("update feishu_login_codes set expires_at = now() - interval '1 second' where id = $1", [id]);
      }
      release.resolve();
      expect(await pending).toEqual({ status: "not_reserved" });
      expect(await rowById(id)).toMatchObject(VOID_CLEARED);
      expect(sendRequests).toBe(0);
      expect(await allInboxCount()).toBe(0);
      expect(logs).toEqual([]);
      await expectHygiene();
    });
  }

  for (const variant of ["mock 429", "mock 403", "business refusal"] as const) {
    scenario(`FSL-149 AC4: every attempt rejected (${variant}) voids the active row without a retry`, async () => {
      if (variant === "mock 429") await control("/__mock/faults", { target: "message", kind: "429", count: 3 });
      else if (variant === "mock 403") await control("/__mock/faults", { target: "message", kind: "403", count: 3 });
      else plan(MESSAGE_PATHNAME, { kind: "reply", ...REFUSED }, { kind: "reply", ...REFUSED }, { kind: "reply", ...REFUSED });
      const result = await issuer.issueFeishuLoginCode({ flowHash: flowHash(), email: ALICE.email });
      expect(result).toEqual({ status: "sent", send: "rejected" });
      const id = await onlyRowId();
      expect(await rowById(id)).toMatchObject(VOID_CLEARED);
      // A rejection is never retried: one request.
      expect(sendRequests).toBe(1);
      expect(await allInboxCount()).toBe(0);
      expect(logs).toEqual([FEISHU_LOGIN_SEND_ATTEMPT, FEISHU_LOGIN_SEND_REJECTED]);
      await expectHygiene();
    });
  }

  scenario("FSL-149 AC5: an unknown send is retried with the same UUID at most twice, one HTTP request each", async () => {
    await control("/__mock/faults", { target: "message", kind: "500", count: 5 });
    const result = await issuer.issueFeishuLoginCode({ flowHash: flowHash(), email: ALICE.email });
    expect(result).toEqual({ status: "sent", send: "unknown" });
    const id = await onlyRowId();
    // Three requests reach the Mock: the first and two retries; the transport added none
    // (with its own retry, three unknown attempts would have been nine requests).
    expect(sendRequests).toBe(3);
    expect(((await control("/__mock/state")) as { faults: Array<{ count: number }> }).faults).toEqual([
      expect.objectContaining({ count: 2 }),
    ]);
    const payloads = sendPayloads();
    expect(payloads).toHaveLength(3);
    expect(new Set(payloads.map((body) => body.uuid))).toEqual(new Set([id]));
    expect(new Set(sentBodies.filter((body) => body.includes('"receive_id"'))).size).toBe(1);
    expect(await rowById(id)).toMatchObject({ state: "active" });
    expect(logs).toEqual([
      FEISHU_LOGIN_SEND_ATTEMPT,
      FEISHU_LOGIN_SEND_ATTEMPT,
      FEISHU_LOGIN_SEND_ATTEMPT,
      FEISHU_LOGIN_SEND_UNKNOWN,
    ]);
    await expectHygiene();
  });

  scenario("FSL-149 AC5: an attempt that times out is retried with the same UUID, then accepted once", async () => {
    // The first request reaches the Mock, which records the delivery, but the answer never
    // comes back: the attempt times out. The retry is answered from the uuid ledger.
    plan(MESSAGE_PATHNAME, { kind: "forward_then_hang" });
    const result = await issuer.issueFeishuLoginCode({ flowHash: flowHash(), email: ALICE.email });
    expect(result).toEqual({ status: "sent", send: "accepted" });
    const id = await onlyRowId();
    expect(sendRequests).toBe(2);
    expect(sendPayloads().map((body) => body.uuid)).toEqual([id, id]);
    expect(await inbox(ALICE.openId)).toHaveLength(1);
    expect(await rowById(id)).toMatchObject({ state: "active" });
    expect(logs).toEqual([FEISHU_LOGIN_SEND_ATTEMPT, FEISHU_LOGIN_SEND_ATTEMPT]);
    await expectHygiene();
  });

  scenario("FSL-149 AC6: unknown after unknown keeps the active row active", async () => {
    // Two timeouts that never reach the Mock, then a 503.
    plan(MESSAGE_PATHNAME, { kind: "hang" }, { kind: "hang" }, { kind: "reply", status: 503, body: { code: 8, msg: "unavailable" } });
    const result = await issuer.issueFeishuLoginCode({ flowHash: flowHash(), email: ALICE.email });
    expect(result).toEqual({ status: "sent", send: "unknown" });
    const id = await onlyRowId();
    expect(sendRequests).toBe(3);
    expect(sendPayloads().map((body) => body.uuid)).toEqual([id, id, id]);
    expect(await rowById(id)).toMatchObject({ state: "active", open_id: ALICE.openId });
    expect(await allInboxCount()).toBe(0);
    expect(logs).toEqual([
      FEISHU_LOGIN_SEND_ATTEMPT,
      FEISHU_LOGIN_SEND_ATTEMPT,
      FEISHU_LOGIN_SEND_ATTEMPT,
      FEISHU_LOGIN_SEND_UNKNOWN,
    ]);
    await expectHygiene();
  });

  for (const refusal of [
    ["HTTP 429", RATE_LIMITED],
    ["business refusal", REFUSED],
  ] as const) {
    scenario(`FSL-149 AC6: a timeout the Mock delivered, then a permanent ${refusal[0]}, keeps the row active`, async () => {
      plan(
        MESSAGE_PATHNAME,
        { kind: "forward_then_hang" },
        { kind: "reply", ...refusal[1] },
        { kind: "reply", ...refusal[1] },
      );
      const result = await issuer.issueFeishuLoginCode({ flowHash: flowHash(), email: ALICE.email });
      expect(result).toEqual({ status: "sent", send: "unknown" });
      const id = await onlyRowId();
      // The rejection ends the retries; the earlier unknown means the code may be delivered.
      expect(sendRequests).toBe(2);
      expect(sendPayloads().map((body) => body.uuid)).toEqual([id, id]);
      const messages = await inbox(ALICE.openId);
      expect(messages).toHaveLength(1);
      expect(textOf(messages[0]!)).toContain(codes[0]!);
      expect(await rowById(id)).toMatchObject({ state: "active", open_id: ALICE.openId });
      expect(logs).toEqual([FEISHU_LOGIN_SEND_ATTEMPT, FEISHU_LOGIN_SEND_ATTEMPT, FEISHU_LOGIN_SEND_UNKNOWN]);
      await expectHygiene();
    });
  }

  scenario("FSL-149 AC6: a delivered message answered by an incomplete 2xx response is unknown and keeps the row active", async () => {
    // The Mock records the delivery, but the answer lacks the fields of the success criteria.
    const incomplete = { status: 200, body: { code: 0, msg: "success", data: {} } };
    plan(
      MESSAGE_PATHNAME,
      { kind: "forward_then_reply", ...incomplete },
      { kind: "forward_then_reply", ...incomplete },
      { kind: "forward_then_reply", ...incomplete },
    );
    const result = await issuer.issueFeishuLoginCode({ flowHash: flowHash(), email: ALICE.email });
    expect(result).toEqual({ status: "sent", send: "unknown" });
    const id = await onlyRowId();
    expect(sendRequests).toBe(3);
    expect(sendPayloads().map((body) => body.uuid)).toEqual([id, id, id]);
    const messages = await inbox(ALICE.openId);
    expect(messages).toHaveLength(1);
    expect(textOf(messages[0]!)).toContain(codes[0]!);
    expect(await rowById(id)).toMatchObject({ state: "active", open_id: ALICE.openId });
    expect(logs).toEqual([
      FEISHU_LOGIN_SEND_ATTEMPT,
      FEISHU_LOGIN_SEND_ATTEMPT,
      FEISHU_LOGIN_SEND_ATTEMPT,
      FEISHU_LOGIN_SEND_UNKNOWN,
    ]);
    await expectHygiene();
  });

  scenario("FSL-149 AC6: a delivered message answered by HTTP 302 is unknown and keeps the row active", async () => {
    // The Mock records the delivery, then the service sees a redirect it refuses to follow.
    const redirect = { status: 302, body: {} };
    plan(
      MESSAGE_PATHNAME,
      { kind: "forward_then_reply", ...redirect },
      { kind: "forward_then_reply", ...redirect },
      { kind: "forward_then_reply", ...redirect },
    );
    const result = await issuer.issueFeishuLoginCode({ flowHash: flowHash(), email: ALICE.email });
    expect(result).toEqual({ status: "sent", send: "unknown" });
    const id = await onlyRowId();
    expect(sendRequests).toBe(3);
    expect(sendPayloads().map((body) => body.uuid)).toEqual([id, id, id]);
    const messages = await inbox(ALICE.openId);
    expect(messages).toHaveLength(1);
    expect(textOf(messages[0]!)).toContain(codes[0]!);
    expect(await rowById(id)).toMatchObject({ state: "active", open_id: ALICE.openId });
    expect(logs).toEqual([
      FEISHU_LOGIN_SEND_ATTEMPT,
      FEISHU_LOGIN_SEND_ATTEMPT,
      FEISHU_LOGIN_SEND_ATTEMPT,
      FEISHU_LOGIN_SEND_UNKNOWN,
    ]);
    await expectHygiene();
  });

  const interleavings = [
    {
      name: "a new request of the same flow voided it",
      refusal: RATE_LIMITED,
      async during(id: string, flow: string) {
        expect(await issuer.issueFeishuLoginCode({ flowHash: flow, email: ALICE.email })).toEqual({
          status: "sent",
          send: "accepted",
        });
        expect(await rowById(id)).toMatchObject(VOID_CLEARED);
      },
      expected: VOID_CLEARED,
    },
    {
      name: "verify consumed it",
      refusal: REFUSED,
      async during(id: string) {
        // The consumption of FSL-124: consumed, sensitive fields cleared.
        await pool.query(
          "update feishu_login_codes set state = 'consumed', email = null, open_id = null, display_name = null, " +
            "code_hmac = null where id = $1 and state = 'active'",
          [id],
        );
      },
      expected: { state: "consumed", email: null, open_id: null, display_name: null, code_hmac: null },
    },
    {
      name: "the cleanup voided it",
      refusal: RATE_LIMITED,
      async during(id: string) {
        // The row expires, then the cleanup of FSL-146 voids every expired row.
        await pool.query("update feishu_login_codes set expires_at = now() - interval '1 second' where id = $1", [id]);
        await pool.query(
          "update feishu_login_codes set state = 'void', email = null, open_id = null, display_name = null, " +
            "code_hmac = null where state in ('reserved', 'active') and expires_at <= now()",
        );
      },
      expected: VOID_CLEARED,
    },
    {
      name: "it expired and the cleanup has not run yet",
      refusal: REFUSED,
      async during(id: string) {
        await pool.query("update feishu_login_codes set expires_at = now() - interval '1 second' where id = $1", [id]);
      },
      // An expired row is only handled by the cleanup: still active, still expired.
      expected: { state: "active", open_id: ALICE.openId, email: ALICE.email, expired: true },
    },
  ];

  for (const interleaving of interleavings) {
    scenario(`FSL-149 AC7: a rejected send does not change the row when ${interleaving.name}`, async () => {
      const arrived = deferred();
      const release = deferred();
      plan(MESSAGE_PATHNAME, { kind: "reply", ...interleaving.refusal, arrived: arrived.resolve, release: release.promise });
      const flow = flowHash();
      const pending = issuer.issueFeishuLoginCode({ flowHash: flow, email: ALICE.email });
      await arrived.promise;
      const id = (await rows())[0]!.id;
      expect(await rowById(id)).toMatchObject({ state: "active" });
      await interleaving.during(id, flow);
      const before = await rowById(id);
      release.resolve();
      expect(await pending).toEqual({ status: "sent", send: "rejected" });
      const after = await rowById(id);
      expect(after).toEqual(before);
      expect(after).toMatchObject(interleaving.expected);
      expect(logs.filter((key) => key === FEISHU_LOGIN_SEND_REJECTED)).toHaveLength(1);
      await expectHygiene();
    });
  }

  scenario("FSL-149 AC4: a shared token refresh answering HTTP 429 rejects every waiting send", async () => {
    const BOB = { email: "bob@example.com", openId: "ou_mock_bob" };
    // Every getToken call refreshes, and both requests stop before their activation.
    tokenExpireOverride = 60;
    const arrivedA = deferred();
    const arrivedB = deferred();
    const lookups = deferred();
    plan(
      MGET_PATHNAME,
      { kind: "forward", arrived: arrivedA.resolve, release: lookups.promise },
      { kind: "forward", arrived: arrivedB.resolve, release: lookups.promise },
    );
    const first = issuer.issueFeishuLoginCode({ flowHash: flowHash(), email: ALICE.email });
    const second = issuer.issueFeishuLoginCode({ flowHash: flowHash(), email: BOB.email });
    await Promise.all([arrivedA.promise, arrivedB.promise]);
    // The next token refresh is held until both requests wait on it, then answers 429.
    const tokenArrived = deferred();
    const tokenRelease = deferred();
    plan(TOKEN_PATHNAME, { kind: "reply", ...RATE_LIMITED, arrived: tokenArrived.resolve, release: tokenRelease.promise });
    const tokensBefore = tokenRequests;
    lookups.resolve();
    await tokenArrived.promise;
    await waitFor(
      async () => (await rows()).filter((row) => row.state === "active").length === 2,
      "both requests to activate",
    );
    // Both are past their activation commit; the later one joins the held refresh.
    await new Promise((resolve) => setTimeout(resolve, 200));
    tokenRelease.resolve();
    expect(await first).toEqual({ status: "sent", send: "rejected" });
    expect(await second).toEqual({ status: "sent", send: "rejected" });
    // One shared refresh, no retry and no message request.
    expect(tokenRequests - tokensBefore).toBe(1);
    expect(sendRequests).toBe(0);
    const stored = await rows();
    expect(stored).toHaveLength(2);
    for (const row of stored) expect(row).toMatchObject(VOID_CLEARED);
    expect(logs).toEqual([FEISHU_LOGIN_SEND_REJECTED, FEISHU_LOGIN_SEND_REJECTED]);
    await expectHygiene();
  });

  /** Holds the email lock in another connection until `release` is called. */
  async function holdEmailLock(emailHmac: string): Promise<{ release: () => Promise<void> }> {
    const holder = await pool.connect();
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock($1::int4, $2::int4)", [
      FEISHU_LOGIN_EMAIL_LOCK_CLASS,
      feishuLoginEmailLockKey(emailHmac),
    ]);
    return {
      async release() {
        try {
          await holder.query("commit");
        } finally {
          holder.release();
        }
      },
    };
  }

  async function waitForLockWaiter(): Promise<void> {
    await waitFor(
      async () =>
        (
          await pool.query<{ n: number }>(
            "select count(*)::int as n from pg_stat_activity where datname = current_database() " +
              "and wait_event_type = 'Lock' and query like 'select pg_advisory_xact_lock%'",
          )
        ).rows[0]!.n === 1,
      "a transaction waiting for the email lock",
    );
  }

  scenario("FSL-149: a reservation that waits for the email lock gets its full two minutes from when it got the lock", async () => {
    const store = createFeishuLoginCodeStore(pool);
    const emailHmac = feishuLoginEmailHmac(hmacKey, ALICE.email);
    // The holder takes the email lock and, as the last statement before releasing it,
    // samples the clock inside its own transaction: the lock is released by the commit
    // right after, so a reservation made under the lock can not be older than that sample.
    const holder = await pool.connect();
    let released: Date;
    let pending: Promise<unknown>;
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock($1::int4, $2::int4)", [
        FEISHU_LOGIN_EMAIL_LOCK_CLASS,
        feishuLoginEmailLockKey(emailHmac),
      ]);
      pending = store.reserve({ flowHash: flowHash(), emailHmac });
      await waitForLockWaiter();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      released = (await holder.query<{ at: Date }>("select clock_timestamp() as at")).rows[0]!.at;
      await holder.query("commit");
    } finally {
      holder.release();
    }
    const reserved = (await pending) as { kind: string; id: string };
    expect(reserved.kind).toBe("reserved");
    const row = (
      await pool.query<{ created_at: Date; ttl: number }>(
        "select created_at, extract(epoch from expires_at - created_at)::float8 as ttl from feishu_login_codes where id = $1",
        [reserved.id],
      )
    ).rows[0]!;
    // Created after the lock was released, and valid for exactly two minutes from then.
    expect(row.created_at.getTime()).toBeGreaterThanOrEqual(released.getTime());
    expect(row.ttl).toBe(120);
  });

  scenario("FSL-149 AC3: a reservation that expires while activation waits for the email lock is not activated", async () => {
    const store = createFeishuLoginCodeStore(pool);
    const emailHmac = feishuLoginEmailHmac(hmacKey, ALICE.email);
    const reserved = await store.reserve({ flowHash: flowHash(), emailHmac });
    const id = (reserved as { id: string }).id;
    // The reservation is still valid when the activation transaction starts.
    await pool.query("update feishu_login_codes set expires_at = clock_timestamp() + interval '500 milliseconds' where id = $1", [id]);
    const lock = await holdEmailLock(emailHmac);
    const activation = store.activate({
      id,
      emailHmac,
      email: ALICE.email,
      openId: ALICE.openId,
      displayName: ALICE.name,
      codeHmac: feishuLoginCodeHmac(hmacKey, id, "ABCD2345"),
    });
    await waitForLockWaiter();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await lock.release();
    expect(await activation).toEqual({ kind: "not_reserved", reason: "expired" });
    expect(await rowById(id)).toMatchObject(VOID_CLEARED);
  });

  scenario("FSL-149 AC3: a reservation that expires while activation waits for the row lock is not activated", async () => {
    const store = createFeishuLoginCodeStore(pool);
    const emailHmac = feishuLoginEmailHmac(hmacKey, ALICE.email);
    const reserved = await store.reserve({ flowHash: flowHash(), emailHmac });
    const id = (reserved as { id: string }).id;
    await pool.query("update feishu_login_codes set expires_at = clock_timestamp() + interval '500 milliseconds' where id = $1", [id]);
    // Another connection holds the row lock only (not the email lock).
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from feishu_login_codes where id = $1 for update", [id]);
      const activation = store.activate({
        id,
        emailHmac,
        email: ALICE.email,
        openId: ALICE.openId,
        displayName: ALICE.name,
        codeHmac: feishuLoginCodeHmac(hmacKey, id, "ABCD2345"),
      });
      await waitFor(
        async () =>
          (
            await pool.query<{ n: number }>(
              "select count(*)::int as n from pg_stat_activity where datname = current_database() " +
                "and wait_event_type = 'Lock' and query like '%feishu_login_codes%'",
            )
          ).rows[0]!.n === 1,
        "the activation to wait for the row lock",
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
      await holder.query("commit");
      expect(await activation).toEqual({ kind: "not_reserved", reason: "expired" });
    } finally {
      holder.release();
    }
    expect(await rowById(id)).toMatchObject(VOID_CLEARED);
  });

  /** Holds the row lock of one row (not the email lock) in another connection. */
  async function holdRowLock(id: string): Promise<{ release: () => Promise<void> }> {
    const holder = await pool.connect();
    await holder.query("begin");
    await holder.query("select 1 from feishu_login_codes where id = $1 for update", [id]);
    return {
      async release() {
        try {
          await holder.query("commit");
        } finally {
          holder.release();
        }
      },
    };
  }

  async function waitForRowLockWaiter(): Promise<void> {
    await waitFor(
      async () =>
        (
          await pool.query<{ n: number }>(
            "select count(*)::int as n from pg_stat_activity where datname = current_database() " +
              "and wait_event_type = 'Lock' and query like '%feishu_login_codes%'",
          )
        ).rows[0]!.n === 1,
      "a transaction waiting for a row lock",
    );
  }

  scenario("FSL-149 AC3: a reservation that expires while activation waits for an older active row is not activated", async () => {
    const store = createFeishuLoginCodeStore(pool);
    const emailHmac = feishuLoginEmailHmac(hmacKey, ALICE.email);
    const activateRow = (id: string) =>
      store.activate({
        id,
        emailHmac,
        email: ALICE.email,
        openId: ALICE.openId,
        displayName: ALICE.name,
        codeHmac: feishuLoginCodeHmac(hmacKey, id, "ABCD2345"),
      });
    const older = (await store.reserve({ flowHash: flowHash(), emailHmac })) as { id: string };
    expect(await activateRow(older.id)).toEqual({ kind: "active" });
    const newer = (await store.reserve({ flowHash: flowHash(), emailHmac })) as { id: string };
    await pool.query("update feishu_login_codes set expires_at = clock_timestamp() + interval '500 milliseconds' where id = $1", [
      newer.id,
    ]);
    const olderBefore = await rowById(older.id);
    // Another connection holds the lock of the older active row the activation would void.
    const lock = await holdRowLock(older.id);
    const activation = activateRow(newer.id);
    await waitForRowLockWaiter();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await lock.release();
    expect(await activation).toEqual({ kind: "not_reserved", reason: "expired" });
    expect(await rowById(newer.id)).toMatchObject(VOID_CLEARED);
    // The stale activation left the older active row as it was.
    expect(await rowById(older.id)).toEqual(olderBefore);
  });

  scenario("FSL-149 AC3: a reservation that expires after the check but before the activating write is not activated", async () => {
    const store = createFeishuLoginCodeStore(pool);
    const emailHmac = feishuLoginEmailHmac(hmacKey, ALICE.email);
    const activateWith = (target: ReturnType<typeof createFeishuLoginCodeStore>, id: string) =>
      target.activate({
        id,
        emailHmac,
        email: ALICE.email,
        openId: ALICE.openId,
        displayName: ALICE.name,
        codeHmac: feishuLoginCodeHmac(hmacKey, id, "ABCD2345"),
      });
    const older = (await store.reserve({ flowHash: flowHash(), emailHmac })) as { id: string };
    expect(await activateWith(store, older.id)).toEqual({ kind: "active" });
    const newer = (await store.reserve({ flowHash: flowHash(), emailHmac })) as { id: string };
    await pool.query("update feishu_login_codes set expires_at = clock_timestamp() + interval '400 milliseconds' where id = $1", [
      newer.id,
    ]);
    const olderBefore = await rowById(older.id);
    // The activation transaction pauses right before its activating write, after the check
    // read the reservation as unexpired, until the reservation has expired.
    let paused = 0;
    const pausingPool = {
      async connect() {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property, receiver) {
            if (property === "query") {
              return async (text: string, values?: unknown[]) => {
                if (typeof text === "string" && text.includes("set state = 'active'")) {
                  paused += 1;
                  await new Promise((resolve) => setTimeout(resolve, 800));
                }
                return target.query(text, values);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        });
      },
    } as unknown as Pool;
    expect(await activateWith(createFeishuLoginCodeStore(pausingPool), newer.id)).toEqual({
      kind: "not_reserved",
      reason: "expired",
    });
    expect(paused).toBe(1);
    expect(await rowById(newer.id)).toMatchObject(VOID_CLEARED);
    // The older active row is untouched.
    expect(await rowById(older.id)).toEqual(olderBefore);
  });

  scenario("FSL-149 AC7: a row that expires while the write-back waits for its row lock is left as it is", async () => {
    const store = createFeishuLoginCodeStore(pool);
    const emailHmac = feishuLoginEmailHmac(hmacKey, ALICE.email);
    const reserved = (await store.reserve({ flowHash: flowHash(), emailHmac })) as { id: string };
    const id = reserved.id;
    expect(
      await store.activate({
        id,
        emailHmac,
        email: ALICE.email,
        openId: ALICE.openId,
        displayName: ALICE.name,
        codeHmac: feishuLoginCodeHmac(hmacKey, id, "ABCD2345"),
      }),
    ).toEqual({ kind: "active" });
    await pool.query("update feishu_login_codes set expires_at = clock_timestamp() + interval '500 milliseconds' where id = $1", [id]);
    const lock = await holdRowLock(id);
    const writeBack = store.voidRejectedSend({ id, emailHmac });
    await waitForRowLockWaiter();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await lock.release();
    expect(await writeBack).toEqual({ voided: false });
    expect(await rowById(id)).toMatchObject({ state: "active", open_id: ALICE.openId, expired: true });
  });

  scenario("FSL-149 AC7: a row that expires while the write-back waits for the email lock is left as it is", async () => {
    const store = createFeishuLoginCodeStore(pool);
    const emailHmac = feishuLoginEmailHmac(hmacKey, ALICE.email);
    const reserved = await store.reserve({ flowHash: flowHash(), emailHmac });
    const id = (reserved as { id: string }).id;
    expect(
      await store.activate({
        id,
        emailHmac,
        email: ALICE.email,
        openId: ALICE.openId,
        displayName: ALICE.name,
        codeHmac: feishuLoginCodeHmac(hmacKey, id, "ABCD2345"),
      }),
    ).toEqual({ kind: "active" });
    await pool.query("update feishu_login_codes set expires_at = clock_timestamp() + interval '500 milliseconds' where id = $1", [id]);
    const lock = await holdEmailLock(emailHmac);
    const writeBack = store.voidRejectedSend({ id, emailHmac });
    await waitForLockWaiter();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await lock.release();
    expect(await writeBack).toEqual({ voided: false });
    expect(await rowById(id)).toMatchObject({ state: "active", open_id: ALICE.openId, expired: true });
  });
});
