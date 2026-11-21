// megaui-only (FSL-150): the Web wiring of the Feishu login, driven through the real middleware,
// the real `/api/auth/[...all]` route and the production `getAuth()` (no substitute Auth
// instance), against a one-shot PostgreSQL, a real Feishu Mock process (the simulator
// provider, FSL-148) and, for AC2, a collab-server process started with the same
// AUTH_MODE / AUTH_PROVIDER.
//
// AC1 request answers 202 in Feishu mode; AC2 request, the code from the Mock inbox, verify,
// then a `collab/token` ticket that the collab-server accepts (a real Hocuspocus client in its
// own process); AC3 / AC4 the endpoints are
// 404 in legacy mode and in enterprise mode without AUTH_PROVIDER; AC7 under the production
// rate limit, a known and an unknown email get the same 429 once the address is over the limit.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { FEISHU_LOGIN_FLOW_COOKIE } from "@megaui/auth";
import { COLLAB_TICKET_PREFIX } from "@megaui/core/collab/ticket";
import { closeDatabaseClient, getDb, getPool } from "@megaui/database";
import { createIsolatedPostgres, isDockerAvailable, type IsolatedPostgres } from "@megaui/database/test-support";

import { POST as authRoutePost } from "@/app/api/auth/[...all]/route";
import { GET as megaGet } from "@/app/api/mega/[...segments]/route";
import { createFeishuWebAuth, getAuth, isFeishuWebMode, prepareWebAuth } from "@/lib/auth";
import { authMiddleware } from "@/middlewares/auth";

import { startFeishuMock, type StartedFeishuMock } from "../e2e/helpers/feishu-mock";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error("[@megaui/web] feishu-login-request.spec.ts: a docker daemon is required (the fixture owns its own Postgres).");
}

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ORIGIN = "http://127.0.0.1:3000";
const SESSION_COOKIE = "better-auth.session_token";
const COLLAB_SECRET = randomBytes(24).toString("base64url");
const ALICE = { email: "alice@example.com", openId: "ou_mock_alice" };
const UNKNOWN = "nobody-fsl150@example.com";
const MANAGED = [
  "AUTH_MODE", "AUTH_PROVIDER", "DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "APP_BASE_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS", "S3_PUBLIC_URL", "EMAIL_PROVIDER", "EMAIL_DEFAULT_FROM", "MEGAUI_APP_NAME",
  "FEISHU_APP_ID", "FEISHU_APP_SECRET", "ENTERPRISE_OTP_HMAC_KEY", "FEISHU_PROVIDER", "FEISHU_SIMULATOR_ORIGIN",
  "MEGA_COLLAB_INTERNAL_TOKEN", "ENTERPRISE_PROCESS_ROLE", "ENTERPRISE_OWNER_FINGERPRINT", "ENTERPRISE_DB_INSTANCE_ID",
  "ENTERPRISE_DEPLOYMENT_ROLE", "ENTERPRISE_APPROVED_TARGETS", "FEISHU_TENANT_KEY", "ENTERPRISE_IP_HMAC_MASTER_KEY",
  "ENTERPRISE_TRUSTED_PROXY_CIDRS", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
] as const;
const saved = new Map(MANAGED.map(key => [key, process.env[key]]));

let isolated: IsolatedPostgres | undefined;
let mock: StartedFeishuMock | undefined;
const collabChildren: ChildProcess[] = [];

function feishuMode(): void {
  process.env.AUTH_MODE = "enterprise";
  process.env.AUTH_PROVIDER = "feishu";
}

/** A request through the real middleware and then the real `/api/auth/[...all]` POST route. */
async function authPost(path: string, body: unknown, init: { cookie?: string; ip?: string } = {}): Promise<Response> {
  const request = new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-forwarded-for": init.ip ?? "198.51.100.10",
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const blocked = await authMiddleware(request);
  if (blocked) return blocked;
  return authRoutePost(request);
}

function cookiePair(response: Response, name: string): string | undefined {
  const line = response.headers.getSetCookie().find(entry => entry.startsWith(`${name}=`));
  return line?.split(";", 1)[0];
}

async function mockState(): Promise<{ inboxes: Record<string, Array<{ content: string }>> }> {
  const response = await fetch(`${mock!.baseUrl}/__mock/state`, {
    headers: { authorization: `Bearer ${mock!.runtime.adminToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("mock state request failed");
  return ((await response.json()) as { data: { inboxes: Record<string, Array<{ content: string }>> } }).data;
}

/** Waits for one more direct message in the member's Mock inbox and returns its code. */
async function nextCode(openId: string, seen: number): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const inbox = (await mockState()).inboxes[openId] ?? [];
    if (inbox.length > seen) {
      const text = (JSON.parse(inbox[inbox.length - 1]!.content) as { text: string }).text;
      const match = /验证码：([2-9A-Z]{8})/u.exec(text);
      if (!match) throw new Error("the delivered message carries no code");
      return match[1]!;
    }
    await delay(50);
  }
  throw new Error("no code reached the Mock inbox");
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/** A collab-server process with exactly the Web's AUTH_MODE / AUTH_PROVIDER and ticket secret. */
async function startCollab(): Promise<string> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: join(ROOT, "apps/collab-server"),
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      AUTH_MODE: process.env.AUTH_MODE,
      AUTH_PROVIDER: process.env.AUTH_PROVIDER,
      MEGA_COLLAB_INTERNAL_TOKEN: COLLAB_SECRET,
      MEGA_COLLAB_PORT: String(port),
      // Document access is not under test: any holder of an accepted ticket may edit.
      MEGA_COLLAB_DEV_ALLOW_AUTHENTICATED: "1",
    },
  });
  collabChildren.push(child);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("collab-server exited during startup");
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) })).ok) {
        return `ws://127.0.0.1:${port}`;
      }
    } catch { /* not listening yet */ }
    await delay(100);
  }
  throw new Error("collab-server did not become healthy");
}

/**
 * One connection of the real Hocuspocus provider, run as its own client process from the
 * collab-server package (the Web has no Hocuspocus dependency and never imports collab-server
 * source): it prints `synced` or `rejected`.
 */
const COLLAB_CLIENT = `
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
let settled = false;
const done = (outcome) => { if (settled) return; settled = true; process.stdout.write(outcome); provider.destroy(); process.exit(0); };
const provider = new HocuspocusProvider({
  url: process.env.COLLAB_URL, name: process.env.COLLAB_ROOM, token: process.env.COLLAB_TOKEN,
  document: new Y.Doc(), onSynced: () => done("synced"), onAuthenticationFailed: () => done("rejected"),
});
setTimeout(() => done("timeout"), 15000);
`;

async function connectCollab(url: string, room: string, token: string): Promise<string> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", COLLAB_CLIENT], {
    cwd: join(ROOT, "apps/collab-server"),
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH, NODE_ENV: "test", COLLAB_URL: url, COLLAB_ROOM: room, COLLAB_TOKEN: token },
  });
  collabChildren.push(child);
  let output = "";
  child.stdout?.on("data", chunk => { output += String(chunk); });
  await new Promise<void>(resolve => child.once("close", () => resolve()));
  return output.trim();
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timer);
}

async function codeRowCount(): Promise<number> {
  return (await getPool().query<{ n: number }>("select count(*)::int as n from feishu_login_codes")).rows[0]!.n;
}

describe("FSL-150 Web wiring of the Feishu login", () => {
  beforeAll(async () => {
    for (const key of MANAGED) delete process.env[key];
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    mock = await startFeishuMock();
    Object.assign(process.env, {
      DATABASE_URL: isolated.databaseUrl,
      BETTER_AUTH_SECRET: "fsl150-contract-secret-at-least-32-characters",
      BETTER_AUTH_URL: ORIGIN,
      APP_BASE_URL: ORIGIN,
      BETTER_AUTH_TRUSTED_ORIGINS: ORIGIN,
      EMAIL_PROVIDER: "test",
      EMAIL_DEFAULT_FROM: "noreply@example.com",
      MEGAUI_APP_NAME: "megaui",
      FEISHU_APP_ID: mock.runtime.appId,
      FEISHU_APP_SECRET: mock.runtime.appSecret,
      ENTERPRISE_OTP_HMAC_KEY: randomBytes(32).toString("base64url"),
      FEISHU_PROVIDER: "simulator",
      FEISHU_SIMULATOR_ORIGIN: mock.baseUrl,
      MEGA_COLLAB_INTERNAL_TOKEN: COLLAB_SECRET,
    });
    feishuMode();
  }, 180_000);

  afterEach(() => {
    vi.useRealTimers();
    feishuMode();
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const end of [
      ...collabChildren.splice(0).map(child => () => stopChild(child)),
      () => closeDatabaseClient(),
      () => mock?.stop(),
      () => isolated?.destroy(),
    ]) {
      try { await end(); } catch (error) { errors.push(error); }
    }
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (errors.length) throw new AggregateError(errors, "FSL-150 cleanup failed");
  }, 120_000);

  it("AC1: request answers 202 through the real middleware in Feishu mode", async () => {
    expect(isFeishuWebMode()).toBe(true);
    const response = await authPost("/api/auth/feishu-login/request", { email: "ac1-fsl150@example.com" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(cookiePair(response, FEISHU_LOGIN_FLOW_COOKIE)).toBeDefined();
    // The production Auth instance carries both endpoints and no enterprise endpoint.
    const api = getAuth().api as Record<string, unknown>;
    expect(typeof api.feishuLoginRequest).toBe("function");
    expect(typeof api.feishuLoginVerify).toBe("function");
    expect(api.enterpriseRequest).toBeUndefined();
  }, 60_000);

  it("AC2: a request + verify session gets a collab/token ticket that a collab-server with the same mode accepts", async () => {
    const seen = ((await mockState()).inboxes[ALICE.openId] ?? []).length;
    const requested = await authPost("/api/auth/feishu-login/request", { email: ALICE.email });
    expect(requested.status).toBe(202);
    const flow = cookiePair(requested, FEISHU_LOGIN_FLOW_COOKIE);
    if (!flow) throw new Error("request set no flow cookie");
    const code = await nextCode(ALICE.openId, seen);

    const verified = await authPost("/api/auth/feishu-login/verify", { code }, { cookie: flow });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ status: "ok" });
    const session = cookiePair(verified, SESSION_COOKIE);
    if (!session) throw new Error("verify issued no session cookie");

    const tokenRequest = new NextRequest(`${ORIGIN}/api/mega/collab/token`, { headers: { cookie: session } });
    expect(await authMiddleware(tokenRequest)).toBeUndefined();
    const tokenResponse = await megaGet(tokenRequest, { params: Promise.resolve({ segments: ["collab", "token"] }) });
    expect(tokenResponse.status).toBe(200);
    const ticket = ((await tokenResponse.json()) as { data: { token: string; userId: string } }).data;
    expect(ticket.token.startsWith(COLLAB_TICKET_PREFIX)).toBe(true);

    const collab = await startCollab();
    const room = `container:doc:fsl150-${randomBytes(4).toString("hex")}`;
    expect(await connectCollab(collab, room, ticket.token)).toBe("synced");
    // The same process still checks tickets: a forged one is refused.
    expect(await connectCollab(collab, room, `${ticket.token.slice(0, -4)}AAAA`)).toBe("rejected");
  }, 120_000);

  it("AC3: in legacy mode the Feishu login endpoints answer 404", async () => {
    for (const provider of [undefined, "local"]) {
      process.env.AUTH_MODE = "legacy";
      if (provider === undefined) delete process.env.AUTH_PROVIDER; else process.env.AUTH_PROVIDER = provider;
      expect(isFeishuWebMode()).toBe(false);
      const before = await codeRowCount();
      for (const path of ["/api/auth/feishu-login/request", "/api/auth/feishu-login/verify"]) {
        const body = path.endsWith("/request") ? { email: ALICE.email } : { code: "ABCD2345" };
        expect((await authPost(path, body)).status, `${provider} ${path}`).toBe(404);
      }
      expect(await codeRowCount()).toBe(before);
      // The legacy Auth instance has no Feishu login plugin.
      expect((getAuth().api as Record<string, unknown>).feishuLoginRequest).toBeUndefined();
    }
  }, 60_000);

  it("AC4: in enterprise mode without AUTH_PROVIDER the Feishu login endpoints answer 404", async () => {
    process.env.AUTH_MODE = "enterprise";
    for (const provider of [undefined, " "]) {
      if (provider === undefined) delete process.env.AUTH_PROVIDER; else process.env.AUTH_PROVIDER = provider;
      expect(isFeishuWebMode()).toBe(false);
      const before = await codeRowCount();
      for (const path of ["/api/auth/feishu-login/request", "/api/auth/feishu-login/verify"]) {
        const body = path.endsWith("/request") ? { email: ALICE.email } : { code: "ABCD2345" };
        const response = await authPost(path, body);
        expect(response.status, path).toBe(404);
        expect(await response.json()).toEqual({ error: "NOT_FOUND" });
      }
      expect(await codeRowCount()).toBe(before);
    }
    // The existing enterprise construction registers no Feishu login plugin either.
    const api = prepareWebAuth().create(getDb()).api as Record<string, unknown>;
    expect(api.feishuLoginRequest).toBeUndefined();
    expect(api.feishuLoginVerify).toBeUndefined();
  }, 60_000);

  it("AC7: under the production rate limit a known and an unknown email get the same 429", async () => {
    const auth = createFeishuWebAuth({ nodeEnv: "production" });
    const ip = "203.0.113.150";
    const send = async (email: string, from = ip): Promise<Response> => {
      const request = new NextRequest(`${ORIGIN}/api/auth/feishu-login/request`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": from },
        body: JSON.stringify({ email }),
      });
      const blocked = await authMiddleware(request);
      if (blocked) return blocked;
      return auth.handler(request);
    };
    // One clock reading for the whole window, so `X-Retry-After` cannot differ by a tick.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    // Better Auth's default per-address limit: 100 requests in 10 seconds.
    for (let index = 0; index < 100; index += 1) {
      const response = await send(index % 2 === 0 ? ALICE.email : UNKNOWN);
      expect(response.status, `request ${index}`).toBe(202);
    }
    const rows = await codeRowCount();
    const known = await send(ALICE.email);
    const unknown = await send(UNKNOWN);
    expect(known.status).toBe(429);
    const snapshot = async (response: Response) => ({
      status: response.status,
      headers: [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
      body: await response.text(),
    });
    const knownSnapshot = await snapshot(known);
    expect(await snapshot(unknown)).toEqual(knownSnapshot);
    expect(known.headers.getSetCookie()).toEqual([]);
    // Over the limit nothing is reserved.
    expect(await codeRowCount()).toBe(rows);
    // The limit depends on the address only: another address is still admitted.
    expect((await send(UNKNOWN, "203.0.113.151")).status).toBe(202);
  }, 120_000);
});

