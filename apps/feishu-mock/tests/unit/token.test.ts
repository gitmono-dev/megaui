import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { resolveMockConfig } from "../../src/config";
import {
  MOCK_MAX_ACTIVE_TOKENS,
  MOCK_TOKEN_TTL_SECONDS,
  MockTokenStore,
} from "../../src/provider";
import { startMockListener, type MockListener } from "../../src/server";
import { MOCK_APP_ID } from "../../src/state";

const CONFIG = resolveMockConfig({
  FEISHU_SIMULATOR_ENABLED: "1",
  NODE_ENV: "test",
  FEISHU_SIMULATOR_PORT: "0",
});

const APP_SECRET = "mock-app-secret-for-the-tenant-token";
const ADMIN_TOKEN = "mock-admin-token-for-the-control-plane";

let listener: MockListener | undefined;

afterEach(async () => {
  await listener?.close();
  listener = undefined;
});

function call(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const target = new URL(path, baseUrl);
  return new Promise((resolvePromise, reject) => {
    const headers = { ...options.headers };
    if (options.body !== undefined && headers["content-type"] === undefined) {
      headers["content-type"] = "application/json";
    }
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: options.method ?? "GET",
        headers,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += String(chunk);
        });
        response.on("end", () => {
          resolvePromise({ status: response.statusCode ?? 0, body });
        });
      },
    );
    outgoing.on("error", reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

async function startListener(): Promise<MockListener> {
  listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN, appSecret: APP_SECRET });
  return listener;
}

describe("tenant token issuance and admission (FSM-02)", () => {
  it("refuses to issue a token for wrong app credentials", async () => {
    await startListener();
    const response = await call(listener!.baseUrl, "/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: JSON.stringify({ app_id: MOCK_APP_ID, app_secret: "not-the-app-secret" }),
    });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ code: 2, msg: "mock_app_credentials_invalid" });

    const wrongApp = await call(listener!.baseUrl, "/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: JSON.stringify({ app_id: "cli_mock_other", app_secret: APP_SECRET }),
    });
    expect(wrongApp.status).toBe(401);
    expect(JSON.parse(wrongApp.body)).toEqual({ code: 2, msg: "mock_app_credentials_invalid" });
  });

  it("answers the legacy top level token contract", async () => {
    await startListener();
    const response = await call(listener!.baseUrl, "/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: JSON.stringify({ app_id: MOCK_APP_ID, app_secret: APP_SECRET }),
    });
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as Record<string, unknown>;
    expect(payload.code).toBe(0);
    expect(payload.msg).toBe("ok");
    expect(payload.expire).toBe(MOCK_TOKEN_TTL_SECONDS);
    expect(typeof payload.tenant_access_token).toBe("string");
    expect((payload.tenant_access_token as string).length).toBeGreaterThan(0);
    expect(payload.data).toBeUndefined();
  });

  it("rejects a body that does not match the schema", async () => {
    await startListener();
    const unknown = await call(listener!.baseUrl, "/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: JSON.stringify({ app_id: MOCK_APP_ID, app_secret: APP_SECRET, extra: 1 }),
    });
    expect(unknown.status).toBe(400);
    expect(JSON.parse(unknown.body)).toEqual({ code: 1, msg: "mock_unknown_field" });

    const missing = await call(listener!.baseUrl, "/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: JSON.stringify({ app_id: MOCK_APP_ID }),
    });
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body)).toEqual({ code: 1, msg: "mock_body_invalid" });
  });

  it("admits only a token of this run that has not expired", () => {
    let now = 1_000_000;
    const store = new MockTokenStore({ appId: MOCK_APP_ID, appSecret: APP_SECRET }, () => now);
    const issued = store.issue(MOCK_APP_ID, APP_SECRET);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(store.validate(issued.token, MOCK_APP_ID)).toBe(true);
    expect(store.validate(issued.token, "cli_mock_other")).toBe(false);
    expect(store.validate(undefined, MOCK_APP_ID)).toBe(false);
    expect(store.validate("some-other-token", MOCK_APP_ID)).toBe(false);

    now += MOCK_TOKEN_TTL_SECONDS * 1000;
    expect(store.validate(issued.token, MOCK_APP_ID)).toBe(false);
  });

  it("does not admit a token of another run", () => {
    const first = new MockTokenStore({ appId: MOCK_APP_ID, appSecret: APP_SECRET });
    const second = new MockTokenStore({ appId: MOCK_APP_ID, appSecret: APP_SECRET });
    const issued = first.issue(MOCK_APP_ID, APP_SECRET);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(second.validate(issued.token, MOCK_APP_ID)).toBe(false);
  });

  it("refuses a new token when the active tokens are at the limit", () => {
    const store = new MockTokenStore({ appId: MOCK_APP_ID, appSecret: APP_SECRET });
    for (let index = 0; index < MOCK_MAX_ACTIVE_TOKENS; index += 1) {
      expect(store.issue(MOCK_APP_ID, APP_SECRET).ok).toBe(true);
    }
    expect(store.activeCount).toBe(MOCK_MAX_ACTIVE_TOKENS);
    const refused = store.issue(MOCK_APP_ID, APP_SECRET);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.httpStatus).toBe(429);
    expect(refused.error.code).toBe(6);
    expect(refused.error.msg).toBe("mock_token_capacity_exceeded");
  });

  it("reclaims an expired token and hands out its capacity again", () => {
    let now = 1_000_000;
    const store = new MockTokenStore({ appId: MOCK_APP_ID, appSecret: APP_SECRET }, () => now);
    const first = store.issue(MOCK_APP_ID, APP_SECRET);
    expect(first.ok).toBe(true);
    for (let index = 1; index < MOCK_MAX_ACTIVE_TOKENS; index += 1) {
      expect(store.issue(MOCK_APP_ID, APP_SECRET).ok).toBe(true);
    }
    expect(store.issue(MOCK_APP_ID, APP_SECRET).ok).toBe(false);

    now += MOCK_TOKEN_TTL_SECONDS * 1000;
    // Every token expired, so their capacity is free again.
    const afterExpiry = store.issue(MOCK_APP_ID, APP_SECRET);
    expect(afterExpiry.ok).toBe(true);
    expect(store.activeCount).toBe(1);
    for (let index = 1; index < MOCK_MAX_ACTIVE_TOKENS; index += 1) {
      expect(store.issue(MOCK_APP_ID, APP_SECRET).ok).toBe(true);
    }
    expect(store.activeCount).toBe(MOCK_MAX_ACTIVE_TOKENS);
    expect(store.issue(MOCK_APP_ID, APP_SECRET).ok).toBe(false);
  });

  it("invalidates the issued tokens after a reset", async () => {
    await startListener();
    const issued = await call(listener!.baseUrl, "/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: JSON.stringify({ app_id: MOCK_APP_ID, app_secret: APP_SECRET }),
    });
    const token = (JSON.parse(issued.body) as { tenant_access_token: string }).tenant_access_token;
    expect(listener!.tokens.validate(token, MOCK_APP_ID)).toBe(true);

    const reset = await call(listener!.baseUrl, "/__mock/reset", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      body: "{}",
    });
    expect(reset.status).toBe(200);
    expect(listener!.tokens.validate(token, MOCK_APP_ID)).toBe(false);
    expect(listener!.tokens.activeCount).toBe(0);
  });
});
