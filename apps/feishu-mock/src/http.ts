/**
 * FSM-06：有界 JSON HTTP 表面。
 *
 * 本卡只实现输入与错误合同，供后续卡复用：Host 必须精确匹配 listener，
 * 有 body 的请求只接受 application/json，未知字段与非法查询一律拒绝，
 * body 上限 32KiB，读取有 5 秒预算，错误按冻结的 HTTP/code/msg 映射输出。
 * 尚未由前序卡交付的路由一律返回 404。
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export const MOCK_MAX_BODY_BYTES = 32 * 1024;
export const MOCK_READ_BUDGET_MS = 5_000;

export type MockErrorCode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface MockHttpError {
  // 500 is only reachable through the frozen fault override of code 8.
  httpStatus: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503 | 504;
  code: MockErrorCode;
  msg: string;
}

export interface MockRequestContext {
  /** Exact host:port the listener is bound to. */
  expectedHost: string;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

const ERROR_BY_CODE: Record<MockErrorCode, MockHttpError["httpStatus"]> = {
  1: 400,
  2: 401,
  3: 403,
  4: 404,
  5: 409,
  6: 429,
  7: 504,
  8: 503,
};

export function mockError(code: MockErrorCode, msg: string): MockHttpError {
  return { httpStatus: ERROR_BY_CODE[code], code, msg };
}

export function sendMockError(response: ServerResponse, error: MockHttpError): void {
  const body = JSON.stringify({ code: error.code, msg: error.msg });
  response.statusCode = error.httpStatus;
  response.setHeader("content-type", "application/json");
  response.end(body);
}

export function sendMockJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

/** Validates the request against the frozen contract before a route runs. */
export function validateMockRequest(context: MockRequestContext): MockHttpError | undefined {
  const host = context.headers.host;
  if (typeof host !== "string" || host !== context.expectedHost) {
    return mockError(1, "mock_host_mismatch");
  }
  const forwarded = context.headers["x-forwarded-host"];
  if (forwarded !== undefined) {
    return mockError(1, "mock_forwarded_host_rejected");
  }
  const contentType = context.headers["content-type"];
  const hasBody = contentType !== undefined;
  if (hasBody && !isJsonContentType(contentType)) {
    return mockError(1, "mock_content_type_invalid");
  }
  const query = queryOf(context.url);
  if (query) {
    for (const values of query.values()) {
      if (values.length > 1) return mockError(1, "mock_query_duplicate");
      if (values[0] === undefined || values[0] === "") return mockError(1, "mock_query_invalid");
    }
  }
  return undefined;
}

function isJsonContentType(contentType: string | string[] | undefined): boolean {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  if (value === undefined) return false;
  const mediaType = value.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

export function queryOf(url: string): Map<string, string[]> {
  const query = new Map<string, string[]>();
  const index = url.indexOf("?");
  if (index === -1) return query;
  for (const pair of url.slice(index + 1).split("&")) {
    if (pair === "") continue;
    const separator = pair.indexOf("=");
    const name = separator === -1 ? pair : pair.slice(0, separator);
    const value = separator === -1 ? "" : pair.slice(separator + 1);
    const existing = query.get(name);
    if (existing) existing.push(value);
    else query.set(name, [value]);
  }
  return query;
}

/** Rejects a JSON body that carries fields the schema does not define. */
export function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): MockHttpError | undefined {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) return mockError(1, "mock_unknown_field");
  }
  return undefined;
}

/**
 * Body read outcome.
 *
 * On failure `drained` is false when the request body was not fully consumed
 * (budget exhausted, oversized upload abandoned, socket error). The caller
 * must then close the connection after answering: the unread bytes cannot be
 * reused.
 */
export type MockBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: MockHttpError; drained: boolean };

/** True when the request declares a body (content-length or transfer-encoding). */
export function requestHasBody(headers: Record<string, string | string[] | undefined>): boolean {
  const length = headers["content-length"];
  if (typeof length === "string" && Number(length) > 0) return true;
  return headers["transfer-encoding"] !== undefined;
}

/**
 * Reads a bounded JSON body; rejects oversized bodies and unreadable payloads.
 *
 * The read is bounded twice: at 32KiB and at the 5 second budget. When the
 * budget is exhausted the request is paused instead of destroyed, so the caller
 * can still answer with the frozen error before the connection is closed.
 */
export function readJsonBody(
  request: IncomingMessage,
  allowed: readonly string[],
): Promise<MockBodyResult> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let discarded = 0;
    let oversized = false;
    let settled = false;
    const finish = (result: MockBodyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      // Budget exhausted: stop reading and let the caller answer the frozen
      // 504 before the connection is closed.
      request.pause();
      finish({ ok: false, error: mockError(7, "mock_read_timeout"), drained: false });
    }, MOCK_READ_BUDGET_MS);
    timer.unref?.();
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MOCK_MAX_BODY_BYTES) {
        // Keep draining so the client can finish sending, but never buffer it.
        oversized = true;
        discarded += chunk.length;
        if (discarded > MOCK_MAX_BODY_BYTES * 8) {
          request.pause();
          finish({ ok: false, error: mockError(1, "mock_body_too_large"), drained: false });
        }
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", () => {
      finish({ ok: false, error: mockError(7, "mock_read_failed"), drained: false });
    });
    request.on("end", () => {
      if (oversized) {
        finish({ ok: false, error: mockError(1, "mock_body_too_large"), drained: true });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        finish({ ok: false, error: mockError(1, "mock_body_invalid"), drained: true });
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        finish({ ok: false, error: mockError(1, "mock_body_invalid"), drained: true });
        return;
      }
      const record = parsed as Record<string, unknown>;
      const unknown = rejectUnknownFields(record, allowed);
      if (unknown) {
        finish({ ok: false, error: unknown, drained: true });
        return;
      }
      finish({ ok: true, body: record });
    });
  });
}
