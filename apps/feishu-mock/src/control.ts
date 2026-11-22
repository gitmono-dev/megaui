/**
 * FSM-07：受保护控制面。
 *
 * 控制面只属于本 Mock 进程：只接受本 run 独立生成的 admin Bearer，带 Origin 的
 * 请求一律拒绝，且任何响应都不开放 CORS。控制面成功响应使用 `{code:0,data:...}`，
 * 错误沿用冻结的 `{code,msg}` 合同。
 *
 * FSM-08 起本模块也承载 reset：它调用已注册 store 的重置器恢复 synthetic 初态，
 * 并在成功响应前取消全部已注册在途任务。
 *
 * FSL-140 起控制面不再注入消息、校验回调地址或重放事件；成员路由只剩
 * `PATCH /__mock/users/:open_id`，它只修改目标成员的在职状态，不发送回调、
 * 不记录事件。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import {
  mockError,
  readJsonBody,
  requestHasBody,
  sendMockError,
  sendMockJson,
  type MockHttpError,
} from "./http";
import type { MockFaultStore } from "./faults";
import type { MockLifecycle } from "./lifecycle";
import { statusFlags, type MockState, type MockUserStatus } from "./state";

export const MOCK_CONTROL_PREFIX = "/__mock/";

/** The prefix of the member status control, `PATCH /__mock/users/:open_id`. */
export const MOCK_CONTROL_USERS_PREFIX = "/__mock/users/";

/** Paths of the control plane this run delivers. */
export const MOCK_CONTROL_DELIVERED_PATHS: readonly string[] = [
  "/__mock/state",
  "/__mock/reset",
  "/__mock/faults",
  MOCK_CONTROL_USERS_PREFIX,
];

export interface MockControlContext {
  /** This run's admin bearer; without it the control plane accepts nothing. */
  adminToken: string | undefined;
  headers: IncomingHttpHeaders;
}

export interface MockControlStateView {
  users: MockState["users"];
  inboxes: Record<string, unknown[]>;
  faults: unknown[];
}

export interface MockControlSuccess {
  code: 0;
  data: MockControlStateView;
}

/**
 * Checks the control plane gate.
 *
 * A request must present this run's admin bearer; a provider token or any
 * other credential is refused. A request that carries an Origin is refused as
 * well, and the server never answers with CORS headers.
 */
export function authorizeControlRequest(context: MockControlContext): MockHttpError | undefined {
  const header = context.headers.authorization;
  if (header === undefined) {
    return mockError(2, "mock_admin_token_missing");
  }
  const presented = parseBearer(header);
  if (presented === undefined) {
    return mockError(2, "mock_admin_token_invalid");
  }
  if (context.adminToken === undefined || !equalsSecret(presented, context.adminToken)) {
    return mockError(2, "mock_admin_token_invalid");
  }
  if (context.headers.origin !== undefined) {
    return mockError(3, "mock_control_origin_rejected");
  }
  return undefined;
}

/** Extracts the bearer token, or undefined when the header is not a bearer. */
export function parseBearer(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  const separator = value.indexOf(" ");
  if (separator === -1) return undefined;
  const scheme = value.slice(0, separator).toLowerCase();
  const token = value.slice(separator + 1).trim();
  if (scheme !== "bearer" || token === "" || /\s/.test(token)) return undefined;
  return token;
}

/** Compares two secrets without leaking their contents through timing. */
function equalsSecret(presented: string, expected: string): boolean {
  const left = createHash("sha256").update(presented, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}

/**
 * Builds the state view.
 *
 * Only the frozen business summary is exposed: the directory users, the
 * inboxes grouped by open id and the fault rules. Runtime configuration,
 * tokens and secrets are never part of this view.
 */
export function buildStateView(state: MockState): MockControlSuccess {
  return {
    code: 0,
    data: {
      users: state.users.map((user) => ({ ...user, department_ids: [...user.department_ids] })),
      // fromEntries defines own properties, so an id like "__proto__" can
      // never reach the prototype of the view.
      inboxes: Object.fromEntries(
        [...state.inboxes].map(([openId, messages]) => [openId, messages.map((entry) => ({ ...entry }))]),
      ),
      faults: state.faults.map((fault) => ({ ...fault })),
    },
  };
}

/**
 * Serves the control plane.
 *
 * The gate comes first: the control plane accepts nothing but this run's admin
 * bearer, and a request that carries an Origin is refused. Only the routes
 * this run delivers exist: state, reset, faults and the member status
 * control; every other path answers the frozen 404.
 */
export interface MockControlDeps {
  faults?: MockFaultStore;
}

export async function handleControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  state: MockState,
  lifecycle: MockLifecycle,
  adminToken: string | undefined,
  deps: MockControlDeps = {},
): Promise<void> {
  const unauthorized = authorizeControlRequest({ adminToken, headers: request.headers });
  if (unauthorized) {
    sendMockError(response, unauthorized);
    return;
  }
  if (path === "/__mock/state") {
    if (request.method !== "GET") {
      sendMockError(response, mockError(4, "not_found"));
      return;
    }
    sendMockJson(response, 200, buildStateView(state));
    return;
  }
  if (path === "/__mock/reset") {
    if (request.method !== "POST") {
      sendMockError(response, mockError(4, "not_found"));
      return;
    }
    if (requestHasBody(request.headers)) {
      const result = await readJsonBody(request, []);
      if (!result.ok) {
        sendMockError(response, result.error);
        return;
      }
    }
    // The reset only reports success once every registered task was aborted
    // and every registered store restored its initial state.
    const generation = await lifecycle.reset();
    sendMockJson(response, 200, { code: 0, data: { generation } });
    return;
  }
  if (path.startsWith(MOCK_CONTROL_USERS_PREFIX)) {
    await handleMemberStatus(request, response, path, state);
    return;
  }
  if (path === "/__mock/faults") {
    await handleFaultAdd(request, response, deps.faults);
    return;
  }
  sendMockError(response, mockError(4, "not_found"));
}

/**
 * Adds one bounded provider fault rule.
 *
 * Only the frozen targets and the synchronous kinds are accepted here; a
 * timeout or a disconnect rule is refused because this card registers no
 * asynchronous handler for them.
 */
async function handleFaultAdd(
  request: IncomingMessage,
  response: ServerResponse,
  faults: MockFaultStore | undefined,
): Promise<void> {
  if (request.method !== "POST") {
    sendMockError(response, mockError(4, "not_found"));
    return;
  }
  if (faults === undefined) {
    sendMockError(response, mockError(1, "mock_fault_target_invalid"));
    return;
  }
  const body = await readJsonBody(request, ["target", "kind", "count", "skip"]);
  if (!body.ok) {
    sendMockError(response, body.error);
    return;
  }
  const added = faults.add(body.body);
  if (!added.ok) {
    sendMockError(response, added.error);
    return;
  }
  sendMockJson(response, 200, { code: 0, data: { rule: added.rule } });
}

/**
 * Sets the employment status of one synthetic member.
 *
 * This is a test control for the Feishu login tests: it changes only the
 * status of the target member, sends no callback and records no event. Every
 * method other than PATCH answers the frozen 404 and changes nothing.
 */
async function handleMemberStatus(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  state: MockState,
): Promise<void> {
  if (request.method !== "PATCH") {
    sendMockError(response, mockError(4, "not_found"));
    return;
  }
  let openId: string;
  try {
    openId = decodeURIComponent(path.slice(MOCK_CONTROL_USERS_PREFIX.length));
  } catch {
    sendMockError(response, mockError(4, "mock_user_not_found"));
    return;
  }
  const user = state.users.find((candidate) => candidate.open_id === openId);
  if (user === undefined) {
    sendMockError(response, mockError(4, "mock_user_not_found"));
    return;
  }
  const body = await readJsonBody(request, ["status"]);
  if (!body.ok) {
    sendMockError(response, body.error);
    return;
  }
  const status = body.body.status;
  if (status !== "active" && status !== "suspended" && status !== "resigned") {
    sendMockError(response, mockError(1, "mock_status_invalid"));
    return;
  }
  user.status = statusFlags(status as MockUserStatus);
  sendMockJson(response, 200, {
    code: 0,
    data: { user: { ...user, department_ids: [...user.department_ids], status: { ...user.status } } },
  });
}
