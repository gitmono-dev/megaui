import { request, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { resolveMockConfig } from "../../src/config";
import { startMockListener, type MockListener } from "../../src/server";
import {
  createMockState,
  MOCK_DEPARTMENT_ENGINEERING,
  MOCK_DEPARTMENT_OPERATIONS,
  statusFlags,
  SYNTHETIC_USERS,
} from "../../src/state";

const CONFIG = resolveMockConfig({
  FEISHU_SIMULATOR_ENABLED: "1",
  NODE_ENV: "test",
  FEISHU_SIMULATOR_PORT: "0",
});

const ADMIN_TOKEN = "mock-admin-token-for-the-control-plane";

let listener: MockListener | undefined;

afterEach(async () => {
  await listener?.close();
  listener = undefined;
});

interface Response {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

function call(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
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
        path: target.pathname + target.search,
        method: options.method ?? "GET",
        headers,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += String(chunk);
        });
        response.on("end", () => {
          resolvePromise({
            status: response.statusCode ?? 0,
            body,
            headers: response.headers,
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

function admin(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_TOKEN}`, ...extra };
}

describe("mock control plane (FSM-07)", () => {
  it("accepts only this run's admin bearer", async () => {
    listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN });
    const missing = await call(listener.baseUrl, "/__mock/state");
    expect(missing.status).toBe(401);
    expect(JSON.parse(missing.body)).toEqual({ code: 2, msg: "mock_admin_token_missing" });

    const wrong = await call(listener.baseUrl, "/__mock/state", {
      headers: { authorization: "Bearer not-the-admin-token" },
    });
    expect(wrong.status).toBe(401);
    expect(JSON.parse(wrong.body)).toEqual({ code: 2, msg: "mock_admin_token_invalid" });

    const malformed = await call(listener.baseUrl, "/__mock/state", {
      headers: { authorization: ADMIN_TOKEN },
    });
    expect(malformed.status).toBe(401);
    expect(JSON.parse(malformed.body)).toEqual({ code: 2, msg: "mock_admin_token_invalid" });

    const wrongScheme = await call(listener.baseUrl, "/__mock/state", {
      headers: { authorization: `Basic ${ADMIN_TOKEN}` },
    });
    expect(wrongScheme.status).toBe(401);
    expect(JSON.parse(wrongScheme.body)).toEqual({ code: 2, msg: "mock_admin_token_invalid" });

    const accepted = await call(listener.baseUrl, "/__mock/state", { headers: admin() });
    expect(accepted.status).toBe(200);
  });

  it("refuses a provider credential on the control plane", async () => {
    listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN });
    const response = await call(listener.baseUrl, "/__mock/state", {
      headers: { authorization: "Bearer tenant-access-token" },
    });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ code: 2, msg: "mock_admin_token_invalid" });
  });

  it("refuses the control plane when no admin bearer is configured", async () => {
    listener = await startMockListener(CONFIG);
    const response = await call(listener.baseUrl, "/__mock/state", { headers: admin() });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ code: 2, msg: "mock_admin_token_invalid" });
  });

  it("refuses a control plane request that carries an Origin", async () => {
    listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN });
    const response = await call(listener.baseUrl, "/__mock/state", {
      headers: admin({ origin: "http://127.0.0.1:3000" }),
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ code: 3, msg: "mock_control_origin_rejected" });
  });

  it("never opens CORS", async () => {
    listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN });
    const response = await call(listener.baseUrl, "/__mock/state", { headers: admin() });
    for (const header of Object.keys(response.headers)) {
      expect(header.startsWith("access-control-")).toBe(false);
    }
    const preflight = await call(listener.baseUrl, "/__mock/state", {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:3000" },
    });
    for (const header of Object.keys(preflight.headers)) {
      expect(header.startsWith("access-control-")).toBe(false);
    }
  });

  it("returns only the frozen business summary", async () => {
    listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN });
    const response = await call(listener.baseUrl, "/__mock/state", { headers: admin() });
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as { code: number; data: Record<string, unknown> };
    expect(payload.code).toBe(0);
    expect(Object.keys(payload.data).sort()).toEqual(["events", "faults", "inboxes", "users"]);
    const user = (payload.data.users as Record<string, unknown>[])[0] ?? {};
    expect(Object.keys(user).sort()).toEqual([
      "department_ids",
      "email",
      "enterprise_email",
      "mobile",
      "name",
      "open_id",
      "status",
      "union_id",
      "user_id",
    ]);
    for (const secret of ["adminToken", "appSecret", "verificationToken", "encryptKey", ADMIN_TOKEN]) {
      expect(response.body).not.toContain(secret);
    }
    expect(response.body).not.toContain("baseUrl");
    expect(response.body).not.toContain("callbackUrl");
  });

  it("creates the initial members and departments from the frozen fixture", async () => {
    listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN });
    const response = await call(listener.baseUrl, "/__mock/state", { headers: admin() });
    const payload = JSON.parse(response.body) as {
      data: { users: Record<string, unknown>[] };
    };
    const users = payload.data.users;
    expect(users.map((user) => user.open_id)).toEqual([
      "ou_mock_alice",
      "ou_mock_bob",
      "ou_mock_carol",
      "ou_mock_dave",
      "ou_mock_erin",
      "ou_mock_frank",
    ]);
    expect(users[0]?.department_ids).toEqual([MOCK_DEPARTMENT_ENGINEERING]);
    expect(users[1]?.department_ids).toEqual([MOCK_DEPARTMENT_ENGINEERING]);
    expect(users[2]?.department_ids).toEqual([MOCK_DEPARTMENT_OPERATIONS]);
    expect(users[0]?.email).toMatch(/@example\.com$/);
    expect(users[1]?.email).toMatch(/@example\.com$/);
    expect(users[2]?.email).toBe("");
    // FSL-118: the three Directory v1 members belong to no department.
    expect(users[3]?.department_ids).toEqual([]);
    expect(users[4]?.department_ids).toEqual([]);
    expect(users[5]?.department_ids).toEqual([]);
    expect(users[3]?.email).toBe("");
    expect(users[3]?.enterprise_email).toBe("dave@corp.example.com");
    expect(users[4]?.enterprise_email).toBe("shared@corp.example.com");
    expect(users[5]?.enterprise_email).toBe(users[4]?.enterprise_email);

    const state = createMockState();
    expect(state.departments.map((department) => department.open_department_id)).toEqual([
      MOCK_DEPARTMENT_ENGINEERING,
      MOCK_DEPARTMENT_OPERATIONS,
    ]);
    expect(state.users).toHaveLength(SYNTHETIC_USERS.length);
  });

  it("expresses the status enum as the frozen four boolean flags", () => {
    expect(statusFlags("active")).toEqual({
      is_activated: true,
      is_frozen: false,
      is_resigned: false,
      is_exited: false,
    });
    expect(statusFlags("suspended")).toEqual({
      is_activated: true,
      is_frozen: true,
      is_resigned: false,
      is_exited: false,
    });
    expect(statusFlags("resigned")).toEqual({
      is_activated: false,
      is_frozen: false,
      is_resigned: true,
      is_exited: true,
    });
  });

  it("answers the frozen 404 for a control path that no card delivers", async () => {
    listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN });
    const unknown = await call(listener.baseUrl, "/__mock/unknown", {
      method: "POST",
      headers: admin(),
      body: "{}",
    });
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({ code: 4, msg: "not_found" });
  });
});
