/**
 * FSM-02：tenant token 签发与准入。
 *
 * 本片只交付 legacy tenant token 接口和 provider Bearer 的准入判定：token 按本
 * run 签发、有效期 7200 秒、活跃上限 32 个，到期可回收后重新分配容量。判定本身
 * 是纯函数单元，不冒称尚无前卡交付的受保护 HTTP 路由。
 *
 * FSM-18 起本模块也承载 provider 的受保护路由：单人读取要用本 run 签发且仍
 * 有效的 tenant token。
 *
 * FSL-118 起本模块把 Directory v1 员工路由分发给 `employees.ts`。
 *
 * FSL-167 起部门目录（`find_by_department` 分页与游标）已删除：该路径在鉴权
 * 之前直接返回冻结的 404。
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  handleEmployeesRequest,
  MOCK_EMPLOYEES_MGET_PATH,
  MOCK_EMPLOYEES_SEARCH_PATH,
} from "./employees";
import { asyncFaultError, faultError, runFaultDelay, type MockFaultStore, type MockFaultTarget } from "./faults";
import type { MockLifecycle } from "./lifecycle";
import { admitMessageInput } from "./message-input";
import { messageSuccessResponse, type MockMessageStore } from "./messages";
import { parseBearer } from "./control";
import {
  mockError,
  readJsonBody,
  sendMockError,
  sendMockJson,
  type MockHttpError,
} from "./http";
import { MOCK_APP_ID, type MockState, type MockUser } from "./state";

/** The lifetime of a tenant token, in seconds. */
export const MOCK_TOKEN_TTL_SECONDS = 7200;

/** How many tenant tokens may be active at the same time. */
export const MOCK_MAX_ACTIVE_TOKENS = 32;

/** The legacy tenant token endpoint. */
export const MOCK_TENANT_TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";

/**
 * The retired department directory endpoint (FSL-167).
 *
 * It sits below the single member prefix, so it is matched first and answered
 * with the frozen 404 before any authentication.
 */
export const MOCK_RETIRED_DIRECTORY_PATH = "/open-apis/contact/v3/users/find_by_department";

/** The only accepted department id type. */
export const MOCK_DEPARTMENT_ID_TYPE = "open_department_id";

/** The only accepted user id type. */
export const MOCK_USER_ID_TYPE = "open_id";

/** The prefix of the single member read endpoint. */
export const MOCK_USER_PATH_PREFIX = "/open-apis/contact/v3/users/";

/** The directed message endpoint. */
export const MOCK_MESSAGE_PATH = "/open-apis/im/v1/messages";

/** Every provider route lives below this prefix. */
export const MOCK_PROVIDER_PREFIX = "/open-apis/";

/**
 * Reads a single member of the current synthetic directory.
 *
 * The mock only knows open ids, so the path value is read as one; a member
 * that is unknown or was deleted is not in the directory anymore.
 */
export function findUser(state: MockState, openId: string): MockUser | undefined {
  return state.users.find((user) => user.open_id === openId);
}

export interface MockAppCredentials {
  appId: string;
  appSecret: string;
}

export interface MockTenantToken {
  token: string;
  appId: string;
  issuedAt: number;
  expiresAt: number;
}

export type MockTokenIssueResult =
  | { ok: true; token: string; expire: number }
  | { ok: false; error: MockHttpError };

/**
 * The tenant tokens of one run.
 *
 * A token is random and bound to this run's app, so it never works in another
 * process or for another app. The clock is injected so that the expiry can be
 * decided deterministically.
 */
export class MockTokenStore {
  #tokens: MockTenantToken[] = [];
  readonly #credentials: MockAppCredentials;
  readonly #now: () => number;

  constructor(credentials: MockAppCredentials, now: () => number = Date.now) {
    this.#credentials = credentials;
    this.#now = now;
  }

  /** The number of tokens that are still valid. */
  get activeCount(): number {
    this.#reclaim();
    return this.#tokens.length;
  }

  /**
   * Issues a token for the matching app credentials.
   *
   * Expired tokens are reclaimed first, so their capacity becomes available
   * again. When the active tokens are at the limit the issuance is refused.
   */
  issue(appId: string, appSecret: string): MockTokenIssueResult {
    if (appId !== this.#credentials.appId || appSecret !== this.#credentials.appSecret) {
      return { ok: false, error: mockError(2, "mock_app_credentials_invalid") };
    }
    this.#reclaim();
    if (this.#tokens.length >= MOCK_MAX_ACTIVE_TOKENS) {
      return { ok: false, error: mockError(6, "mock_token_capacity_exceeded") };
    }
    const issuedAt = this.#now();
    const token = randomBytes(32).toString("base64url");
    this.#tokens.push({
      token,
      appId,
      issuedAt,
      expiresAt: issuedAt + MOCK_TOKEN_TTL_SECONDS * 1000,
    });
    return { ok: true, token, expire: MOCK_TOKEN_TTL_SECONDS };
  }

  /**
   * Decides whether a provider bearer is admitted.
   *
   * Only a token this run issued, that has not expired and that belongs to
   * the given app is admitted.
   */
  validate(bearer: string | undefined, appId: string): boolean {
    if (bearer === undefined || bearer === "") return false;
    const found = this.#tokens.find((candidate) => candidate.token === bearer);
    if (found === undefined) return false;
    if (found.expiresAt <= this.#now()) return false;
    return found.appId === appId;
  }

  /** Forgets every token; the store is registered for reset. */
  reset(): void {
    this.#tokens = [];
  }

  #reclaim(): void {
    const now = this.#now();
    this.#tokens = this.#tokens.filter((candidate) => candidate.expiresAt > now);
  }
}

/**
 * Serves the provider routes.
 *
 * The tenant token route issues a token for the matching app credentials; the
 * protected routes need a tenant token this run issued and still accepts. The
 * retired department directory answers the frozen 404 before authentication.
 */
export async function handleProviderRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  state: MockState,
  tokens: MockTokenStore,
  messages: MockMessageStore,
  faults: MockFaultStore,
  lifecycle: MockLifecycle,
): Promise<void> {
  if (path === MOCK_TENANT_TOKEN_PATH) {
    await handleTenantTokenRequest(request, response, tokens, faults, lifecycle);
    return;
  }
  if (path === MOCK_RETIRED_DIRECTORY_PATH) {
    // FSL-167: the department directory is gone; answer the frozen 404 before
    // authentication, so the single member route never sees this path.
    sendMockError(response, mockError(4, "not_found"));
    return;
  }
  if (path.startsWith(MOCK_USER_PATH_PREFIX)) {
    await handleUserRequest(request, response, path, state, tokens, faults, lifecycle);
    return;
  }
  if (path === MOCK_MESSAGE_PATH) {
    await handleMessageRequest(request, response, state, tokens, messages, faults, lifecycle);
    return;
  }
  if (path === MOCK_EMPLOYEES_SEARCH_PATH || path === MOCK_EMPLOYEES_MGET_PATH) {
    // FSL-118: the Directory v1 employee routes answer their own measured
    // authentication failures; every other route keeps its own.
    await handleEmployeesRequest(request, response, path, state, tokens);
    return;
  }
  sendMockError(response, mockError(4, "not_found"));
}

/**
 * Issues a tenant token for the matching app credentials.
 *
 * The legacy interface keeps the token and its lifetime at the top level, not
 * inside `data`.
 */
async function handleTenantTokenRequest(
  request: IncomingMessage,
  response: ServerResponse,
  tokens: MockTokenStore,
  faults: MockFaultStore,
  lifecycle: MockLifecycle,
): Promise<void> {
  if (request.method !== "POST") {
    sendMockError(response, mockError(4, "not_found"));
    return;
  }
  const result = await readJsonBody(request, ["app_id", "app_secret"]);
  if (!result.ok) {
    sendMockError(response, result.error);
    return;
  }
  const appId = result.body.app_id;
  const appSecret = result.body.app_secret;
  if (typeof appId !== "string" || typeof appSecret !== "string") {
    sendMockError(response, mockError(1, "mock_body_invalid"));
    return;
  }
  const issued = tokens.issue(appId, appSecret);
  if (!issued.ok) {
    sendMockError(response, issued.error);
    return;
  }
  if (await injectFault(faults, "token", response, lifecycle)) return;
  sendMockJson(response, 200, {
    code: 0,
    msg: "ok",
    tenant_access_token: issued.token,
    expire: issued.expire,
  });
}

/** Answers an injected fault when the queue holds one. */
async function injectFault(
  faults: MockFaultStore,
  target: MockFaultTarget,
  response: ServerResponse,
  lifecycle: MockLifecycle,
): Promise<boolean> {
  const kind = faults.take(target);
  if (kind === undefined) return false;
  if (kind === "timeout") {
    // The frozen timeout fault waits one second on every provider target.
    await runFaultDelay(lifecycle, `fault:timeout:${randomBytes(6).toString("hex")}`);
    sendMockError(response, asyncFaultError());
    return true;
  }
  if (kind === "disconnect_after_accept") {
    // Only a message admits this kind, so it never reaches here.
    sendMockError(response, mockError(1, "mock_fault_target_invalid"));
    return true;
  }
  sendMockError(response, faultError(kind));
  return true;
}

/**
 * Reads a single member.
 *
 * The path carries an open id and the request must name the frozen id types;
 * a member that is unknown or was deleted is not in the directory anymore.
 */
async function handleUserRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  state: MockState,
  tokens: MockTokenStore,
  faults: MockFaultStore,
  lifecycle: MockLifecycle,
): Promise<void> {
  if (request.method !== "GET") {
    sendMockError(response, mockError(4, "not_found"));
    return;
  }
  const bearer = parseBearer(request.headers.authorization);
  if (!tokens.validate(bearer, MOCK_APP_ID)) {
    sendMockError(response, mockError(2, "mock_provider_unauthorized"));
    return;
  }
  const parameters = new URLSearchParams(
    request.url && request.url.includes("?") ? request.url.slice(request.url.indexOf("?") + 1) : "",
  );
  const userIdType = parameters.get("user_id_type");
  if (userIdType === null) {
    sendMockError(response, mockError(1, "mock_id_type_required"));
    return;
  }
  if (userIdType !== MOCK_USER_ID_TYPE) {
    sendMockError(response, mockError(1, "mock_id_type_invalid"));
    return;
  }
  const departmentIdType = parameters.get("department_id_type");
  if (departmentIdType === null) {
    sendMockError(response, mockError(1, "mock_id_type_required"));
    return;
  }
  if (departmentIdType !== MOCK_DEPARTMENT_ID_TYPE) {
    sendMockError(response, mockError(1, "mock_id_type_invalid"));
    return;
  }
  if (await injectFault(faults, "user", response, lifecycle)) return;
  const openId = decodeURIComponent(path.slice(MOCK_USER_PATH_PREFIX.length));
  if (openId === "" || openId.includes("/")) {
    sendMockError(response, mockError(4, "not_found"));
    return;
  }
  const user = findUser(state, openId);
  if (user === undefined) {
    sendMockError(response, mockError(4, "mock_user_not_found"));
    return;
  }
  sendMockJson(response, 200, { code: 0, msg: "ok", data: { user } });
}

/**
 * Delivers a directed message.
 *
 * The request has to pass the tenant validator and the message admission of
 * FSM-20; only then is it written to the inbox of its receiver. A success is
 * answered in the measured real shape (FSL-170), built by
 * `messageSuccessResponse` for the first and every repeated answer.
 */
async function handleMessageRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: MockState,
  tokens: MockTokenStore,
  messages: MockMessageStore,
  faults: MockFaultStore,
  lifecycle: MockLifecycle,
): Promise<void> {
  if (request.method !== "POST") {
    sendMockError(response, mockError(4, "not_found"));
    return;
  }
  const bearer = parseBearer(request.headers.authorization);
  if (!tokens.validate(bearer, MOCK_APP_ID)) {
    sendMockError(response, mockError(2, "mock_provider_unauthorized"));
    return;
  }
  const parameters = new URLSearchParams(
    request.url && request.url.includes("?") ? request.url.slice(request.url.indexOf("?") + 1) : "",
  );
  const receiveIdType = parameters.get("receive_id_type");
  if (receiveIdType === null) {
    sendMockError(response, mockError(1, "mock_id_type_required"));
    return;
  }
  if (receiveIdType !== MOCK_USER_ID_TYPE) {
    sendMockError(response, mockError(1, "mock_id_type_invalid"));
    return;
  }
  const body = await readJsonBody(request, ["receive_id", "msg_type", "content", "uuid"]);
  if (!body.ok) {
    sendMockError(response, body.error);
    return;
  }
  const uuid = body.body.uuid;
  if (typeof uuid !== "string" || uuid === "") {
    sendMockError(response, mockError(1, "mock_uuid_invalid"));
    return;
  }
  // The uuid ledger is the authority for a repeated request, so a member that
  // was deleted after the original delivery still answers from it.
  const recorded = messages.lookup(MOCK_APP_ID, uuid);
  if (recorded !== undefined) {
    const same =
      recorded.payload.receive_id === body.body.receive_id &&
      recorded.payload.msg_type === body.body.msg_type &&
      recorded.payload.content === body.body.content;
    if (!same) {
      sendMockError(response, mockError(5, "mock_uuid_conflict"));
      return;
    }
    // The same constructor as the first answer, from the same record.
    sendMockJson(response, 200, messageSuccessResponse(recorded));
    return;
  }
  const admitted = admitMessageInput(body.body, state.users);
  if (!admitted.ok) {
    sendMockError(response, admitted.error);
    return;
  }
  const kind = faults.take("message");
  if (kind === "timeout") {
    // The delay is registered as a task, so a reset cancels it.
    await runFaultDelay(lifecycle, `fault:timeout:${randomBytes(6).toString("hex")}`);
    sendMockError(response, asyncFaultError());
    return;
  }
  if (kind === "disconnect_after_accept") {
    // Accept first: the message and its uuid are committed, then the
    // connection is dropped without a response. A retry with the same uuid
    // answers from the ledger, so no second message appears.
    messages.send(MOCK_APP_ID, uuid, admitted.payload);
    request.socket.destroy();
    return;
  }
  if (kind !== undefined) {
    sendMockError(response, faultError(kind));
    return;
  }
  const outcome = messages.send(MOCK_APP_ID, uuid, admitted.payload);
  if (!outcome.ok) {
    sendMockError(response, outcome.error);
    return;
  }
  sendMockJson(response, 200, messageSuccessResponse(outcome.record));
}
