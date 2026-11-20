/**
 * FSL-118：Directory v1 员工路由。
 *
 * `POST /open-apis/directory/v1/employees/search` 与
 * `POST /open-apis/directory/v1/employees/mget`（都要求
 * `employee_id_type=open_id`）直接读取本 run 的 `state.users`，按 FSL-115 与
 * FSL-164 在真实租户实测的形状应答：搜索是对姓名、`email` 与
 * `enterprise_email` 的大小写不敏感子串匹配，不返回离职成员，一次返回全部
 * 候选；批量读取对离职成员同样返回，未知 open_id 只记入 `abnormals`。
 *
 * 鉴权失败沿用实测的 Directory v1 形状（HTTP 400，`code` 99991661 /
 * 99991663，带 `error`、无 `data`），不回显请求里的 token。其它 provider
 * 路由的鉴权错误不受影响。
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { parseBearer } from "./control";
import { mockError, readJsonBody, sendMockError, sendMockJson } from "./http";
import { MOCK_APP_ID, type MockState, type MockUser, type MockUserStatus } from "./state";

/** The only employee id type the Directory v1 routes accept. Defined here so the
 * routes never depend on the department-directory module FSL-167 deletes. */
const EMPLOYEE_ID_TYPE = "open_id";

/**
 * The tenant token check the routes need. It is structural, so this module
 * does not import `provider.ts`, which dispatches to it.
 */
export interface MockTenantValidator {
  validate(bearer: string | undefined, appId: string): boolean;
}

/** The Directory v1 search route. */
export const MOCK_EMPLOYEES_SEARCH_PATH = "/open-apis/directory/v1/employees/search";

/** The Directory v1 batch read route. */
export const MOCK_EMPLOYEES_MGET_PATH = "/open-apis/directory/v1/employees/mget";

/** The business code of a request without an access token (measured). */
export const MOCK_DIRECTORY_V1_MISSING_TOKEN_CODE = 99991661;

/** The business code of a request whose access token is not accepted (measured). */
export const MOCK_DIRECTORY_V1_INVALID_TOKEN_CODE = 99991663;

/** The most ids one batch read accepts. */
export const MOCK_EMPLOYEES_MGET_MAX_IDS = 100;

/** The largest search page size the mock accepts; every candidate is returned at once. */
export const MOCK_EMPLOYEES_SEARCH_MAX_PAGE_SIZE = 100;

/** Fixed values of the `error` object; never derived from the request. */
export const MOCK_DIRECTORY_V1_LOG_ID = "mock_log_id";
export const MOCK_DIRECTORY_V1_TROUBLESHOOTER =
  "mock troubleshooter: see docs/implementation/feishu-simulator.md";
export const MOCK_DIRECTORY_V1_INVALID_TOKEN_MESSAGE = "mock: the access token is not accepted";

const MISSING_TOKEN_MSG =
  "Missing access token for authorization. Please make a request with token attached.";
const INVALID_TOKEN_MSG =
  "Invalid access token for authorization. Please make a request with token attached.";

/** The field-level code the official documentation lists for "user does not exist". */
const ABNORMAL_USER_NOT_FOUND = 2002;

/** The `active_status` value and resignation flag of each synthetic status. */
const STATUS_FIELDS: Record<MockUserStatus, { active_status: number; is_resigned: boolean }> = {
  active: { active_status: 2, is_resigned: false },
  suspended: { active_status: 3, is_resigned: false },
  resigned: { active_status: 4, is_resigned: true },
};

/** One employee in the measured Directory v1 shape. */
export interface MockDirectoryEmployee {
  base_info: {
    employee_id: string;
    enterprise_email: string;
    email: string;
    name: {
      name: {
        default_value: string;
        i18n_value: { zh_cn: string; en_us: string; ja_jp: string };
      };
    };
    active_status: number;
    is_resigned: boolean;
  };
  work_info: Record<string, never>;
}

/** An unknown id of a batch read (official documentation; not measured). */
export interface MockDirectoryAbnormal {
  id: string;
  row_error: number;
  field_errors: Record<string, number>;
}

/** Reads the status enum back from the frozen four boolean flags. */
export function memberStatus(user: MockUser): MockUserStatus {
  if (user.status.is_resigned || user.status.is_exited) return "resigned";
  if (user.status.is_frozen) return "suspended";
  return "active";
}

/** Builds the measured employee shape of one synthetic member. */
export function toDirectoryEmployee(user: MockUser): MockDirectoryEmployee {
  const status = STATUS_FIELDS[memberStatus(user)];
  return {
    base_info: {
      employee_id: user.open_id,
      enterprise_email: user.enterprise_email,
      email: user.email,
      name: {
        name: {
          default_value: user.name,
          i18n_value: { zh_cn: user.name, en_us: user.name, ja_jp: user.name },
        },
      },
      active_status: status.active_status,
      is_resigned: status.is_resigned,
    },
    // The measured tenant returned no work_info field.
    work_info: {},
  };
}

/**
 * The fuzzy search of the real directory, reduced to a substring match.
 *
 * A member is a candidate when its name, `email` or `enterprise_email`
 * contains the query, ignoring case. Resigned members are never returned.
 */
export function searchEmployees(state: MockState, query: string): MockDirectoryEmployee[] {
  const wanted = query.toLowerCase();
  return state.users
    .filter((user) => memberStatus(user) !== "resigned")
    .filter((user) =>
      [user.name, user.email, user.enterprise_email].some(
        (value) => value !== "" && value.toLowerCase().includes(wanted),
      ),
    )
    .map(toDirectoryEmployee);
}

/**
 * Reads members by open id, in the order of the request.
 *
 * Resigned members are returned as well; an unknown or deleted open id is
 * only recorded in `abnormals`. A repeated id is answered once.
 */
export function readEmployees(
  state: MockState,
  ids: readonly string[],
): { employees: MockDirectoryEmployee[]; abnormals: MockDirectoryAbnormal[] } {
  const employees: MockDirectoryEmployee[] = [];
  const abnormals: MockDirectoryAbnormal[] = [];
  for (const id of new Set(ids)) {
    const user = state.users.find((candidate) => candidate.open_id === id);
    if (user === undefined) {
      abnormals.push({
        id,
        row_error: 0,
        field_errors: { "base_info.employee_id": ABNORMAL_USER_NOT_FOUND },
      });
      continue;
    }
    employees.push(toDirectoryEmployee(user));
  }
  return { employees, abnormals };
}

/**
 * Serves both Directory v1 employee routes.
 *
 * The order of the checks follows the other provider routes: method, tenant
 * token, id type, then the body.
 */
export async function handleEmployeesRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  state: MockState,
  tokens: MockTenantValidator,
): Promise<void> {
  if (request.method !== "POST") {
    sendMockError(response, mockError(4, "not_found"));
    return;
  }
  if (!authorize(request, response, tokens)) return;
  const parameters = new URLSearchParams(
    request.url && request.url.includes("?") ? request.url.slice(request.url.indexOf("?") + 1) : "",
  );
  const employeeIdType = parameters.get("employee_id_type");
  if (employeeIdType === null) {
    sendMockError(response, mockError(1, "mock_id_type_required"));
    return;
  }
  if (employeeIdType !== EMPLOYEE_ID_TYPE) {
    sendMockError(response, mockError(1, "mock_id_type_invalid"));
    return;
  }
  if (path === MOCK_EMPLOYEES_SEARCH_PATH) {
    await handleSearch(request, response, state);
    return;
  }
  await handleMget(request, response, state);
}

/**
 * Answers the measured authentication failures.
 *
 * Without a bearer token the request is "missing" (99991661); a bearer this
 * run did not issue, that expired or that belongs to another app is
 * "invalid" (99991663). Neither answer echoes the presented token.
 */
function authorize(request: IncomingMessage, response: ServerResponse, tokens: MockTenantValidator): boolean {
  const bearer = parseBearer(request.headers.authorization);
  if (bearer === undefined) {
    sendMockJson(response, 400, {
      code: MOCK_DIRECTORY_V1_MISSING_TOKEN_CODE,
      msg: MISSING_TOKEN_MSG,
      error: { log_id: MOCK_DIRECTORY_V1_LOG_ID, troubleshooter: MOCK_DIRECTORY_V1_TROUBLESHOOTER },
    });
    return false;
  }
  if (!tokens.validate(bearer, MOCK_APP_ID)) {
    sendMockJson(response, 400, {
      code: MOCK_DIRECTORY_V1_INVALID_TOKEN_CODE,
      msg: INVALID_TOKEN_MSG,
      error: {
        message: MOCK_DIRECTORY_V1_INVALID_TOKEN_MESSAGE,
        log_id: MOCK_DIRECTORY_V1_LOG_ID,
        troubleshooter: MOCK_DIRECTORY_V1_TROUBLESHOOTER,
      },
    });
    return false;
  }
  return true;
}

async function handleSearch(
  request: IncomingMessage,
  response: ServerResponse,
  state: MockState,
): Promise<void> {
  const body = await readJsonBody(request, ["query", "required_fields", "page_request"]);
  if (!body.ok) {
    sendMockError(response, body.error);
    return;
  }
  const query = body.body.query;
  if (typeof query !== "string" || query.trim() === "") {
    sendMockError(response, mockError(1, "mock_body_invalid"));
    return;
  }
  if (!isRequiredFields(body.body.required_fields) || !isPageRequest(body.body.page_request)) {
    sendMockError(response, mockError(1, "mock_body_invalid"));
    return;
  }
  sendMockJson(response, 200, {
    code: 0,
    msg: "",
    data: {
      employees: searchEmployees(state, query),
      // Every candidate fits on one page, so there is never a next page.
      page_response: { has_more: false, page_token: "" },
    },
  });
}

async function handleMget(
  request: IncomingMessage,
  response: ServerResponse,
  state: MockState,
): Promise<void> {
  const body = await readJsonBody(request, ["employee_ids", "required_fields"]);
  if (!body.ok) {
    sendMockError(response, body.error);
    return;
  }
  const ids = body.body.employee_ids;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > MOCK_EMPLOYEES_MGET_MAX_IDS ||
    !ids.every((id) => typeof id === "string" && id !== "")
  ) {
    sendMockError(response, mockError(1, "mock_body_invalid"));
    return;
  }
  if (!isRequiredFields(body.body.required_fields)) {
    sendMockError(response, mockError(1, "mock_body_invalid"));
    return;
  }
  const result = readEmployees(state, ids as string[]);
  // The msg of a successful mget was not measured; the mock answers "".
  sendMockJson(response, 200, { code: 0, msg: "", data: result });
}

/** `required_fields` is optional; when present it is a list of field names. */
function isRequiredFields(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((field) => typeof field === "string" && field !== "");
}

/** `page_request` is optional; the mock ignores it apart from its type. */
function isPageRequest(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "page_size" && key !== "page_token") return false;
  }
  const pageSize = record.page_size;
  if (
    pageSize !== undefined &&
    (typeof pageSize !== "number" ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > MOCK_EMPLOYEES_SEARCH_MAX_PAGE_SIZE)
  ) {
    return false;
  }
  const pageToken = record.page_token;
  return pageToken === undefined || typeof pageToken === "string";
}
