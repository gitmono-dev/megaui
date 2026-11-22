// megaui-only (FSL-117): unit tests for the Directory v1 member lookup client.
import { describe, expect, it } from "vitest";

import { FeishuTransport, FeishuTransportError } from "./http";
import {
  FEISHU_CONTACT_INVALID_RESPONSE,
  FeishuContactClient,
  FeishuContactError,
} from "./contact";

const ORIGIN = "https://directory.test";
const INPUT_EMAIL = "member@corp.example";
const OPEN_ID = "ou_synthetic_member_0001";
/** Written out independently of the implementation: the field set measured by FSL-115/FSL-164. */
const MEASURED_REQUIRED_FIELDS = [
  "base_info.employee_id",
  "base_info.email",
  "base_info.enterprise_email",
  "base_info.name",
  "base_info.active_status",
  "base_info.is_resigned",
  "work_info.staff_status",
];

interface Recorded {
  readonly url: string;
  readonly body: unknown;
  readonly authorization: string | null;
}

/** A client over the real transport whose fetch answers with fixed responses. */
function clientFor(...answers: Array<{ status?: number; body: unknown }>) {
  const calls: Recorded[] = [];
  let index = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers.get("authorization"),
    });
    const answer = answers[Math.min(index, answers.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const transport = new FeishuTransport({
    target: { provider: "feishu", origin: ORIGIN },
    fetchImpl,
    budgetMs: 2_000,
    backoffMs: 1,
  });
  const client = new FeishuContactClient({
    transport,
    credentials: { tenantKey: "tenant", appId: "cli_app", appSecret: "secret" },
    getToken: async () => "t-unit-token",
  });
  return { client, calls };
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    base_info: {
      employee_id: OPEN_ID,
      enterprise_email: INPUT_EMAIL,
      email: "",
      name: { name: { default_value: "成员", i18n_value: { zh_cn: "成员", en_us: "", ja_jp: "" } } },
      active_status: 2,
      is_resigned: false,
      ...overrides,
    },
    work_info: {},
  };
}

function searchBody(
  employees: unknown,
  /** `null` omits `page_response` entirely. */
  pageResponse: unknown = { has_more: false, page_token: "" },
): Record<string, unknown> {
  const data: Record<string, unknown> = { employees };
  if (pageResponse !== null) data.page_response = pageResponse;
  return { code: 0, msg: "", data };
}

function mgetBody(employees: unknown): Record<string, unknown> {
  return { code: 0, msg: "success", data: { employees, abnormals: [] } };
}

async function expectInvalid(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(FeishuContactError);
  expect((error as Error).message).toBe(FEISHU_CONTACT_INVALID_RESPONSE);
}

async function expectTransportBusinessCode(promise: Promise<unknown>, code: number) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(FeishuTransportError);
  expect((error as FeishuTransportError).code).toBe("transport_permanent");
  expect((error as FeishuTransportError).status).toBe(200);
  expect((error as FeishuTransportError).businessCode).toBe(code);
}

describe("FeishuContactClient.findByEmail (FSL-117)", () => {
  it("sends the measured search request with the bearer token", async () => {
    const { client, calls } = clientFor({ body: searchBody([candidate()]) });
    await client.findByEmail(INPUT_EMAIL);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${ORIGIN}/open-apis/directory/v1/employees/search?employee_id_type=open_id`);
    expect(calls[0]!.authorization).toBe("Bearer t-unit-token");
    expect(calls[0]!.body).toStrictEqual({
      query: INPUT_EMAIL,
      required_fields: MEASURED_REQUIRED_FIELDS,
      page_request: { page_size: 10 },
    });
  });

  it("AC1: returns the employee_id of the single matching candidate", async () => {
    const { client } = clientFor({ body: searchBody([candidate()]) });
    await expect(client.findByEmail(INPUT_EMAIL)).resolves.toStrictEqual({
      kind: "unique",
      openId: OPEN_ID,
    });
  });

  it("AC2: compares emails case-insensitively", async () => {
    const { client } = clientFor({
      body: searchBody([candidate({ enterprise_email: "Member@CORP.example" })]),
    });
    await expect(client.findByEmail(INPUT_EMAIL)).resolves.toStrictEqual({
      kind: "unique",
      openId: OPEN_ID,
    });
  });

  it("AC3: a non-empty enterprise_email is the only compared address", async () => {
    const { client } = clientFor({
      body: searchBody([
        candidate({ enterprise_email: "other@corp.example", email: INPUT_EMAIL }),
      ]),
    });
    await expect(client.findByEmail(INPUT_EMAIL)).resolves.toStrictEqual({
      kind: "no_unique_target",
    });
  });

  it("AC4: an empty enterprise_email falls back to email", async () => {
    const { client } = clientFor({
      body: searchBody([candidate({ enterprise_email: "", email: INPUT_EMAIL })]),
    });
    await expect(client.findByEmail(INPUT_EMAIL)).resolves.toStrictEqual({
      kind: "unique",
      openId: OPEN_ID,
    });
  });

  it("AC5: zero matching candidates is no unique target", async () => {
    const { client } = clientFor({
      body: searchBody([candidate({ enterprise_email: "other@corp.example" })]),
    });
    await expect(client.findByEmail(INPUT_EMAIL)).resolves.toStrictEqual({
      kind: "no_unique_target",
    });
  });

  it("AC6: two matching candidates is no unique target (double, per docs)", async () => {
    const { client } = clientFor({
      body: searchBody([candidate(), candidate({ employee_id: "ou_synthetic_member_0002" })]),
    });
    await expect(client.findByEmail(INPUT_EMAIL)).resolves.toStrictEqual({
      kind: "no_unique_target",
    });
  });

  it("AC7: has_more=true with one match is no unique target (double, per docs)", async () => {
    const { client } = clientFor({
      body: searchBody([candidate()], { has_more: true, page_token: "next" }),
    });
    await expect(client.findByEmail(INPUT_EMAIL)).resolves.toStrictEqual({
      kind: "no_unique_target",
    });
  });

  it("AC8: a non-zero numeric code propagates the transport error unchanged", async () => {
    const { client } = clientFor({ body: { code: 2220001, msg: "param invalid" } });
    await expectTransportBusinessCode(client.findByEmail(INPUT_EMAIL), 2220001);
  });

  it("AC9: a missing code is an invalid response", async () => {
    const body = searchBody([candidate()]);
    delete body.code;
    const { client } = clientFor({ body });
    await expectInvalid(client.findByEmail(INPUT_EMAIL));
  });

  it("AC10: a non-numeric code is an invalid response", async () => {
    const { client } = clientFor({ body: { ...searchBody([candidate()]), code: "0" } });
    await expectInvalid(client.findByEmail(INPUT_EMAIL));
  });

  it("AC11: missing data.employees is an invalid response", async () => {
    const { client } = clientFor({
      body: { code: 0, msg: "", data: { page_response: { has_more: false } } },
    });
    await expectInvalid(client.findByEmail(INPUT_EMAIL));
  });

  it("AC12: a non-array data.employees is an invalid response", async () => {
    const { client } = clientFor({ body: searchBody({ 0: candidate() }) });
    await expectInvalid(client.findByEmail(INPUT_EMAIL));
  });

  it("AC13: a missing candidate employee_id is an invalid response", async () => {
    const { client } = clientFor({ body: searchBody([candidate({ employee_id: undefined })]) });
    await expectInvalid(client.findByEmail(INPUT_EMAIL));
  });

  it("AC14: a non-string candidate employee_id is an invalid response", async () => {
    const { client } = clientFor({ body: searchBody([candidate({ employee_id: 42 })]) });
    await expectInvalid(client.findByEmail(INPUT_EMAIL));
  });

  it.each(["", "   "])(
    "AC15: a blank candidate employee_id (%j) is an invalid response",
    async (employeeId) => {
      const { client } = clientFor({
        body: searchBody([candidate({ employee_id: employeeId })]),
      });
      await expectInvalid(client.findByEmail(INPUT_EMAIL));
    },
  );

  it("AC16: a missing candidate enterprise_email is an invalid response", async () => {
    const { client } = clientFor({
      body: searchBody([candidate({ enterprise_email: undefined, email: INPUT_EMAIL })]),
    });
    await expectInvalid(client.findByEmail(INPUT_EMAIL));
  });

  it("AC17: a non-string candidate enterprise_email is an invalid response", async () => {
    const { client } = clientFor({
      body: searchBody([candidate({ enterprise_email: null, email: INPUT_EMAIL })]),
    });
    await expectInvalid(client.findByEmail(INPUT_EMAIL));
  });

  it("AC18: a missing candidate email is an invalid response", async () => {
    const { client } = clientFor({ body: searchBody([candidate({ email: undefined })]) });
    await expectInvalid(client.findByEmail(INPUT_EMAIL));
  });

  it("AC19: a non-string candidate email is an invalid response", async () => {
    const { client } = clientFor({ body: searchBody([candidate({ email: 7 })]) });
    await expectInvalid(client.findByEmail(INPUT_EMAIL));
  });

  it("AC20: a missing data.page_response is an invalid response", async () => {
    const { client } = clientFor({ body: searchBody([candidate()], null) });
    await expectInvalid(client.findByEmail(INPUT_EMAIL));
  });

  it("AC21: a missing page_response.has_more is an invalid response", async () => {
    const { client } = clientFor({ body: searchBody([candidate()], { page_token: "" }) });
    await expectInvalid(client.findByEmail(INPUT_EMAIL));
  });

  it("AC22: a non-boolean page_response.has_more is an invalid response", async () => {
    const { client } = clientFor({
      body: searchBody([candidate()], { has_more: "false", page_token: "" }),
    });
    await expectInvalid(client.findByEmail(INPUT_EMAIL));
  });
});

describe("FeishuContactClient.readMember (FSL-117)", () => {
  it("sends the measured mget request with the bearer token", async () => {
    const { client, calls } = clientFor({ body: mgetBody([candidate()]) });
    await client.readMember(OPEN_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${ORIGIN}/open-apis/directory/v1/employees/mget?employee_id_type=open_id`);
    expect(calls[0]!.authorization).toBe("Bearer t-unit-token");
    expect(calls[0]!.body).toStrictEqual({
      employee_ids: [OPEN_ID],
      required_fields: MEASURED_REQUIRED_FIELDS,
    });
  });

  it("AC23: active_status=2 and is_resigned=false is in office", async () => {
    const { client } = clientFor({ body: mgetBody([candidate()]) });
    const result = await client.readMember(OPEN_ID);
    expect(result.kind).toBe("active");
  });

  it("AC24: the in-office name is base_info.name.name.default_value", async () => {
    const { client } = clientFor({ body: mgetBody([candidate()]) });
    await expect(client.readMember(OPEN_ID)).resolves.toStrictEqual({
      kind: "active",
      name: "成员",
    });
  });

  it.each([1, 3, 4, 5])(
    "AC25–AC28: active_status=%i is not in office (double, per docs)",
    async (status) => {
      const { client } = clientFor({ body: mgetBody([candidate({ active_status: status })]) });
      await expect(client.readMember(OPEN_ID)).resolves.toStrictEqual({ kind: "inactive" });
    },
  );

  it("AC29: active_status=2 with is_resigned=true is not in office (double, per docs)", async () => {
    const { client } = clientFor({ body: mgetBody([candidate({ is_resigned: true })]) });
    await expect(client.readMember(OPEN_ID)).resolves.toStrictEqual({ kind: "inactive" });
  });

  it("AC30: a non-zero numeric code propagates the transport error unchanged", async () => {
    const { client } = clientFor({ body: { code: 2220001, msg: "param invalid" } });
    await expectTransportBusinessCode(client.readMember(OPEN_ID), 2220001);
  });

  it("AC31: a missing code is an invalid response", async () => {
    const body = mgetBody([candidate()]);
    delete body.code;
    const { client } = clientFor({ body });
    await expectInvalid(client.readMember(OPEN_ID));
  });

  it("AC32: a non-numeric code is an invalid response", async () => {
    const { client } = clientFor({ body: { ...mgetBody([candidate()]), code: "0" } });
    await expectInvalid(client.readMember(OPEN_ID));
  });

  it("AC33: missing data.employees is an invalid response", async () => {
    const { client } = clientFor({ body: { code: 0, msg: "success", data: { abnormals: [] } } });
    await expectInvalid(client.readMember(OPEN_ID));
  });

  it("AC34: a non-array data.employees is an invalid response", async () => {
    const { client } = clientFor({ body: mgetBody(candidate()) });
    await expectInvalid(client.readMember(OPEN_ID));
  });

  it("AC35: an empty data.employees is an invalid response", async () => {
    const { client } = clientFor({ body: mgetBody([]) });
    await expectInvalid(client.readMember(OPEN_ID));
  });

  it("AC36: two items in data.employees is an invalid response", async () => {
    const { client } = clientFor({ body: mgetBody([candidate(), candidate()]) });
    await expectInvalid(client.readMember(OPEN_ID));
  });

  it("AC37: a missing employee_id is an invalid response", async () => {
    const { client } = clientFor({ body: mgetBody([candidate({ employee_id: undefined })]) });
    await expectInvalid(client.readMember(OPEN_ID));
  });

  it("AC38: a non-string employee_id is an invalid response", async () => {
    const { client } = clientFor({ body: mgetBody([candidate({ employee_id: 1 })]) });
    await expectInvalid(client.readMember(OPEN_ID));
  });

  it.each(["", "  "])("AC39: a blank employee_id (%j) is an invalid response", async (id) => {
    const { client } = clientFor({ body: mgetBody([candidate({ employee_id: id })]) });
    await expectInvalid(client.readMember(OPEN_ID));
  });

  it("AC40: an employee_id other than the requested open_id is an invalid response", async () => {
    const { client } = clientFor({
      body: mgetBody([candidate({ employee_id: "ou_synthetic_member_0002" })]),
    });
    await expectInvalid(client.readMember(OPEN_ID));
  });

  it("AC41: a missing name.name.default_value is an invalid response", async () => {
    const { client } = clientFor({
      body: mgetBody([candidate({ name: { name: { i18n_value: {} } } })]),
    });
    await expectInvalid(client.readMember(OPEN_ID));
  });

  it("AC42: a non-string name.name.default_value is an invalid response", async () => {
    const { client } = clientFor({
      body: mgetBody([candidate({ name: { name: { default_value: 5 } } })]),
    });
    await expectInvalid(client.readMember(OPEN_ID));
  });

  it("AC43: a missing active_status is an invalid response", async () => {
    const { client } = clientFor({ body: mgetBody([candidate({ active_status: undefined })]) });
    await expectInvalid(client.readMember(OPEN_ID));
  });

  it.each(["2", 2.5])("AC44: a non-integer active_status (%j) is an invalid response", async (value) => {
    const { client } = clientFor({ body: mgetBody([candidate({ active_status: value })]) });
    await expectInvalid(client.readMember(OPEN_ID));
  });

  it.each([0, 6, -1])(
    "AC45: an active_status outside 1–5 (%i) is an invalid response",
    async (value) => {
      const { client } = clientFor({ body: mgetBody([candidate({ active_status: value })]) });
      await expectInvalid(client.readMember(OPEN_ID));
    },
  );

  it("AC46: a missing is_resigned is an invalid response", async () => {
    const { client } = clientFor({ body: mgetBody([candidate({ is_resigned: undefined })]) });
    await expectInvalid(client.readMember(OPEN_ID));
  });

  it("AC47: a non-boolean is_resigned is an invalid response", async () => {
    const { client } = clientFor({ body: mgetBody([candidate({ is_resigned: "false" })]) });
    await expectInvalid(client.readMember(OPEN_ID));
  });
});

describe("FeishuContactError (FSL-117)", () => {
  it("AC48: the message is exactly the stable key and carries no request value", async () => {
    const { client } = clientFor({ body: mgetBody([candidate({ is_resigned: "x" })]) });
    const error = await client.readMember(OPEN_ID).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toBe(FEISHU_CONTACT_INVALID_RESPONSE);
    expect(String(error)).not.toContain(OPEN_ID);
    expect(String(error)).not.toContain("t-unit-token");
    expect(String(error)).not.toContain(INPUT_EMAIL);
  });
});
