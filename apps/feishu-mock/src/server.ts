/**
 * FSM-01 的 listener，由 FSM-06 扩展为有界 JSON HTTP 表面，由 FSM-07 扩展出
 * 受保护控制面。
 *
 * 本卡实现输入与错误合同：Host 必须精确匹配 listener，有 body 的请求只接受
 * application/json，未知字段与非法查询拒绝，body 上限 32KiB，body 与 header
 * 读取各有 5 秒预算。只有 GET /health 与 GET /__mock/state 已交付；其它路由
 * 返回冻结的 404。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import type { MockConfig } from "./config";
import {
  handleControlRequest,
  MOCK_CONTROL_PREFIX,
  type MockControlDeps,
} from "./control";
import {
  mockError,
  MOCK_READ_BUDGET_MS,
  readJsonBody,
  requestHasBody,
  sendMockError,
  sendMockJson,
  validateMockRequest,
  type MockHttpError,
} from "./http";
import { MockLifecycle } from "./lifecycle";
import { MockFaultStore } from "./faults";
import { MockMessageStore } from "./messages";
import { handleProviderRequest, MockTokenStore, MOCK_PROVIDER_PREFIX } from "./provider";
import { createMockState, MOCK_APP_ID, resetMockState, type MockState } from "./state";

export interface MockListener {
  baseUrl: string;
  port: number;
  /** The state of this run, including the synthetic directory. */
  state: MockState;
  /** The registry of the stores and tasks of this run. */
  lifecycle: MockLifecycle;
  /** The tenant tokens of this run. */
  tokens: MockTokenStore;
  close(): Promise<void>;
}

export interface MockListenerOptions {
  /**
   * This run's admin bearer. The control plane accepts nothing without it.
   */
  adminToken?: string;
  /**
   * This run's app secret. The tenant token endpoint issues nothing without
   * it.
   */
  appSecret?: string;
  /**
   * Accepted for compatibility with existing callers and ignored: the mock
   * sends no callbacks since FSL-140.
   */
  verificationToken?: string;
  /** Accepted for compatibility with existing callers and ignored (FSL-140). */
  encryptKey?: string;
}

/**
 * Body fields accepted by the routes delivered so far. No delivered route
 * accepts a body yet, so every field is unknown.
 */
const DELIVERED_BODY_FIELDS: readonly string[] = [];

interface SocketState {
  socket: Socket;
  /** Whether the pending request already received bytes from the client. */
  received: boolean;
  /** Deadline for the pending request headers. */
  deadline: NodeJS.Timeout | undefined;
  /** Whether a response was already written on this connection. */
  responded: boolean;
  /** Arms the header deadline for the next request on this connection. */
  arm: () => void;
}

export async function startMockListener(
  config: MockConfig,
  options: MockListenerOptions = {},
): Promise<MockListener> {
  let expectedHost = "";
  const state = createMockState();
  const lifecycle = new MockLifecycle();
  // The synthetic directory is a registered store: only a reset restores it.
  lifecycle.registerStore({ name: "synthetic-state", reset: () => resetMockState(state) });
  const tokens = new MockTokenStore({ appId: MOCK_APP_ID, appSecret: options.appSecret ?? "" });
  // The token store is registered too, so a reset really invalidates the
  // tokens this run issued.
  lifecycle.registerStore({ name: "tenant-tokens", reset: () => tokens.reset() });
  const messages = new MockMessageStore(state);
  // The message store is registered too, so a reset empties the uuid ledger
  // and the inboxes of this run.
  lifecycle.registerStore({ name: "directed-messages", reset: () => messages.reset() });
  const faults = new MockFaultStore(state);
  // The fault queue is a store as well, so a reset empties it.
  lifecycle.registerStore({ name: "provider-faults", reset: () => faults.reset() });
  const controlDeps = { faults };
  const states = new WeakMap<Socket, SocketState>();
  const server = createServer((request, response) => {
    const socketState = states.get(request.socket);
    if (socketState) {
      response.once("finish", () => {
        // The connection may carry another request: bound its headers too.
        socketState.received = false;
        socketState.arm();
      });
    }
    void handleRequest(request, response, expectedHost, socketState, state, lifecycle, tokens, messages, faults, controlDeps, options.adminToken);
  });
  installReadBudget(server, states);
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  expectedHost = `${config.host}:${port}`;
  return {
    baseUrl: `http://${config.host}:${port}`,
    port,
    state,
    lifecycle,
    tokens,
    close: () =>
      new Promise<void>((resolvePromise) => {
        // Closing the run aborts the registered tasks before the listener goes.
        void lifecycle.shutdown().finally(() => {
          server.close(() => resolvePromise());
          server.closeAllConnections?.();
        });
      }),
  };
}

/**
 * Bounds the header read.
 *
 * Node's `server.headersTimeout` does not interrupt an incomplete header on
 * the supported runtime, so the budget is enforced here: a connection must
 * deliver its request headers within 5 seconds. When the deadline expires the
 * frozen 504 is written for a request that started, and an idle connection is
 * closed the same way Node closes idle keep-alive sockets.
 */
function installReadBudget(server: Server, states: WeakMap<Socket, SocketState>): void {
  const arm = (state: SocketState): void => {
    clearTimeout(state.deadline);
    const deadline = setTimeout(() => {
      state.deadline = undefined;
      onHeaderTimeout(state);
    }, MOCK_READ_BUDGET_MS);
    deadline.unref?.();
    state.deadline = deadline;
  };

  const onHeaderTimeout = (state: SocketState): void => {
    const socket = state.socket;
    if (socket.destroyed || !socket.writable) return;
    if (!state.received) {
      // Idle connection: close it like Node closes idle keep-alive sockets.
      socket.destroy();
      return;
    }
    state.responded = true;
    socket.end(rawMockResponse(504, JSON.stringify({ code: 7, msg: "mock_read_timeout" })));
  };

  server.on("connection", (socket: Socket) => {
    const state: SocketState = {
      socket,
      received: false,
      deadline: undefined,
      responded: false,
      arm: () => arm(state),
    };
    states.set(socket, state);
    arm(state);
    socket.on("data", () => {
      state.received = true;
    });
    socket.on("close", () => {
      clearTimeout(state.deadline);
      state.deadline = undefined;
    });
  });

  server.on("request", (request: IncomingMessage) => {
    const state = states.get(request.socket);
    if (!state) return;
    // The headers arrived: the body budget belongs to readJsonBody now.
    clearTimeout(state.deadline);
    state.deadline = undefined;
  });

  server.on("clientError", (error: Error, socket: Socket) => {
    const state = states.get(socket);
    if (state?.responded || socket.destroyed || !socket.writable) {
      socket.destroy();
      return;
    }
    if (state) state.responded = true;
    socket.end(rawMockResponse(400, JSON.stringify({ code: 1, msg: "mock_request_invalid" })));
  });
}

function rawMockResponse(status: number, payload: string): string {
  const reason = status === 504 ? "Gateway Timeout" : "Bad Request";
  return [
    `HTTP/1.1 ${status} ${reason}`,
    "content-type: application/json",
    `content-length: ${Buffer.byteLength(payload)}`,
    "connection: close",
    "",
    payload,
  ].join("\r\n");
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  expectedHost: string,
  socketState: SocketState | undefined,
  state: MockState,
  lifecycle: MockLifecycle,
  tokens: MockTokenStore,
  messages: MockMessageStore,
  faults: MockFaultStore,
  controlDeps: MockControlDeps,
  adminToken: string | undefined,
): Promise<void> {
  const fail = (error: MockHttpError, closeConnection = false): void => {
    if (socketState) socketState.responded = true;
    if (closeConnection) response.setHeader("connection", "close");
    sendMockError(response, error);
  };
  const invalid = validateMockRequest({
    expectedHost,
    method: request.method ?? "GET",
    url: request.url ?? "/",
    headers: request.headers,
  });
  if (invalid) {
    fail(invalid);
    return;
  }
  const url = request.url ?? "/";
  const path = url.split("?")[0] ?? "/";
  if (path.startsWith(MOCK_CONTROL_PREFIX)) {
    // The control plane guards itself before it looks at any body.
    await handleControlRequest(request, response, path, state, lifecycle, adminToken, controlDeps);
    if (socketState) socketState.responded = true;
    return;
  }
  if (path.startsWith(MOCK_PROVIDER_PREFIX)) {
    await handleProviderRequest(request, response, path, state, tokens, messages, faults, lifecycle);
    if (socketState) socketState.responded = true;
    return;
  }
  if (requestHasBody(request.headers)) {
    const result = await readJsonBody(request, DELIVERED_BODY_FIELDS);
    if (!result.ok) {
      // A body that was not fully read cannot be reused: close after answering.
      fail(result.error, !result.drained);
      return;
    }
  }
  if (request.method === "GET" && path === "/health") {
    if (socketState) socketState.responded = true;
    sendMockJson(response, 200, { ok: true, service: "feishu-mock" });
    return;
  }
  fail(mockError(4, "not_found"));
}
