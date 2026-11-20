/**
 * FSL-118：Mock 的 Directory v1 员工路由。
 *
 * The mock runs in process. Suspended and resigned members are made by
 * changing the member status of the run state in process; an expired token
 * is made by moving a faked clock past the token lifetime. Every acceptance
 * criterion of the card is one test with one independent predicate.
 */
import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveMockConfig } from "../../src/config";
import { MOCK_TOKEN_TTL_SECONDS } from "../../src/provider";
import { startMockListener, type MockListener } from "../../src/server";
import {
  MOCK_APP_ID,
  MOCK_DEPARTMENT_ENGINEERING,
  MOCK_DEPARTMENT_OPERATIONS,
  statusFlags,
  type MockUserStatus,
} from "../../src/state";

const CONFIG = resolveMockConfig({
  FEISHU_SIMULATOR_ENABLED: "1",
  NODE_ENV: "test",
  FEISHU_SIMULATOR_PORT: "0",
});

const APP_SECRET = "mock-app-secret-for-the-tenant-token";
const ADMIN_TOKEN = "mock-admin-token-for-the-control-plane";
const FORGED_TOKEN = "forged-token-that-this-run-never-issued";
const SEARCH_PATH = "/open-apis/directory/v1/employees/search?employee_id_type=open_id";
const MGET_PATH = "/open-apis/directory/v1/employees/mget?employee_id_type=open_id";
/** The field set the real client asks for (FSL-117). */
const REQUIRED_FIELDS = [
  "base_info.employee_id",
  "base_info.email",
  "base_info.enterprise_email",
  "base_info.name",
  "base_info.active_status",
  "base_info.is_resigned",
  "work_info.staff_status",
];
const ALL_MEMBERS = [
  "ou_mock_alice",
  "ou_mock_bob",
  "ou_mock_carol",
  "ou_mock_dave",
  "ou_mock_erin",
  "ou_mock_frank",
];

interface Employee {
  base_info: {
    employee_id: unknown;
    enterprise_email: unknown;
    email: unknown;
    name: { name: { default_value: unknown; i18n_value: { zh_cn: unknown; en_us: unknown; ja_jp: unknown } } };
    active_status: unknown;
    is_resigned: unknown;
  };
  work_info: unknown;
}

interface Answer {
  status: number;
  body: string;
  json: Record<string, unknown>;
}

let listener: MockListener | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await listener?.close();
  listener = undefined;
});

function call(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  const target = new URL(path, listener!.baseUrl);
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
          let json: Record<string, unknown>;
          try {
            json = JSON.parse(body) as Record<string, unknown>;
          } catch {
            json = {};
          }
          resolvePromise({ status: response.statusCode ?? 0, body, json });
        });
      },
    );
    outgoing.on("error", reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

async function startListener(): Promise<void> {
  listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN, appSecret: APP_SECRET });
}

async function issueToken(): Promise<string> {
  const response = await call("/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: JSON.stringify({ app_id: MOCK_APP_ID, app_secret: APP_SECRET }),
  });
  expect(response.status).toBe(200);
  return response.json.tenant_access_token as string;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function search(query: string, headers: Record<string, string>): Promise<Answer> {
  return call(SEARCH_PATH, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, required_fields: REQUIRED_FIELDS, page_request: { page_size: 10 } }),
  });
}

function mget(ids: string[], headers: Record<string, string>): Promise<Answer> {
  return call(MGET_PATH, {
    method: "POST",
    headers,
    body: JSON.stringify({ employee_ids: ids, required_fields: REQUIRED_FIELDS }),
  });
}

function setStatus(openId: string, status: MockUserStatus): void {
  const user = listener!.state.users.find((candidate) => candidate.open_id === openId);
  if (user === undefined) throw new Error(`no synthetic member ${openId}`);
  user.status = statusFlags(status);
}

function employeesOf(answer: Answer): Employee[] {
  return (answer.json.data as { employees: Employee[] }).employees;
}

function idsOf(answer: Answer): unknown[] {
  return employeesOf(answer).map((employee) => employee.base_info.employee_id);
}

function errorOf(answer: Answer): Record<string, unknown> {
  return answer.json.error as Record<string, unknown>;
}

/** One predicate per employee field, shared by the search and the mget shape criteria. */
const FIELD_PREDICATES: ReadonlyArray<[string, (employee: Employee) => boolean]> = [
  ["base_info.employee_id is a string", (e) => typeof e.base_info.employee_id === "string"],
  ["base_info.enterprise_email is a string", (e) => typeof e.base_info.enterprise_email === "string"],
  ["base_info.email is a string", (e) => typeof e.base_info.email === "string"],
  ["base_info.name.name.default_value is a string", (e) => typeof e.base_info.name.name.default_value === "string"],
  ["base_info.name.name.i18n_value.zh_cn is a string", (e) => typeof e.base_info.name.name.i18n_value.zh_cn === "string"],
  ["base_info.name.name.i18n_value.en_us is a string", (e) => typeof e.base_info.name.name.i18n_value.en_us === "string"],
  ["base_info.name.name.i18n_value.ja_jp is a string", (e) => typeof e.base_info.name.name.i18n_value.ja_jp === "string"],
  ["base_info.active_status is an integer", (e) => Number.isInteger(e.base_info.active_status)],
  ["base_info.is_resigned is a boolean", (e) => typeof e.base_info.is_resigned === "boolean"],
  [
    "work_info equals {}",
    (e) =>
      typeof e.work_info === "object" &&
      e.work_info !== null &&
      !Array.isArray(e.work_info) &&
      Object.keys(e.work_info).length === 0,
  ],
];

describe("Directory v1 employees/search (FSL-118)", () => {
  let token = "";

  beforeEach(async () => {
    await startListener();
    token = await issueToken();
  });

  it("AC1 search by a member's enterprise_email returns that member", async () => {
    const answer = await search("dave@corp.example.com", bearer(token));
    expect(idsOf(answer)).toContain("ou_mock_dave");
  });

  it("AC2 search by a member's email returns that member", async () => {
    const answer = await search("alice@example.com", bearer(token));
    expect(idsOf(answer)).toContain("ou_mock_alice");
  });

  it("AC3 search by a substring several members share returns all of these active members", async () => {
    const answer = await search("example.com", bearer(token));
    expect([...idsOf(answer)].sort()).toEqual([
      "ou_mock_alice",
      "ou_mock_bob",
      "ou_mock_dave",
      "ou_mock_erin",
      "ou_mock_frank",
    ]);
  });

  it("AC4 search by the enterprise_email two members share returns both members", async () => {
    const answer = await search("shared@corp.example.com", bearer(token));
    expect([...idsOf(answer)].sort()).toEqual(["ou_mock_erin", "ou_mock_frank"]);
  });

  it("AC5 search by an address nobody has returns an empty employees array", async () => {
    const answer = await search("nobody@corp.example.com", bearer(token));
    expect(employeesOf(answer)).toEqual([]);
  });

  it("AC6 search by a resigned member's address does not return that member", async () => {
    setStatus("ou_mock_bob", "resigned");
    const answer = await search("bob@example.com", bearer(token));
    expect(idsOf(answer)).not.toContain("ou_mock_bob");
  });

  it("AC7 a successful search answers msg as the empty string", async () => {
    const answer = await search("example.com", bearer(token));
    expect(answer.json.msg).toBe("");
  });

  it("AC8 a successful search answers page_response.has_more as false", async () => {
    const answer = await search("example.com", bearer(token));
    expect((answer.json.data as { page_response: { has_more: unknown } }).page_response.has_more).toBe(false);
  });

  it("AC9 a successful search answers page_response.page_token as a string", async () => {
    const answer = await search("example.com", bearer(token));
    expect(typeof (answer.json.data as { page_response: { page_token: unknown } }).page_response.page_token).toBe(
      "string",
    );
  });

  it("AC18 a successful search answers code as the integer 0", async () => {
    const answer = await search("example.com", bearer(token));
    expect(answer.json.code).toBe(0);
  });

  it.each(FIELD_PREDICATES.map(([name, predicate], index) => [19 + index, name, predicate] as const))(
    "AC%i search: every employee's %s",
    async (_ac, _name, predicate) => {
      // "Mock" is in every name, so the shape is checked on every non-resigned member.
      const answer = await search("mock", bearer(token));
      const employees = employeesOf(answer);
      expect(employees.length).toBe(ALL_MEMBERS.length);
      expect(employees.every(predicate)).toBe(true);
    },
  );

  // Behaviour beyond the numbered criteria: the matching rules of the card.
  it("matches ignoring case", async () => {
    const answer = await search("ALICE@EXAMPLE.COM", bearer(token));
    expect(idsOf(answer)).toEqual(["ou_mock_alice"]);
  });

  it("matches the member name", async () => {
    const answer = await search("carol", bearer(token));
    expect(idsOf(answer)).toEqual(["ou_mock_carol"]);
  });

  it("still returns a suspended member", async () => {
    setStatus("ou_mock_dave", "suspended");
    const answer = await search("dave@corp.example.com", bearer(token));
    expect(idsOf(answer)).toEqual(["ou_mock_dave"]);
  });

  it("derives the three name values from the synthetic name", async () => {
    const answer = await search("dave@corp.example.com", bearer(token));
    const name = employeesOf(answer)[0]!.base_info.name.name;
    expect(name.default_value).toBe("Mock Dave");
    expect(name.i18n_value).toEqual({ zh_cn: "Mock Dave", en_us: "Mock Dave", ja_jp: "Mock Dave" });
  });

  it("requires employee_id_type=open_id", async () => {
    const body = JSON.stringify({ query: "dave" });
    const missing = await call("/open-apis/directory/v1/employees/search", {
      method: "POST",
      headers: bearer(token),
      body,
    });
    expect(missing.json).toEqual({ code: 1, msg: "mock_id_type_required" });
    const wrong = await call("/open-apis/directory/v1/employees/search?employee_id_type=user_id", {
      method: "POST",
      headers: bearer(token),
      body,
    });
    expect(wrong.json).toEqual({ code: 1, msg: "mock_id_type_invalid" });
  });

  it("refuses a blank query and unknown body fields", async () => {
    const blank = await call(SEARCH_PATH, { method: "POST", headers: bearer(token), body: JSON.stringify({ query: " " }) });
    expect(blank.json).toEqual({ code: 1, msg: "mock_body_invalid" });
    const unknown = await call(SEARCH_PATH, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ query: "dave", extra: true }),
    });
    expect(unknown.json).toEqual({ code: 1, msg: "mock_unknown_field" });
  });
});

describe("Directory v1 employees/mget (FSL-118)", () => {
  let token = "";

  beforeEach(async () => {
    await startListener();
    token = await issueToken();
  });

  async function readOne(openId: string): Promise<Employee> {
    const answer = await mget([openId], bearer(token));
    const employees = employeesOf(answer);
    expect(employees).toHaveLength(1);
    return employees[0]!;
  }

  it("AC10 reading an active member answers active_status=2", async () => {
    expect((await readOne("ou_mock_alice")).base_info.active_status).toBe(2);
  });

  it("AC11 reading an active member answers is_resigned=false", async () => {
    expect((await readOne("ou_mock_alice")).base_info.is_resigned).toBe(false);
  });

  it("AC12 reading a suspended member answers active_status=3", async () => {
    setStatus("ou_mock_bob", "suspended");
    expect((await readOne("ou_mock_bob")).base_info.active_status).toBe(3);
  });

  it("AC13 reading a suspended member answers is_resigned=false", async () => {
    setStatus("ou_mock_bob", "suspended");
    expect((await readOne("ou_mock_bob")).base_info.is_resigned).toBe(false);
  });

  it("AC14 reading a resigned member answers active_status=4", async () => {
    setStatus("ou_mock_bob", "resigned");
    expect((await readOne("ou_mock_bob")).base_info.active_status).toBe(4);
  });

  it("AC15 reading a resigned member answers is_resigned=true", async () => {
    setStatus("ou_mock_bob", "resigned");
    expect((await readOne("ou_mock_bob")).base_info.is_resigned).toBe(true);
  });

  it("AC16 reading an unknown open_id answers an empty employees array", async () => {
    const answer = await mget(["ou_mock_unknown"], bearer(token));
    expect(employeesOf(answer)).toEqual([]);
  });

  it("AC17 a successful mget answers data.abnormals as an array", async () => {
    const answer = await mget(["ou_mock_alice"], bearer(token));
    expect(Array.isArray((answer.json.data as { abnormals: unknown }).abnormals)).toBe(true);
  });

  it("AC29 a successful mget answers code as the integer 0", async () => {
    const answer = await mget(["ou_mock_alice"], bearer(token));
    expect(answer.json.code).toBe(0);
  });

  it.each(FIELD_PREDICATES.map(([name, predicate], index) => [30 + index, name, predicate] as const))(
    "AC%i mget: every employee's %s",
    async (_ac, _name, predicate) => {
      // Every synthetic member, with one suspended and one resigned.
      setStatus("ou_mock_bob", "suspended");
      setStatus("ou_mock_carol", "resigned");
      const answer = await mget(ALL_MEMBERS, bearer(token));
      const employees = employeesOf(answer);
      expect(employees.length).toBe(ALL_MEMBERS.length);
      expect(employees.every(predicate)).toBe(true);
    },
  );

  // Behaviour beyond the numbered criteria.
  it("records an unknown open_id in abnormals and keeps the request order", async () => {
    const answer = await mget(["ou_mock_frank", "ou_mock_unknown", "ou_mock_alice"], bearer(token));
    expect(idsOf(answer)).toEqual(["ou_mock_frank", "ou_mock_alice"]);
    const abnormals = (answer.json.data as { abnormals: { id: unknown }[] }).abnormals;
    expect(abnormals.map((abnormal) => abnormal.id)).toEqual(["ou_mock_unknown"]);
  });

  // The abnormal item shape follows the official docs; it is not measured on a real tenant.
  it("answers an unknown open_id with the documented abnormal item shape", async () => {
    const answer = await mget(["ou_mock_unknown"], bearer(token));
    const abnormals = (answer.json.data as { abnormals: unknown[] }).abnormals;
    expect(abnormals).toStrictEqual([
      {
        id: "ou_mock_unknown",
        row_error: 0,
        field_errors: { "base_info.employee_id": 2002 },
      },
    ]);
  });

  it("answers a deleted member as unknown", async () => {
    listener!.state.users = listener!.state.users.filter((user) => user.open_id !== "ou_mock_bob");
    const answer = await mget(["ou_mock_bob"], bearer(token));
    expect(employeesOf(answer)).toEqual([]);
  });

  it("requires employee_id_type=open_id and a list of ids", async () => {
    const missing = await call("/open-apis/directory/v1/employees/mget", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ employee_ids: ["ou_mock_alice"] }),
    });
    expect(missing.json).toEqual({ code: 1, msg: "mock_id_type_required" });
    const empty = await mget([], bearer(token));
    expect(empty.json).toEqual({ code: 1, msg: "mock_body_invalid" });
  });
});

describe.each([
  { route: "search", base: 40, send: (headers: Record<string, string>) => search("dave", headers) },
  { route: "mget", base: 54, send: (headers: Record<string, string>) => mget(["ou_mock_alice"], headers) },
])("Directory v1 employees/$route authentication failures (FSL-118)", ({ route, base, send }) => {
  beforeEach(async () => {
    await startListener();
  });

  it(`AC${base} ${route} without Authorization answers HTTP 400`, async () => {
    expect((await send({})).status).toBe(400);
  });

  it(`AC${base + 1} ${route} without Authorization answers code 99991661`, async () => {
    expect((await send({})).json.code).toBe(99991661);
  });

  it(`AC${base + 2} ${route} without Authorization answers a msg starting with the measured text`, async () => {
    expect(String((await send({})).json.msg).startsWith("Missing access token for authorization")).toBe(true);
  });

  it(`AC${base + 3} ${route} without Authorization answers error.log_id as a string`, async () => {
    expect(typeof errorOf(await send({})).log_id).toBe("string");
  });

  it(`AC${base + 4} ${route} without Authorization answers error.troubleshooter as a string`, async () => {
    expect(typeof errorOf(await send({})).troubleshooter).toBe("string");
  });

  it(`AC${base + 5} ${route} without Authorization answers a body without data`, async () => {
    expect("data" in (await send({})).json).toBe(false);
  });

  it(`AC${base + 6} ${route} with a forged token answers HTTP 400`, async () => {
    expect((await send(bearer(FORGED_TOKEN))).status).toBe(400);
  });

  it(`AC${base + 7} ${route} with a forged token answers code 99991663`, async () => {
    expect((await send(bearer(FORGED_TOKEN))).json.code).toBe(99991663);
  });

  it(`AC${base + 8} ${route} with a forged token answers a msg starting with the measured text`, async () => {
    expect(String((await send(bearer(FORGED_TOKEN))).json.msg).startsWith("Invalid access token for authorization")).toBe(
      true,
    );
  });

  it(`AC${base + 9} ${route} with a forged token answers error.message as a string`, async () => {
    expect(typeof errorOf(await send(bearer(FORGED_TOKEN))).message).toBe("string");
  });

  it(`AC${base + 10} ${route} with a forged token answers error.log_id as a string`, async () => {
    expect(typeof errorOf(await send(bearer(FORGED_TOKEN))).log_id).toBe("string");
  });

  it(`AC${base + 11} ${route} with a forged token answers error.troubleshooter as a string`, async () => {
    expect(typeof errorOf(await send(bearer(FORGED_TOKEN))).troubleshooter).toBe("string");
  });

  it(`AC${base + 12} ${route} with a forged token answers a body without data`, async () => {
    expect("data" in (await send(bearer(FORGED_TOKEN))).json).toBe(false);
  });

  it(`AC${base + 13} ${route} with an expired mock token answers code 99991663`, async () => {
    // The token store reads the clock it was built with, so the clock is
    // faked before a fresh listener is started.
    await listener!.close();
    vi.useFakeTimers({ toFake: ["Date"] });
    await startListener();
    const expired = await issueToken();
    vi.setSystemTime(Date.now() + (MOCK_TOKEN_TTL_SECONDS + 1) * 1000);
    expect((await send(bearer(expired))).json.code).toBe(99991663);
  });

  // Beyond the numbered criteria: the answer never echoes the presented token.
  it(`${route} never echoes a rejected token`, async () => {
    expect((await send(bearer(FORGED_TOKEN))).body).not.toContain(FORGED_TOKEN);
  });
});

describe("unchanged neighbours of the Directory v1 routes (FSL-118)", () => {
  beforeEach(async () => {
    await startListener();
  });

  it("AC68 the token, single member and message routes keep their authentication failures", async () => {
    const tokenRoute = await call("/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: JSON.stringify({ app_id: MOCK_APP_ID, app_secret: "not-the-secret" }),
    });
    expect({ status: tokenRoute.status, body: tokenRoute.json }).toEqual({
      status: 401,
      body: { code: 2, msg: "mock_app_credentials_invalid" },
    });
    const userRoute = await call(
      "/open-apis/contact/v3/users/ou_mock_alice?user_id_type=open_id&department_id_type=open_department_id",
      { headers: bearer(FORGED_TOKEN) },
    );
    expect({ status: userRoute.status, body: userRoute.json }).toEqual({
      status: 401,
      body: { code: 2, msg: "mock_provider_unauthorized" },
    });
    const messageRoute = await call("/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: "POST",
      body: JSON.stringify({
        receive_id: "ou_mock_alice",
        msg_type: "text",
        content: JSON.stringify({ text: "hello" }),
        uuid: "uuid-auth",
      }),
    });
    expect({ status: messageRoute.status, body: messageRoute.json }).toEqual({
      status: 401,
      body: { code: 2, msg: "mock_provider_unauthorized" },
    });
  });

  it("AC69 the state view lists the three new synthetic members", async () => {
    const view = await call("/__mock/state", { headers: bearer(ADMIN_TOKEN) });
    const ids = (view.json.data as { users: { open_id: string }[] }).users.map((user) => user.open_id);
    expect(ids).toEqual(expect.arrayContaining(["ou_mock_dave", "ou_mock_erin", "ou_mock_frank"]));
  });

  it("AC70 the new members stay out of the department pages", async () => {
    const token = await issueToken();
    const read = async (department: string) => {
      const answer = await call(
        `/open-apis/contact/v3/users/find_by_department?department_id=${department}&page_size=100`,
        { headers: bearer(token) },
      );
      return (answer.json.data as { items: { open_id: string }[] }).items.map((item) => item.open_id);
    };
    expect({
      engineering: await read(MOCK_DEPARTMENT_ENGINEERING),
      operations: await read(MOCK_DEPARTMENT_OPERATIONS),
    }).toEqual({
      engineering: ["ou_mock_alice", "ou_mock_bob"],
      operations: ["ou_mock_carol"],
    });
  });
});
