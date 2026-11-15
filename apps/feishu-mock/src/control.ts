/**
 * FSM-07：受保护控制面。
 *
 * 控制面只属于本 Mock 进程：只接受本 run 独立生成的 admin Bearer，带 Origin 的
 * 请求一律拒绝，且任何响应都不开放 CORS。控制面成功响应使用 `{code:0,data:...}`，
 * 错误沿用冻结的 `{code,msg}` 合同。
 *
 * FSM-08 起本模块也承载 reset：它调用已注册 store 的重置器恢复 synthetic 初态，
 * 并在成功响应前取消全部已注册在途任务。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import {
  mockError,
  readJsonBody,
  requestHasBody,
  sendMockError,
  sendMockJson,
  type MockHttpError,
} from "./http";
import {
  buildCallbackEnvelope,
  MOCK_EVENT_MAX_RECORDS,
  type MockCallbackApp,
  type MockCallbackSender,
} from "./callbacks";
import { MOCK_TEXT_MAX_LENGTH } from "./message-input";
import type { MockFaultStore } from "./faults";
import type { MockLifecycle } from "./lifecycle";
import { MOCK_TENANT_KEY, statusFlags, type MockState, type MockUserStatus } from "./state";

export const MOCK_CONTROL_PREFIX = "/__mock/";

/** Paths of the control plane this card delivers. */
export const MOCK_CONTROL_DELIVERED_PATHS: readonly string[] = [
  "/__mock/state",
  "/__mock/reset",
  "/__mock/messages",
  "/__mock/verify-callback",
  "/__mock/users",
  "/__mock/faults",
  "/__mock/replay",
];

export interface MockControlContext {
  /** This run's admin bearer; without it the control plane accepts nothing. */
  adminToken: string | undefined;
  headers: IncomingHttpHeaders;
}

export interface MockControlStateView {
  users: MockState["users"];
  inboxes: Record<string, unknown[]>;
  events: unknown[];
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
 * inboxes grouped by open id, the event delivery summaries and the fault
 * rules. Runtime configuration, tokens, secrets and callback bodies are never
 * part of this view.
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
      events: state.events.map((event) => ({ ...event })),
      faults: state.faults.map((fault) => ({ ...fault })),
    },
  };
}

/**
 * Serves the control plane.
 *
 * The gate comes first: the control plane accepts nothing but this run's admin
 * bearer, and a request that carries an Origin is refused. Only the routes
 * this run delivers exist; the remaining frozen write verbs are not
 * implemented yet and answer the frozen 404.
 */
export interface MockControlDeps {
  callbacks?: MockControlCallbacks;
  faults?: MockFaultStore;
}

export interface MockControlCallbacks {
  app: MockCallbackApp;
  sender: MockCallbackSender;
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
  const callbacks = deps.callbacks;
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
  if (path === "/__mock/messages") {
    await handleControlMessages(request, response, state, callbacks);
    return;
  }
  if (path === "/__mock/verify-callback") {
    await handleVerifyCallback(request, response, callbacks);
    return;
  }
  if (path.startsWith("/__mock/users/")) {
    await handleMemberWrite(request, response, path, state, callbacks);
    return;
  }
  if (path === "/__mock/faults") {
    await handleFaultAdd(request, response, deps.faults);
    return;
  }
  if (path === "/__mock/replay") {
    await handleReplay(request, response, callbacks);
    return;
  }
  sendMockError(response, mockError(4, "not_found"));
}

/**
 * Replays a recorded event.
 *
 * The event identity and the business payload are kept and the signature
 * time and nonce are generated again; the receipt reports the delivery as it
 * actually happened.
 */
async function handleReplay(
  request: IncomingMessage,
  response: ServerResponse,
  callbacks: MockControlCallbacks | undefined,
): Promise<void> {
  if (request.method !== "POST") {
    sendMockError(response, mockError(4, "not_found"));
    return;
  }
  if (callbacks === undefined) {
    sendMockError(response, mockError(8, "mock_callback_unavailable"));
    return;
  }
  const body = await readJsonBody(request, ["eventId"]);
  if (!body.ok) {
    sendMockError(response, body.error);
    return;
  }
  const eventId = body.body.eventId;
  if (typeof eventId !== "string" || eventId === "") {
    sendMockError(response, mockError(1, "mock_body_invalid"));
    return;
  }
  const result = await callbacks.sender.replay(eventId);
  if (result.missing) {
    sendMockError(response, mockError(4, "mock_event_not_found"));
    return;
  }
  if (result.error) {
    sendMockError(response, result.error);
    return;
  }
  sendMockJson(response, 200, {
    code: 0,
    data: {
      eventId,
      delivered: result.delivery?.ok ?? false,
      statusCode: result.delivery?.statusCode ?? null,
    },
  });
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
 * Updates or deletes a synthetic member.
 *
 * The event capacity is reserved before the directory changes, so a full
 * ledger refuses the write with the directory untouched. Once the directory
 * is committed the callback is attempted, and a failed delivery is reported
 * as it is instead of pretending the change did not happen.
 */
async function handleMemberWrite(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  state: MockState,
  callbacks: MockControlCallbacks | undefined,
): Promise<void> {
  if (callbacks === undefined) {
    sendMockError(response, mockError(8, "mock_callback_unavailable"));
    return;
  }
  const openId = decodeURIComponent(path.slice("/__mock/users/".length));
  const user = state.users.find((candidate) => candidate.open_id === openId);
  if (user === undefined) {
    sendMockError(response, mockError(4, "mock_user_not_found"));
    return;
  }
  if (MOCK_EVENT_MAX_RECORDS <= state.events.length) {
    sendMockError(response, mockError(6, "mock_event_capacity_exceeded"));
    return;
  }
  if (request.method === "PATCH") {
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
    const previousStatus = user.status;
    user.status = statusFlags(status as MockUserStatus);
    const createTime = Date.now();
    const eventId = `evt_${randomBytes(12).toString("hex")}`;
    const envelope = buildCallbackEnvelope(
      {
        eventId,
        eventType: "contact.user.updated_v3",
        createTime,
        payload: {
          object: { ...user, department_ids: [...user.department_ids] },
          old_object: { open_id: user.open_id, status: previousStatus },
        },
      },
      callbacks.app,
    );
    const result = await callbacks.sender.send(envelope, { encrypted: true });
    if (result.error) {
      sendMockError(response, result.error);
      return;
    }
    sendMockJson(response, 200, {
      code: 0,
      data: { user, eventId, delivered: result.delivery?.ok ?? false, statusCode: result.delivery?.statusCode ?? null },
    });
    return;
  }
  if (request.method === "DELETE") {
    const deleted = {
      open_id: user.open_id,
      user_id: user.user_id,
      union_id: user.union_id,
      name: user.name,
      mobile: user.mobile,
      department_ids: [...user.department_ids],
      email: user.email,
      enterprise_email: user.enterprise_email,
      status: { is_activated: false, is_frozen: false, is_resigned: true, is_exited: true },
    };
    state.users = state.users.filter((candidate) => candidate.open_id !== openId);
    const createTime = Date.now();
    const eventId = `evt_${randomBytes(12).toString("hex")}`;
    const envelope = buildCallbackEnvelope(
      {
        eventId,
        eventType: "contact.user.deleted_v3",
        createTime,
        payload: {
          object: deleted,
          old_object: { open_id: deleted.open_id, department_ids: [...deleted.department_ids] },
        },
      },
      callbacks.app,
    );
    const result = await callbacks.sender.send(envelope, { encrypted: true });
    if (result.error) {
      sendMockError(response, result.error);
      return;
    }
    sendMockJson(response, 200, {
      code: 0,
      data: { eventId, delivered: result.delivery?.ok ?? false, statusCode: result.delivery?.statusCode ?? null },
    });
    return;
  }
  sendMockError(response, mockError(4, "not_found"));
}

/**
 * Sends a p2p message event on behalf of a synthetic member.
 *
 * Only a member of the current synthetic directory may speak, the text reuses
 * the frozen message limit, and the delivery result is reported as it is.
 */
async function handleControlMessages(
  request: IncomingMessage,
  response: ServerResponse,
  state: MockState,
  callbacks: MockControlCallbacks | undefined,
): Promise<void> {
  if (request.method !== "POST") {
    sendMockError(response, mockError(4, "not_found"));
    return;
  }
  if (callbacks === undefined) {
    sendMockError(response, mockError(8, "mock_callback_unavailable"));
    return;
  }
  const body = await readJsonBody(request, ["openId", "text", "encrypted"]);
  if (!body.ok) {
    sendMockError(response, body.error);
    return;
  }
  const openId = body.body.openId;
  if (typeof openId !== "string" || state.users.find((user) => user.open_id === openId) === undefined) {
    sendMockError(response, mockError(4, "mock_user_not_found"));
    return;
  }
  const text = body.body.text;
  if (typeof text !== "string") {
    sendMockError(response, mockError(1, "mock_body_invalid"));
    return;
  }
  if (text.length > MOCK_TEXT_MAX_LENGTH) {
    sendMockError(response, mockError(1, "mock_text_too_long"));
    return;
  }
  const encrypted = body.body.encrypted !== false;
  const createTime = Date.now();
  const eventId = `evt_${randomBytes(12).toString("hex")}`;
  const envelope = buildCallbackEnvelope(
    {
      eventId,
      eventType: "im.message.receive_v1",
      createTime,
      payload: {
        sender: { sender_id: { open_id: openId }, sender_type: "user" },
        tenant_key: MOCK_TENANT_KEY,
        message: {
          message_id: `om_${randomBytes(12).toString("hex")}`,
          create_time: String(createTime),
          chat_id: `oc_${openId}`,
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text }),
        },
      },
    },
    callbacks.app,
  );
  const result = await callbacks.sender.send(envelope, { encrypted });
  if (result.error) {
    sendMockError(response, result.error);
    return;
  }
  sendMockJson(response, 200, {
    code: 0,
    data: {
      eventId,
      delivered: result.delivery?.ok ?? false,
      statusCode: result.delivery?.statusCode ?? null,
    },
  });
}

/**
 * Runs the URL verification handshake.
 *
 * A random challenge is sent and only the same challenge coming back makes the
 * handshake succeed; nothing here authorizes a login.
 */
async function handleVerifyCallback(
  request: IncomingMessage,
  response: ServerResponse,
  callbacks: MockControlCallbacks | undefined,
): Promise<void> {
  if (request.method !== "POST") {
    sendMockError(response, mockError(4, "not_found"));
    return;
  }
  if (callbacks === undefined) {
    sendMockError(response, mockError(8, "mock_callback_unavailable"));
    return;
  }
  const body = await readJsonBody(request, ["encrypted"]);
  if (!body.ok) {
    sendMockError(response, body.error);
    return;
  }
  const encrypted = body.body.encrypted !== false;
  const challenge = randomBytes(16).toString("hex");
  const result = await callbacks.sender.send(
    { type: "url_verification", token: callbacks.app.verificationToken, challenge },
    { encrypted, readBody: true },
  );
  if (result.error) {
    sendMockError(response, result.error);
    return;
  }
  let verified = false;
  const answer = result.delivery?.body;
  if (answer !== undefined) {
    try {
      const parsed = JSON.parse(answer) as { challenge?: unknown };
      verified = parsed.challenge === challenge;
    } catch {
      verified = false;
    }
  }
  if (!verified) {
    sendMockError(response, mockError(8, "mock_callback_verification_failed"));
    return;
  }
  sendMockJson(response, 200, {
    code: 0,
    data: { verified: true, statusCode: result.delivery?.statusCode ?? null },
  });
}
