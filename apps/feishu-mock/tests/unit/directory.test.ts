import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { resolveMockConfig } from "../../src/config";
import {
  MOCK_CURSOR_TTL_SECONDS,
  MOCK_MAX_CURSORS,
  MOCK_MAX_PAGE_SIZE,
  MockCursorStore,
  queryDepartment,
} from "../../src/directory";
import { startMockListener, type MockListener } from "../../src/server";
import { MOCK_APP_ID, type MockState } from "../../src/state";

const CONFIG = resolveMockConfig({
  FEISHU_SIMULATOR_ENABLED: "1",
  NODE_ENV: "test",
  FEISHU_SIMULATOR_PORT: "0",
});

const APP_SECRET = "mock-app-secret-for-the-tenant-token";
const ADMIN_TOKEN = "mock-admin-token-for-the-control-plane";
const DIRECTORY_PATH = "/open-apis/contact/v3/users/find_by_department";

let listener: MockListener | undefined;

afterEach(async () => {
  await listener?.close();
  listener = undefined;
});

interface Response {
  status: number;
  body: string;
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
  const response = await call(listener!.baseUrl, "/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: JSON.stringify({ app_id: MOCK_APP_ID, app_secret: APP_SECRET }),
  });
  expect(response.status).toBe(200);
  return (JSON.parse(response.body) as { tenant_access_token: string }).tenant_access_token;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("contact directory and cursors (FSM-09)", () => {
  it("refuses a tenant bearer the validator does not admit", async () => {
    await startListener();
    const missing = await call(listener!.baseUrl, `${DIRECTORY_PATH}?department_id=od_mock_engineering`);
    expect(missing.status).toBe(401);
    expect(JSON.parse(missing.body)).toEqual({ code: 2, msg: "mock_provider_unauthorized" });

    const wrong = await call(
      listener!.baseUrl,
      `${DIRECTORY_PATH}?department_id=od_mock_engineering`,
      { headers: bearer("not-a-token-of-this-run") },
    );
    expect(wrong.status).toBe(401);
    expect(JSON.parse(wrong.body)).toEqual({ code: 2, msg: "mock_provider_unauthorized" });
  });

  it("only accepts the two frozen id type parameters", async () => {
    await startListener();
    const token = await issueToken();
    const department = await call(
      listener!.baseUrl,
      `${DIRECTORY_PATH}?department_id=od_mock_engineering&department_id_type=open_department_id`,
      { headers: bearer(token) },
    );
    expect(department.status).toBe(200);

    const wrongDepartmentType = await call(
      listener!.baseUrl,
      `${DIRECTORY_PATH}?department_id=od_mock_engineering&department_id_type=department_id`,
      { headers: bearer(token) },
    );
    expect(wrongDepartmentType.status).toBe(400);
    expect(JSON.parse(wrongDepartmentType.body)).toEqual({ code: 1, msg: "mock_id_type_invalid" });

    const wrongUserType = await call(
      listener!.baseUrl,
      `${DIRECTORY_PATH}?department_id=od_mock_engineering&user_id_type=user_id`,
      { headers: bearer(token) },
    );
    expect(wrongUserType.status).toBe(400);
    expect(JSON.parse(wrongUserType.body)).toEqual({ code: 1, msg: "mock_id_type_invalid" });
  });

  it("paginates a department stably by page_size and page_token", async () => {
    await startListener();
    const token = await issueToken();
    const first = await call(
      listener!.baseUrl,
      `${DIRECTORY_PATH}?department_id=od_mock_engineering&page_size=1`,
      { headers: bearer(token) },
    );
    expect(first.status).toBe(200);
    const firstPage = JSON.parse(first.body) as {
      code: number;
      data: { items: Record<string, unknown>[]; has_more: boolean; page_token: string };
    };
    expect(firstPage.code).toBe(0);
    expect(firstPage.data.items).toHaveLength(1);
    expect(firstPage.data.has_more).toBe(true);
    expect(firstPage.data.page_token.length).toBeGreaterThan(0);

    const second = await call(
      listener!.baseUrl,
      `${DIRECTORY_PATH}?department_id=od_mock_engineering&page_size=1&page_token=${firstPage.data.page_token}`,
      { headers: bearer(token) },
    );
    const secondPage = JSON.parse(second.body) as {
      data: { items: Record<string, unknown>[]; has_more: boolean; page_token: string };
    };
    expect(secondPage.data.items).toHaveLength(1);
    expect(secondPage.data.has_more).toBe(false);
    expect(secondPage.data.page_token).toBe("");
    expect(secondPage.data.items[0]?.open_id).not.toBe(firstPage.data.items[0]?.open_id);
  });

  it("serves only the frozen user subset of the current department", async () => {
    await startListener();
    const token = await issueToken();
    const response = await call(
      listener!.baseUrl,
      `${DIRECTORY_PATH}?department_id=od_mock_engineering&page_size=100`,
      { headers: bearer(token) },
    );
    const payload = JSON.parse(response.body) as { data: { items: Record<string, unknown>[] } };
    const items = payload.data.items;
    expect(items.map((item) => item.open_id)).toEqual(["ou_mock_alice", "ou_mock_bob"]);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual([
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

    const other = await call(
      listener!.baseUrl,
      `${DIRECTORY_PATH}?department_id=od_mock_operations&page_size=100`,
      { headers: bearer(token) },
    );
    const otherPayload = JSON.parse(other.body) as { data: { items: Record<string, unknown>[] } };
    expect(otherPayload.data.items.map((item) => item.open_id)).toEqual(["ou_mock_carol"]);
  });

  it("refuses a cursor that belongs to another query or was tampered with", async () => {
    await startListener();
    const token = await issueToken();
    const first = await call(
      listener!.baseUrl,
      `${DIRECTORY_PATH}?department_id=od_mock_engineering&page_size=1`,
      { headers: bearer(token) },
    );
    const pageToken = (JSON.parse(first.body) as { data: { page_token: string } }).data.page_token;
    expect(pageToken.length).toBeGreaterThan(0);

    const otherDepartment = await call(
      listener!.baseUrl,
      `${DIRECTORY_PATH}?department_id=od_mock_operations&page_size=1&page_token=${pageToken}`,
      { headers: bearer(token) },
    );
    expect(otherDepartment.status).toBe(400);
    expect(JSON.parse(otherDepartment.body)).toEqual({ code: 1, msg: "mock_cursor_invalid" });

    const otherPageSize = await call(
      listener!.baseUrl,
      `${DIRECTORY_PATH}?department_id=od_mock_engineering&page_size=2&page_token=${pageToken}`,
      { headers: bearer(token) },
    );
    expect(otherPageSize.status).toBe(400);
    expect(JSON.parse(otherPageSize.body)).toEqual({ code: 1, msg: "mock_cursor_invalid" });

    const tampered = await call(
      listener!.baseUrl,
      `${DIRECTORY_PATH}?department_id=od_mock_engineering&page_token=${pageToken}x`,
      { headers: bearer(token) },
    );
    expect(tampered.status).toBe(400);
    expect(JSON.parse(tampered.body)).toEqual({ code: 1, msg: "mock_cursor_invalid" });
  });

  it("expires a cursor after the frozen ttl", () => {
    let now = 1_000_000;
    const cursors = new MockCursorStore(() => now);
    const binding = {
      departmentId: "od_mock_engineering",
      departmentIdType: "open_department_id",
      userIdType: "open_id",
      pageSize: 2,
    };
    const created = cursors.create(binding, 2);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(cursors.resolve(created.cursor.token, binding)).toBeDefined();

    now += MOCK_CURSOR_TTL_SECONDS * 1000;
    expect(cursors.resolve(created.cursor.token, binding)).toBeUndefined();
    expect(cursors.activeCount).toBe(0);
    expect(MOCK_CURSOR_TTL_SECONDS).toBe(300);
  });

  it("refuses a new cursor when the store is full and keeps the valid ones", () => {
    const cursors = new MockCursorStore();
    const binding = {
      departmentId: "od_mock_engineering",
      departmentIdType: "open_department_id",
      userIdType: "open_id",
      pageSize: 2,
    };
    const tokens: string[] = [];
    for (let index = 0; index < MOCK_MAX_CURSORS; index += 1) {
      const created = cursors.create(binding, index);
      expect(created.ok).toBe(true);
      if (created.ok) tokens.push(created.cursor.token);
    }
    expect(cursors.activeCount).toBe(MOCK_MAX_CURSORS);
    const refused = cursors.create(binding, 999);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.httpStatus).toBe(429);
    expect(refused.error.code).toBe(6);
    expect(refused.error.msg).toBe("mock_cursor_capacity_exceeded");
    // The valid records were not evicted.
    expect(cursors.resolve(tokens[0] ?? "", binding)).toBeDefined();
    expect(cursors.activeCount).toBe(MOCK_MAX_CURSORS);
  });

  it("refuses the old cursors after a reset", async () => {
    await startListener();
    const token = await issueToken();
    const first = await call(
      listener!.baseUrl,
      `${DIRECTORY_PATH}?department_id=od_mock_engineering&page_size=1`,
      { headers: bearer(token) },
    );
    const pageToken = (JSON.parse(first.body) as { data: { page_token: string } }).data.page_token;
    expect(pageToken.length).toBeGreaterThan(0);

    const reset = await call(listener!.baseUrl, "/__mock/reset", {
      method: "POST",
      headers: bearer(ADMIN_TOKEN),
      body: "{}",
    });
    expect(reset.status).toBe(200);

    // The reset also invalidated the token, so a fresh one is needed to reach
    // the directory again.
    const freshToken = await issueToken();
    const afterReset = await call(
      listener!.baseUrl,
      `${DIRECTORY_PATH}?department_id=od_mock_engineering&page_size=1&page_token=${pageToken}`,
      { headers: bearer(freshToken) },
    );
    expect(afterReset.status).toBe(400);
    expect(JSON.parse(afterReset.body)).toEqual({ code: 1, msg: "mock_cursor_invalid" });
  });

  it("refuses an unknown department and an out of range page size", async () => {
    await startListener();
    const token = await issueToken();
    const unknown = await call(
      listener!.baseUrl,
      `${DIRECTORY_PATH}?department_id=od_mock_unknown`,
      { headers: bearer(token) },
    );
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({ code: 4, msg: "mock_department_not_found" });

    for (const size of ["0", String(MOCK_MAX_PAGE_SIZE + 1), "abc"]) {
      const invalid = await call(
        listener!.baseUrl,
        `${DIRECTORY_PATH}?department_id=od_mock_engineering&page_size=${size}`,
        { headers: bearer(token) },
      );
      expect(invalid.status).toBe(400);
      expect(JSON.parse(invalid.body)).toEqual({ code: 1, msg: "mock_page_size_invalid" });
    }

    const missing = await call(listener!.baseUrl, DIRECTORY_PATH, { headers: bearer(token) });
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body)).toEqual({ code: 1, msg: "mock_department_id_required" });
  });

  it("answers an empty page for a department without members", () => {
    const state: MockState = {
      users: [],
      departments: [{ open_department_id: "od_mock_empty", name: "Mock Empty" }],
      inboxes: new Map(),
      faults: [],
    };
    const cursors = new MockCursorStore();
    const result = queryDepartment(
      state,
      {
        departmentId: "od_mock_empty",
        departmentIdType: "open_department_id",
        userIdType: "open_id",
        pageSize: 2,
        pageToken: undefined,
      },
      cursors,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.pageToken).toBeUndefined();
  });
});
