import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { resolveMockConfig } from "../../src/config";
import { findUser } from "../../src/provider";
import { startMockListener, type MockListener } from "../../src/server";
import { MOCK_APP_ID } from "../../src/state";

const CONFIG = resolveMockConfig({
  FEISHU_SIMULATOR_ENABLED: "1",
  NODE_ENV: "test",
  FEISHU_SIMULATOR_PORT: "0",
});

const APP_SECRET = "mock-app-secret-for-the-tenant-token";
const ADMIN_TOKEN = "mock-admin-token-for-the-control-plane";
const USER_PATH = "/open-apis/contact/v3/users/ou_mock_alice";
const FROZEN_TYPES = "user_id_type=open_id&department_id_type=open_department_id";

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

async function issueToken(): Promise<string> {
  const response = await call(
    listener!.baseUrl,
    "/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      body: JSON.stringify({ app_id: MOCK_APP_ID, app_secret: APP_SECRET }),
    },
  );
  expect(response.status).toBe(200);
  return (JSON.parse(response.body) as { tenant_access_token: string }).tenant_access_token;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("single member read (FSM-18)", () => {
  it("refuses a tenant bearer the validator does not admit", async () => {
    await startListener();
    const missing = await call(listener!.baseUrl, `${USER_PATH}?${FROZEN_TYPES}`);
    expect(missing.status).toBe(401);
    expect(JSON.parse(missing.body)).toEqual({ code: 2, msg: "mock_provider_unauthorized" });

    const wrong = await call(listener!.baseUrl, `${USER_PATH}?${FROZEN_TYPES}`, {
      headers: bearer("not-a-token-of-this-run"),
    });
    expect(wrong.status).toBe(401);
    expect(JSON.parse(wrong.body)).toEqual({ code: 2, msg: "mock_provider_unauthorized" });
  });

  it("requires the frozen id types", async () => {
    await startListener();
    const token = await issueToken();

    const withoutTypes = await call(listener!.baseUrl, USER_PATH, { headers: bearer(token) });
    expect(withoutTypes.status).toBe(400);
    expect(JSON.parse(withoutTypes.body)).toEqual({ code: 1, msg: "mock_id_type_required" });

    const wrongUserType = await call(
      listener!.baseUrl,
      `${USER_PATH}?user_id_type=user_id&department_id_type=open_department_id`,
      { headers: bearer(token) },
    );
    expect(wrongUserType.status).toBe(400);
    expect(JSON.parse(wrongUserType.body)).toEqual({ code: 1, msg: "mock_id_type_invalid" });

    const wrongDepartmentType = await call(
      listener!.baseUrl,
      `${USER_PATH}?user_id_type=open_id&department_id_type=department_id`,
      { headers: bearer(token) },
    );
    expect(wrongDepartmentType.status).toBe(400);
    expect(JSON.parse(wrongDepartmentType.body)).toEqual({ code: 1, msg: "mock_id_type_invalid" });
  });

  it("answers the current synthetic user subset", async () => {
    await startListener();
    const token = await issueToken();
    const response = await call(listener!.baseUrl, `${USER_PATH}?${FROZEN_TYPES}`, {
      headers: bearer(token),
    });
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as { code: number; data: { user: Record<string, unknown> } };
    expect(payload.code).toBe(0);
    const user = payload.data.user;
    expect(user.open_id).toBe("ou_mock_alice");
    expect(user.user_id).toBe("u_mock_alice");
    expect(user.union_id).toBe("on_mock_alice");
    expect(user.name).toBe("Mock Alice");
    expect(user.department_ids).toEqual(["od_mock_engineering"]);
    expect(user.status).toEqual({
      is_activated: true,
      is_frozen: false,
      is_resigned: false,
      is_exited: false,
    });
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
  });

  it("answers the frozen 404 for an unknown open id", async () => {
    await startListener();
    const token = await issueToken();
    const response = await call(
      listener!.baseUrl,
      `/open-apis/contact/v3/users/ou_mock_unknown?${FROZEN_TYPES}`,
      { headers: bearer(token) },
    );
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ code: 4, msg: "mock_user_not_found" });
  });

  it("answers the members outside every department and the fixture fields", async () => {
    await startListener();
    const token = await issueToken();
    const response = await call(
      listener!.baseUrl,
      `/open-apis/contact/v3/users/ou_mock_dave?${FROZEN_TYPES}`,
      { headers: bearer(token) },
    );
    expect(response.status).toBe(200);
    const user = (JSON.parse(response.body) as { data: { user: Record<string, unknown> } }).data.user;
    expect(user).toEqual(listener!.state.users.find((candidate) => candidate.open_id === "ou_mock_dave"));
    expect(user.department_ids).toEqual([]);
    expect(user.email).toBe("");
    expect(user.enterprise_email).toBe("dave@corp.example.com");
  });

  it("reads the current member status of the run", async () => {
    await startListener();
    const token = await issueToken();
    const patched = await call(listener!.baseUrl, "/__mock/users/ou_mock_alice", {
      method: "PATCH",
      headers: bearer(ADMIN_TOKEN),
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(patched.status).toBe(200);
    const response = await call(listener!.baseUrl, `${USER_PATH}?${FROZEN_TYPES}`, {
      headers: bearer(token),
    });
    expect(response.status).toBe(200);
    const user = (JSON.parse(response.body) as { data: { user: Record<string, unknown> } }).data.user;
    expect(user.status).toEqual({
      is_activated: true,
      is_frozen: true,
      is_resigned: false,
      is_exited: false,
    });
  });

  it("refuses a method other than GET with the frozen 404", async () => {
    await startListener();
    const token = await issueToken();
    const response = await call(listener!.baseUrl, `${USER_PATH}?${FROZEN_TYPES}`, {
      method: "DELETE",
      headers: bearer(token),
    });
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ code: 4, msg: "not_found" });
  });

  it("does not find a member that the directory does not hold", async () => {
    await startListener();
    expect(findUser(listener!.state, "ou_mock_alice")?.open_id).toBe("ou_mock_alice");
    expect(findUser(listener!.state, "ou_mock_deleted")).toBeUndefined();
    expect(MOCK_APP_ID).toBe("cli_mock_megaui");
  });
});
