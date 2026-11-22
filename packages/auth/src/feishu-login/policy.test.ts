// FSL-127: the Feishu-mode operation allowlist, driven through the real `createAuth` handler and
// `auth.api` with injected issue ports and a stub pool (no database, no Feishu).
import { describe, expect, it, vi } from "vitest";

import { createAuth } from "../create-auth";
import { FEISHU_LOGIN_PLUGIN_ID } from "./plugin";
import {
  createFeishuLoginOperationPolicy,
  FEISHU_LOGIN_AUTH_OPERATIONS,
  FEISHU_LOGIN_OPERATION_POLICY_ID,
  isFeishuLoginAuthOperation,
} from "./policy";

const ORIGIN = "http://127.0.0.1:3000";
const BASE = `${ORIGIN}/api/auth`;
const VALID_CODE = "A2B3C4D5";

/**
 * A pool stub for the verify option: the key-check query echoes the instance's own fingerprint
 * (so the key is consistent), and nothing else may be queried.
 */
function stubPool() {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (!/feishu_login_key_check/.test(sql)) throw new Error(`unexpected query: ${sql}`);
    return { rows: [{ key_check: params?.[0] }] };
  });
  const connect = vi.fn(async () => {
    throw new Error("unexpected connect");
  });
  return { query, connect };
}

function build() {
  const issue = { reserve: vi.fn(async () => ({ reserved: true })), deliver: vi.fn(async () => undefined) };
  const pool = stubPool();
  const email = { sendVerificationEmail: vi.fn(), sendResetPasswordEmail: vi.fn() };
  const auth = createAuth({
    appName: "megaui-test",
    secret: "test-secret-at-least-32-characters-long",
    baseURL: ORIGIN,
    db: {} as never,
    email: email as never,
    nodeEnv: "test",
    feishuLogin: {
      issue,
      log: () => undefined,
      verify: { pool: pool as never, appId: "cli_fsl127_app", otpHmacKey: new Uint8Array(32).fill(7), log: () => undefined },
    },
  });
  return { auth, issue, pool, email };
}

type Built = ReturnType<typeof build>;
type Auth = Built["auth"];

function http(auth: Auth, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return auth.handler(new Request(`${BASE}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(method === "GET" ? {} : { "content-type": "application/json" }), ...headers },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }));
}

async function expectDenied(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "NOT_FOUND" });
}

function expectNothingRan(built: Built): void {
  expect(built.issue.reserve).not.toHaveBeenCalled();
  expect(built.issue.deliver).not.toHaveBeenCalled();
  expect(built.pool.query).not.toHaveBeenCalled();
  expect(built.pool.connect).not.toHaveBeenCalled();
  expect(built.email.sendVerificationEmail).not.toHaveBeenCalled();
  expect(built.email.sendResetPasswordEmail).not.toHaveBeenCalled();
}

type ApiEndpoint = ((input?: Record<string, unknown>) => Promise<unknown>) & {
  path?: string;
  options?: { method?: string | string[] };
};

function apiEndpoints(auth: Auth): Array<[string, ApiEndpoint]> {
  return Object.entries(auth.api as unknown as Record<string, ApiEndpoint>)
    .filter(([, endpoint]) => typeof endpoint === "function" && typeof endpoint.path === "string");
}

function apiFor(auth: Auth, path: string): ApiEndpoint {
  const found = apiEndpoints(auth).find(([, endpoint]) => endpoint.path === path);
  if (!found) throw new Error(`no endpoint for ${path}`);
  return found[1];
}

function httpMethod(endpoint: ApiEndpoint): string {
  const method = endpoint.options?.method;
  const first = Array.isArray(method) ? method[0] : method;
  return first === undefined || first === "*" ? "POST" : first;
}

/** The named denials of the card (AC5, AC6), each with a body its endpoint would accept. */
const NAMED_DENIALS = [
  { path: "/sign-up/email", body: { email: "alice@example.com", password: "a-password-123", name: "Alice" } },
  { path: "/sign-in/email", body: { email: "alice@example.com", password: "a-password-123" } },
  { path: "/sign-in/social", body: { provider: "github" } },
  { path: "/admin/create-user", body: { email: "bob@example.com", password: "a-password-123", name: "Bob" } },
  { path: "/enterprise/request", body: { alias: "alice" } },
] as const;

describe("feishu login operation allowlist (FSL-127)", () => {
  it("lists exactly the four operations and matches them exactly", () => {
    expect([...FEISHU_LOGIN_AUTH_OPERATIONS]).toEqual(["/feishu-login/request", "/feishu-login/verify", "/get-session", "/sign-out"]);
    for (const operation of FEISHU_LOGIN_AUTH_OPERATIONS) expect(isFeishuLoginAuthOperation(operation)).toBe(true);
    for (const variant of ["/get-session/", "/GET-SESSION", "/sign-out%2F", "//sign-out", "/feishu-login/%72equest", "get-session", "", undefined, null]) {
      expect(isFeishuLoginAuthOperation(variant)).toBe(false);
    }
  });

  it("is registered first only with the feishuLogin option", async () => {
    const withoutFeishu = createAuth({
      appName: "megaui-test",
      secret: "test-secret-at-least-32-characters-long",
      baseURL: ORIGIN,
      db: {} as never,
      email: { sendVerificationEmail: vi.fn(), sendResetPasswordEmail: vi.fn() } as never,
      nodeEnv: "test",
    });
    const withoutIds = withoutFeishu.options.plugins?.map(plugin => plugin.id) ?? [];
    expect(withoutIds).not.toContain(FEISHU_LOGIN_OPERATION_POLICY_ID);

    const built = build();
    const ids = built.auth.options.plugins?.map(plugin => plugin.id) ?? [];
    expect(ids[0]).toBe(FEISHU_LOGIN_OPERATION_POLICY_ID);
    expect(ids).toContain(FEISHU_LOGIN_PLUGIN_ID);
    expect((await http(built.auth, "POST", "/feishu-login/request", { email: "alice@example.com" })).status).toBe(202);
    expect(createFeishuLoginOperationPolicy().id).toBe(FEISHU_LOGIN_OPERATION_POLICY_ID);
  });

  describe("feishu only", () => {
    it("AC1: allows /feishu-login/request over HTTP and through auth.api", async () => {
      const built = build();
      const response = await http(built.auth, "POST", "/feishu-login/request", { email: "alice@example.com" });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "accepted" });
      expect(built.issue.reserve).toHaveBeenCalledTimes(1);

      const direct = await apiFor(built.auth, "/feishu-login/request")({
        body: { email: "bob@example.com" },
        headers: new Headers({ "content-type": "application/json" }),
        asResponse: true,
      }) as Response;
      expect(direct.status).toBe(202);
      expect(await direct.json()).toEqual({ status: "accepted" });
      expect(built.issue.reserve).toHaveBeenCalledTimes(2);
    });

    it("AC2: allows /feishu-login/verify over HTTP and through auth.api", async () => {
      const built = build();
      // No flow cookie: the endpoint runs its key check and answers 401 invalid.
      const response = await http(built.auth, "POST", "/feishu-login/verify", { code: VALID_CODE });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ status: "invalid" });
      expect(built.pool.query).toHaveBeenCalledTimes(1);

      const direct = await apiFor(built.auth, "/feishu-login/verify")({
        body: { code: VALID_CODE },
        headers: new Headers({ "content-type": "application/json" }),
        asResponse: true,
      }) as Response;
      expect(direct.status).toBe(401);
      expect(await direct.json()).toEqual({ status: "invalid" });
    });

    it("AC3: allows /get-session over HTTP and through auth.api", async () => {
      const built = build();
      const response = await http(built.auth, "GET", "/get-session");
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
      const withQuery = await http(built.auth, "GET", "/get-session?disableCookieCache=true");
      expect(withQuery.status).toBe(200);
      // Dot segments are removed by URL parsing itself, before the policy (and the router) sees
      // the pathname: the parsed pathname is the canonical one.
      const dotted = await http(built.auth, "GET", "/./x/../get-session");
      expect(new URL(`${BASE}/./x/../get-session`).pathname).toBe("/api/auth/get-session");
      expect(dotted.status).toBe(200);

      const direct = await built.auth.api.getSession({ headers: new Headers(), asResponse: true });
      expect(direct.status).toBe(200);
      expect(await direct.json()).toBeNull();
    });

    it("AC4: allows /sign-out over HTTP and through auth.api", async () => {
      const built = build();
      const response = await http(built.auth, "POST", "/sign-out");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });

      const direct = await built.auth.api.signOut({ headers: new Headers(), asResponse: true });
      expect(direct.status).toBe(200);
      expect(await direct.json()).toEqual({ success: true });
    });

    it("AC5: rejects every other operation over HTTP", async () => {
      const built = build();
      for (const { path, body } of NAMED_DENIALS) {
        await expectDenied(await http(built.auth, "POST", path, body));
      }
      // Every other endpoint the instance has, whatever plugin added it.
      const others = apiEndpoints(built.auth).filter(([, endpoint]) => !isFeishuLoginAuthOperation(endpoint.path));
      expect(others.length).toBeGreaterThan(20);
      for (const [, endpoint] of others) {
        const path = endpoint.path!.replace(/:[^/]+/g, "x");
        await expectDenied(await http(built.auth, httpMethod(endpoint), path, {}));
      }
      // Unknown paths and the base path itself are rejected too.
      for (const path of ["", "/", "/unknown"]) await expectDenied(await http(built.auth, "GET", path));
      expectNothingRan(built);
    });

    it("AC6: rejects every other operation through a direct auth.api call", async () => {
      const built = build();
      for (const { path, body } of NAMED_DENIALS) {
        if (path.startsWith("/enterprise/")) {
          // There is no `/enterprise/*` endpoint to call at all (FSL-133); over HTTP it is a 404 (AC5).
          expect(apiEndpoints(built.auth).some(([, endpoint]) => endpoint.path === path)).toBe(false);
          continue;
        }
        await expect(apiFor(built.auth, path)({ body, headers: new Headers({ "content-type": "application/json" }) }))
          .rejects.toMatchObject({ status: "NOT_FOUND", message: "AUTH_OPERATION_NOT_FOUND" });
      }
      const others = apiEndpoints(built.auth).filter(([, endpoint]) => !isFeishuLoginAuthOperation(endpoint.path));
      for (const [key, endpoint] of others) {
        const outcome = await endpoint({ body: {}, query: {}, headers: new Headers() }).then(
          () => ({ key, rejected: null }),
          (error: unknown) => ({ key, rejected: error as { status?: unknown; message?: unknown } }),
        );
        expect({ key: outcome.key, status: outcome.rejected?.status, message: outcome.rejected?.message })
          .toEqual({ key, status: "NOT_FOUND", message: "AUTH_OPERATION_NOT_FOUND" });
      }
      expectNothingRan(built);
    });

    it("AC7: rejects trailing-slash, case and encoded variants of the four paths", async () => {
      const built = build();
      const variants: Array<[string, string]> = [
        ["POST", "/feishu-login/request/"],
        ["POST", "/Feishu-Login/Request"],
        ["POST", "/FEISHU-LOGIN/REQUEST"],
        ["POST", "/feishu-login%2Frequest"],
        ["POST", "/feishu-login/%72equest"],
        ["POST", "/feishu-login//request"],
        ["POST", "//feishu-login/request"],
        ["POST", "/feishu-login/verify/"],
        ["POST", "/feishu-login/Verify"],
        ["POST", "/feishu-login/verify%2F"],
        ["POST", "/feishu-login/%76erify"],
        ["GET", "/get-session/"],
        ["GET", "/Get-Session"],
        ["GET", "/GET-SESSION"],
        ["GET", "/get-session%2F"],
        ["GET", "/%67et-session"],
        ["GET", "/get%2Dsession"],
        ["POST", "/sign-out/"],
        ["POST", "/Sign-Out"],
        ["POST", "/sign-out%2F"],
        ["POST", "/sign%2Dout"],
        ["POST", "//sign-out"],
      ];
      for (const [method, path] of variants) {
        const body = path.toLowerCase().includes("request") ? { email: "alice@example.com" } : { code: VALID_CODE };
        await expectDenied(await http(built.auth, method, path, body));
      }
      // Variants of the base path in front of a canonical operation.
      for (const prefix of ["/API/auth", "/api/Auth", "/api%2Fauth", "/api/auth/", "//api/auth"]) {
        const response = await built.auth.handler(new Request(`${ORIGIN}${prefix}/get-session`, { headers: { origin: ORIGIN } }));
        await expectDenied(response);
        const request = await built.auth.handler(new Request(`${ORIGIN}${prefix}/feishu-login/request`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ email: "alice@example.com" }),
        }));
        await expectDenied(request);
      }
      expectNothingRan(built);
    });
  });
});
