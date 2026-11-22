import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { request, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { resolveMockConfig } from "../../src/config";
import { MOCK_CONTROL_DELIVERED_PATHS } from "../../src/control";
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
    // FSL-140: the event ledger is gone from the state view.
    expect(Object.keys(payload.data).sort()).toEqual(["faults", "inboxes", "users"]);
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

  it("creates the initial members from the frozen fixture", async () => {
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
    expect(state.users).toHaveLength(SYNTHETIC_USERS.length);
    // FSL-167: the state keeps no department directory; the members keep their
    // department_ids field.
    expect(Object.keys(state).sort()).toEqual(["faults", "inboxes", "users"]);
    expect(state).not.toHaveProperty("departments");
    expect(listener.state).not.toHaveProperty("departments");
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

const APP_SECRET = "mock-app-secret-for-the-control-plane";

interface StateView {
  users: { open_id: string; status: Record<string, boolean> }[];
  inboxes: Record<string, unknown[]>;
  faults: unknown[];
}

async function stateView(baseUrl: string): Promise<StateView> {
  const response = await call(baseUrl, "/__mock/state", { headers: admin() });
  expect(response.status).toBe(200);
  return (JSON.parse(response.body) as { data: StateView }).data;
}

/**
 * Records every outgoing HTTP request this process starts, through node:http
 * and through fetch, so a test can prove the mock itself sends nothing.
 */
function recordOutgoing(): { targets: string[]; stop: () => void } {
  const targets: string[] = [];
  const onHttp = (message: unknown): void => {
    const outgoing = (message as { request: ClientRequest }).request;
    targets.push(`${outgoing.method} ${String(outgoing.getHeader("host"))}${outgoing.path}`);
  };
  const onFetch = (message: unknown): void => {
    const outgoing = (message as { request: { method: string; origin: string; path: string } }).request;
    targets.push(`${outgoing.method} ${outgoing.origin}${outgoing.path}`);
  };
  subscribe("http.client.request.start", onHttp);
  subscribe("undici:request:create", onFetch);
  return {
    targets,
    stop: () => {
      unsubscribe("http.client.request.start", onHttp);
      unsubscribe("undici:request:create", onFetch);
    },
  };
}

describe("control routes after the callback removal (FSL-140)", () => {
  it("AC2 delivers exactly state, reset, faults and the member status control", async () => {
    expect([...MOCK_CONTROL_DELIVERED_PATHS].sort()).toEqual([
      "/__mock/faults",
      "/__mock/reset",
      "/__mock/state",
      "/__mock/users/",
    ]);
    listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN, appSecret: APP_SECRET });
    expect((await call(listener.baseUrl, "/__mock/state", { headers: admin() })).status).toBe(200);
    const reset = await call(listener.baseUrl, "/__mock/reset", { method: "POST", headers: admin(), body: "{}" });
    expect(reset.status).toBe(200);
    const fault = await call(listener.baseUrl, "/__mock/faults", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ target: "token", kind: "500", count: 1 }),
    });
    expect(fault.status).toBe(200);
    const patched = await call(listener.baseUrl, "/__mock/users/ou_mock_dave", {
      method: "PATCH",
      headers: admin(),
      body: JSON.stringify({ status: "active" }),
    });
    expect(patched.status).toBe(200);
  });

  it("AC2 answers the frozen 404 for message injection, callback verification and replay", async () => {
    listener = await startMockListener(CONFIG, {
      adminToken: ADMIN_TOKEN,
      appSecret: APP_SECRET,
      verificationToken: "vt",
      encryptKey: "ek",
    });
    const before = await stateView(listener.baseUrl);
    const retired: [string, string][] = [
      ["/__mock/messages", JSON.stringify({ openId: "ou_mock_alice", text: "hello" })],
      ["/__mock/verify-callback", JSON.stringify({ encrypted: false })],
      ["/__mock/replay", JSON.stringify({ eventId: "evt_1" })],
    ];
    for (const [path, body] of retired) {
      for (const method of ["POST", "GET"]) {
        const response = await call(listener.baseUrl, path, {
          method,
          headers: admin(),
          body: method === "POST" ? body : undefined,
        });
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(JSON.parse(response.body), `${method} ${path}`).toEqual({ code: 4, msg: "not_found" });
      }
    }
    expect(await stateView(listener.baseUrl)).toEqual(before);
  });

  it("AC3 PATCH changes only the target member's status", async () => {
    listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN, appSecret: APP_SECRET });
    const before = await stateView(listener.baseUrl);
    const response = await call(listener.baseUrl, "/__mock/users/ou_mock_dave", {
      method: "PATCH",
      headers: admin(),
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as { code: number; data: Record<string, unknown> };
    expect(payload.code).toBe(0);
    // The receipt carries the member and nothing about events or deliveries.
    expect(Object.keys(payload.data)).toEqual(["user"]);
    expect(payload.data.user).toMatchObject({ open_id: "ou_mock_dave", status: statusFlags("suspended") });

    const after = await stateView(listener.baseUrl);
    const expected = before.users.map((user) =>
      user.open_id === "ou_mock_dave" ? { ...user, status: statusFlags("suspended") } : user,
    );
    expect(after.users).toEqual(expected);
    expect(after.inboxes).toEqual(before.inboxes);
    expect(after.faults).toEqual(before.faults);

    for (const status of ["resigned", "active"] as const) {
      const next = await call(listener.baseUrl, "/__mock/users/ou_mock_dave", {
        method: "PATCH",
        headers: admin(),
        body: JSON.stringify({ status }),
      });
      expect(next.status).toBe(200);
      const view = await stateView(listener.baseUrl);
      expect(view.users.find((user) => user.open_id === "ou_mock_dave")?.status).toEqual(statusFlags(status));
      expect(view.users.filter((user) => user.open_id !== "ou_mock_dave")).toEqual(
        before.users.filter((user) => user.open_id !== "ou_mock_dave"),
      );
    }
  });

  it("AC3 PATCH works without callback credentials and the reset restores the status", async () => {
    listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN });
    const response = await call(listener.baseUrl, "/__mock/users/ou_mock_bob", {
      method: "PATCH",
      headers: admin(),
      body: JSON.stringify({ status: "resigned" }),
    });
    expect(response.status).toBe(200);
    expect(listener.state.users.find((user) => user.open_id === "ou_mock_bob")?.status).toEqual(statusFlags("resigned"));
    await call(listener.baseUrl, "/__mock/reset", { method: "POST", headers: admin(), body: "{}" });
    expect(listener.state.users.find((user) => user.open_id === "ou_mock_bob")?.status).toEqual(statusFlags("active"));
  });

  it("AC4 PATCH sends no callback and records no event", async () => {
    listener = await startMockListener(CONFIG, {
      adminToken: ADMIN_TOKEN,
      appSecret: APP_SECRET,
      verificationToken: "vt",
      encryptKey: "ek",
    });
    const own = `127.0.0.1:${listener.port}`;
    const outgoing = recordOutgoing();
    try {
      for (const status of ["suspended", "resigned", "active"]) {
        const response = await call(listener.baseUrl, "/__mock/users/ou_mock_carol", {
          method: "PATCH",
          headers: admin(),
          body: JSON.stringify({ status }),
        });
        expect(response.status).toBe(200);
      }
      // Give a stray asynchronous delivery the chance to start.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    } finally {
      outgoing.stop();
    }
    // The only requests started in this process are the test's own calls to the listener.
    expect(outgoing.targets.length).toBeGreaterThan(0);
    for (const target of outgoing.targets) {
      expect(target).toMatch(new RegExp(`^PATCH ${own.replace(/\./g, "\\.")}/__mock/users/ou_mock_carol$`));
    }
    const view = await stateView(listener.baseUrl);
    expect(Object.keys(view).sort()).toEqual(["faults", "inboxes", "users"]);
    expect(listener.state).not.toHaveProperty("events");
  });

  it("answers the frozen 404 for every other method on the member path and changes nothing", async () => {
    listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN, appSecret: APP_SECRET });
    const before = await stateView(listener.baseUrl);
    for (const method of ["DELETE", "GET", "POST", "PUT"]) {
      const response = await call(listener.baseUrl, "/__mock/users/ou_mock_carol", {
        method,
        headers: admin(),
        body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify({ status: "resigned" }),
      });
      expect(response.status, method).toBe(404);
      expect(JSON.parse(response.body), method).toEqual({ code: 4, msg: "not_found" });
    }
    const bare = await call(listener.baseUrl, "/__mock/users", {
      method: "PATCH",
      headers: admin(),
      body: JSON.stringify({ status: "resigned" }),
    });
    expect(bare.status).toBe(404);
    expect(JSON.parse(bare.body)).toEqual({ code: 4, msg: "not_found" });
    expect(await stateView(listener.baseUrl)).toEqual(before);
    expect(listener.state.users.map((user) => user.open_id)).toContain("ou_mock_carol");
  });

  it("refuses an unknown member, an invalid status, an unknown field and a missing admin bearer", async () => {
    listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN, appSecret: APP_SECRET });
    const before = await stateView(listener.baseUrl);
    const unknown = await call(listener.baseUrl, "/__mock/users/ou_mock_unknown", {
      method: "PATCH",
      headers: admin(),
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({ code: 4, msg: "mock_user_not_found" });

    const malformed = await call(listener.baseUrl, "/__mock/users/%E0%A4%A", {
      method: "PATCH",
      headers: admin(),
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(malformed.status).toBe(404);
    expect(JSON.parse(malformed.body)).toEqual({ code: 4, msg: "mock_user_not_found" });

    const invalid = await call(listener.baseUrl, "/__mock/users/ou_mock_alice", {
      method: "PATCH",
      headers: admin(),
      body: JSON.stringify({ status: "deleted" }),
    });
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body)).toEqual({ code: 1, msg: "mock_status_invalid" });

    const extra = await call(listener.baseUrl, "/__mock/users/ou_mock_alice", {
      method: "PATCH",
      headers: admin(),
      body: JSON.stringify({ status: "suspended", notify: true }),
    });
    expect(extra.status).toBe(400);

    const guest = await call(listener.baseUrl, "/__mock/users/ou_mock_alice", {
      method: "PATCH",
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(guest.status).toBe(401);
    expect(JSON.parse(guest.body)).toEqual({ code: 2, msg: "mock_admin_token_missing" });

    expect(await stateView(listener.baseUrl)).toEqual(before);
  });
});
