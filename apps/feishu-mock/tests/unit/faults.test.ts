import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { resolveMockConfig } from "../../src/config";
import { MOCK_MAX_FAULT_RULES } from "../../src/faults";
import { startMockListener, type MockListener } from "../../src/server";

const APP_SECRET = "mock-app-secret-for-the-tenant-token";
const ADMIN_TOKEN = "mock-admin-token-for-the-control-plane";
const TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const USER_PATH =
  "/open-apis/contact/v3/users/ou_mock_alice?user_id_type=open_id&department_id_type=open_department_id";
/** The retired department directory route (FSL-167). */
const RETIRED_DIRECTORY_PATH =
  "/open-apis/contact/v3/users/find_by_department?department_id=od_mock_engineering&page_size=100";

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
  return new Promise((resolvePromise, reject) => {
    const target = new URL(path, baseUrl);
    const headers = { ...options.headers };
    if (options.body !== undefined && headers["content-type"] === undefined) {
      headers["content-type"] = "application/json";
    }
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: options.method ?? "GET",
        headers,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += String(chunk);
        });
        response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

async function startListener(): Promise<MockListener> {
  listener = await startMockListener(resolveMockConfig({
    FEISHU_SIMULATOR_ENABLED: "1",
    NODE_ENV: "test",
    FEISHU_SIMULATOR_PORT: "0",
  }), {
    adminToken: ADMIN_TOKEN,
    appSecret: APP_SECRET,
    verificationToken: "vt",
    encryptKey: "ek",
  });
  return listener;
}

function admin(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_TOKEN}` };
}

async function addFault(rule: Record<string, unknown>): Promise<{ status: number; body: string }> {
  return call(listener!.baseUrl, "/__mock/faults", {
    method: "POST",
    headers: admin(),
    body: JSON.stringify(rule),
  });
}

async function issueToken(): Promise<string> {
  const response = await call(listener!.baseUrl, TOKEN_PATH, {
    method: "POST",
    body: JSON.stringify({ app_id: "cli_mock_megaui", app_secret: APP_SECRET }),
  });
  expect(response.status).toBe(200);
  return (JSON.parse(response.body) as { tenant_access_token: string }).tenant_access_token;
}

describe("bounded provider fault injection (FSM-04)", () => {
  it("enforces the frozen schema", async () => {
    await startListener();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ target: "unknown", kind: "403" }, "mock_fault_target_invalid"],
      [{ target: "token", kind: "418" }, "mock_fault_kind_invalid"],
      [{ target: "token", kind: "403", count: 11 }, "mock_fault_count_invalid"],
      [{ target: "token", kind: "403", count: 0 }, "mock_fault_count_invalid"],
      [{ target: "token", kind: "403", skip: 11 }, "mock_fault_skip_invalid"],
      [{ target: "token", kind: "403", count: "3" }, "mock_fault_count_invalid"],
    ];
    for (const [rule, msg] of cases) {
      const response = await addFault(rule);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ code: 1, msg });
    }
    const unknownField = await call(listener!.baseUrl, "/__mock/faults", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ target: "token", kind: "403", extra: 1 }),
    });
    expect(unknownField.status).toBe(400);
    expect(JSON.parse(unknownField.body)).toEqual({ code: 1, msg: "mock_unknown_field" });
  });

  // The asynchronous kinds are delivered by FSM-19 and covered by its own suite.

  it("caps the queue at sixteen rules", async () => {
    await startListener();
    for (let index = 0; index < MOCK_MAX_FAULT_RULES; index += 1) {
      const response = await addFault({ target: "token", kind: "403" });
      expect(response.status).toBe(200);
    }
    const refused = await addFault({ target: "token", kind: "403" });
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body)).toEqual({ code: 6, msg: "mock_fault_capacity_exceeded" });
  });

  it("consumes skip then count in insertion order", async () => {
    await startListener();
    const added = await addFault({ target: "token", kind: "429", skip: 2, count: 2 });
    expect(added.status).toBe(200);

    const first = await call(listener!.baseUrl, TOKEN_PATH, {
      method: "POST",
      body: JSON.stringify({ app_id: "cli_mock_megaui", app_secret: APP_SECRET }),
    });
    const second = await call(listener!.baseUrl, TOKEN_PATH, {
      method: "POST",
      body: JSON.stringify({ app_id: "cli_mock_megaui", app_secret: APP_SECRET }),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    for (let index = 0; index < 2; index += 1) {
      const injected = await call(listener!.baseUrl, TOKEN_PATH, {
        method: "POST",
        body: JSON.stringify({ app_id: "cli_mock_megaui", app_secret: APP_SECRET }),
      });
      expect(injected.status).toBe(429);
      expect(JSON.parse(injected.body)).toEqual({ code: 6, msg: "mock_fault_rate_limited" });
    }
    const after = await call(listener!.baseUrl, TOKEN_PATH, {
      method: "POST",
      body: JSON.stringify({ app_id: "cli_mock_megaui", app_secret: APP_SECRET }),
    });
    expect(after.status).toBe(200);
    const state = await call(listener!.baseUrl, "/__mock/state", { headers: admin() });
    expect((JSON.parse(state.body) as { data: { faults: unknown[] } }).data.faults).toEqual([]);
  });

  it("maps 403 and 500 to the frozen responses", async () => {
    await startListener();
    const token = await issueToken();
    await addFault({ target: "user", kind: "403" });
    await addFault({ target: "user", kind: "500" });

    const forbidden = await call(listener!.baseUrl, USER_PATH, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(forbidden.status).toBe(403);
    expect(JSON.parse(forbidden.body)).toEqual({ code: 3, msg: "mock_fault_forbidden" });

    const failure = await call(listener!.baseUrl, USER_PATH, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(failure.status).toBe(500);
    expect(JSON.parse(failure.body)).toEqual({ code: 8, msg: "mock_provider_failure" });
  });

  it("does not consume a rule for a request that fails input or authentication", async () => {
    await startListener();
    await addFault({ target: "user", kind: "429" });
    const unauthorized = await call(listener!.baseUrl, USER_PATH);
    expect(unauthorized.status).toBe(401);
    const state = await call(listener!.baseUrl, "/__mock/state", { headers: admin() });
    expect((JSON.parse(state.body) as { data: { faults: unknown[] } }).data.faults).toHaveLength(1);

    const token = await issueToken();
    const injected = await call(listener!.baseUrl, USER_PATH, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(injected.status).toBe(429);
  });

  it("refuses the retired directory target (FSL-167)", async () => {
    await startListener();
    for (const kind of ["403", "429", "500", "timeout"]) {
      const response = await addFault({ target: "directory", kind });
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ code: 1, msg: "mock_fault_target_invalid" });
    }
    const state = await call(listener!.baseUrl, "/__mock/state", { headers: admin() });
    expect((JSON.parse(state.body) as { data: { faults: unknown[] } }).data.faults).toEqual([]);
  });

  it("answers the frozen 404 on the retired find_by_department route before authentication (FSL-167)", async () => {
    await startListener();
    const anonymous = await call(listener!.baseUrl, RETIRED_DIRECTORY_PATH);
    expect(anonymous.status).toBe(404);
    expect(JSON.parse(anonymous.body)).toEqual({ code: 4, msg: "not_found" });

    const token = await issueToken();
    for (const path of [
      RETIRED_DIRECTORY_PATH,
      "/open-apis/contact/v3/users/find_by_department",
      "/open-apis/contact/v3/users/find_by_department?user_id_type=open_id&department_id_type=open_department_id",
    ]) {
      const authorized = await call(listener!.baseUrl, path, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(authorized.status).toBe(404);
      expect(JSON.parse(authorized.body)).toEqual({ code: 4, msg: "not_found" });
    }
  });

  it("leaves the control plane and health untouched", async () => {
    await startListener();
    await addFault({ target: "token", kind: "403" });
    const health = await call(listener!.baseUrl, "/health");
    expect(health.status).toBe(200);
    const state = await call(listener!.baseUrl, "/__mock/state", { headers: admin() });
    expect(state.status).toBe(200);
  });

  it("empties the queue after a reset", async () => {
    await startListener();
    await addFault({ target: "message", kind: "429" });
    const reset = await call(listener!.baseUrl, "/__mock/reset", {
      method: "POST",
      headers: admin(),
      body: "{}",
    });
    expect(reset.status).toBe(200);
    const state = await call(listener!.baseUrl, "/__mock/state", { headers: admin() });
    expect((JSON.parse(state.body) as { data: { faults: unknown[] } }).data.faults).toEqual([]);
  });
});
