// megaui-only (FSL-122): the issue main flow against a one-shot PostgreSQL and a real Feishu Mock process.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { admitProvider, type ProviderTarget } from "@megaui/core";
import { createFeishuLoginCodeStore, feishuLoginCodeHmac, feishuLoginEmailHmac } from "@megaui/database";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { FEISHU_MESSAGE_PATH } from "../enterprise/feishu/message";
import {
  createFeishuLoginIssuer,
  feishuLoginTenantKey,
  FEISHU_LOGIN_INACTIVE,
  FEISHU_LOGIN_NO_TARGET,
  FEISHU_LOGIN_PROVIDER_FAILED,
  FEISHU_LOGIN_SEND_ATTEMPT,
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
    proxy = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = Buffer.concat(chunks);
        if (incoming.url === FEISHU_MESSAGE_PATH) sendRequests += 1;
        if (body.length > 0) sentBodies.push(body.toString("utf8"));
        const forwarded = httpRequest(
          {
            host: upstream.hostname,
            port: upstream.port,
            method: incoming.method,
            path: incoming.url,
            headers: { ...incoming.headers, host: upstream.host },
          },
          (answer) => {
            outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(outgoing);
          },
        );
        forwarded.on("error", () => outgoing.socket?.destroy());
        forwarded.end(body);
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

  /** Common checks: logs carry stable keys only, attempts match the Mock, the label stays local. */
  async function expectHygiene(): Promise<void> {
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
      // The Mock consumed the fault on the first request, and the transport repeated the
      // same payload once: two requests, two attempt keys, one delivered message.
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
});
