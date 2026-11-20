// megaui:packages/auth/src/enterprise-otp/request.ts@24a8551 (megaui-only FSL-123: the request contract of the Feishu login)
/**
 * FSL-123, FSL-154: the request contract of `POST /feishu-login/request` (ADR-FSL-11 「请求」
 * 「flow 绑定」).
 *
 * - The request is `application/json` and its body (at most 4096 bytes) is exactly
 *   `{ "email": <string> }`. The email is trimmed and lowercased and must
 *   pass `normalizeFeishuLoginEmail`; anything else answers 400 `{ "code": "INVALID_INPUT" }`
 *   with no cookie, and no port is called.
 * - A valid email first waits for the injected `reserve` port (FSL-154): the reservation
 *   transaction of the flow, database only, which voids the flow's earlier code and commits
 *   before the answer. When it resolves (a reservation refused by the cooldown or the budget
 *   included; its value is never read) the answer is 202 `{ "status": "accepted" }`. A request
 *   that carries a valid flow cookie keeps that flow and sets the cookie again with the same
 *   value (its ten minutes count again); otherwise a new flow is drawn. When `reserve` rejects
 *   or throws, the answer is 503 `{ "status": "retry" }` without a cookie, `deliver` is never
 *   called and only the stable key `FEISHU_LOGIN_RESERVE_FAILED` is logged. The answer never
 *   depends on the email beyond its syntax: the request path reads no account, no identity and
 *   calls no Feishu API, so a known, an unknown and a shared email get the same status, body and
 *   cookie attributes.
 * - Better Auth's per-address limit (production) keeps applying, but only to admissible
 *   requests: the limiter runs before any endpoint, so its rule for this path first checks the
 *   request with `precheckFeishuLoginHttpRequest` and lets an invalid input through to its
 *   400 (ADR-FSL-11 order: invalid input ① before the limit ②). Invalid inputs do no work. A
 *   body over 4 KiB is invalid input, answered 400 before the endpoint parses it.
 * - The `deliver` port (Feishu lookup, activation and message) runs only after the answer, in
 *   this Node process, with what `reserve` resolved: it is scheduled with `setImmediate`, which
 *   fires after the current turn of the event loop has handed the response back. Its result is
 *   ignored; a rejection or a throw is reported as the single stable log key
 *   `FEISHU_LOGIN_ISSUE_FAILED` (never the error, the email or the flow), and the request still
 *   answered 202.
 */
import { normalizeFeishuLoginEmail } from "./input";
import {
  createFeishuLoginFlow,
  feishuLoginFlowCookie,
  feishuLoginFlowHash,
  readFeishuLoginFlowCookie,
  type FeishuLoginFlowCookie,
} from "./cookie";

/** The stable log key of a failed or thrown `deliver` port. */
export const FEISHU_LOGIN_ISSUE_FAILED = "FEISHU_LOGIN_ISSUE_FAILED";
/** FSL-154: the stable log key of a failed or thrown `reserve` port (answered 503 retry). */
export const FEISHU_LOGIN_RESERVE_FAILED = "FEISHU_LOGIN_RESERVE_FAILED";
export type FeishuLoginRequestLogKey = typeof FEISHU_LOGIN_ISSUE_FAILED | typeof FEISHU_LOGIN_RESERVE_FAILED;

/** What the `reserve` port receives: the flow hash and the normalized email, nothing else. */
export interface FeishuLoginIssueInput {
  /** The SHA-256 of the flow cookie value, as 64 lowercase hex characters. */
  readonly flowHash: string;
  /** The trimmed, lowercased email. */
  readonly email: string;
}

/**
 * The injected issue service in two ports (FSL-154; the engine's `reserveFeishuLoginCode` and
 * `deliverFeishuLoginCode`, wired by FSL-150).
 */
export interface FeishuLoginIssuePort {
  /**
   * Database only, awaited before the answer: resolves once the reservation transaction of the
   * flow has committed, refusals included. Its value is not read here; it is handed to `deliver`.
   * A rejection or a throw answers 503 `{ "status": "retry" }`.
   */
  reserve(input: FeishuLoginIssueInput): Promise<unknown>;
  /** Called after the answer with what `reserve` resolved; its result is not read. */
  deliver(reservation: unknown): Promise<unknown>;
}

export type FeishuLoginRequestOutcome =
  | { readonly status: 400; readonly body: { readonly code: "INVALID_INPUT" } }
  | {
      readonly status: 202;
      readonly body: { readonly status: "accepted" };
      readonly cookie: FeishuLoginFlowCookie;
      readonly issue: FeishuLoginIssueInput;
    };

const INVALID_INPUT = { status: 400, body: { code: "INVALID_INPUT" } } as const;

function readEmailField(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "email") return undefined;
  return (body as { readonly email: unknown }).email;
}

/**
 * True only when the media type of a `Content-Type` header is exactly `application/json`
 * (parameters such as `charset` allowed). The endpoint and the rate-limit rule share this check,
 * so a type the framework would still parse as JSON (for example `application/json-extra`) is
 * never admitted: it answers 400 `INVALID_INPUT`.
 */
export function isFeishuLoginJsonMediaType(header: string | null | undefined): boolean {
  return header?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/** The normalized email of a parsed request body, or `null` when the body is not admissible. */
export function readFeishuLoginRequestEmail(body: unknown): string | null {
  return normalizeFeishuLoginEmail(readEmailField(body));
}

/**
 * The largest request body the endpoint accepts; larger bodies are invalid input (400). A real
 * request is `{"email":"…"}` of a few hundred bytes at most.
 */
export const FEISHU_LOGIN_PRECHECK_MAX_BODY_BYTES = 4096;

export type FeishuLoginHttpPrecheck =
  /** The endpoint would answer 202: the limit applies. */
  | "admissible"
  /** Not admissible: `onRequest` answers 400 before the endpoint; exempt from the limit. */
  | "invalid"
  /** Not parsed: the body exceeds `FEISHU_LOGIN_PRECHECK_MAX_BODY_BYTES`; answered 400. */
  | "oversized";

/**
 * Reads a body until more than `limit` bytes have been read; `null` (and the stream cancelled)
 * then. Counted per chunk: the chunk that crosses the limit has been read, later ones never are.
 */
async function readBoundedBody(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        // Not awaited: cancelling one branch of a teed body settles only once the other branch
        // (the endpoint's) is cancelled too, which never happens.
        reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Classifies an HTTP request before Better Auth's limiter runs, so that an invalid input answers
 * 400 ahead of 429 (ADR-FSL-11 response order ① before ②) while every request the endpoint
 * admits stays under the limit. It reads a clone (the endpoint still receives the untouched body)
 * and stops once more than `FEISHU_LOGIN_PRECHECK_MAX_BODY_BYTES` have been read (counted per chunk on
 * the bytes actually read: the crossing chunk is read, later ones never are): such a body is `oversized`. Both `invalid` and `oversized` are answered 400 by the plugin's
 * `onRequest` before the framework parses the body, so they are never admitted and need no limit.
 */
export async function precheckFeishuLoginHttpRequest(request: Request): Promise<FeishuLoginHttpPrecheck> {
  if (!isFeishuLoginJsonMediaType(request.headers.get("content-type"))) return "invalid";
  const stream = request.clone().body;
  if (stream === null) return "invalid";
  let bytes: Uint8Array | null;
  try {
    bytes = await readBoundedBody(stream, FEISHU_LOGIN_PRECHECK_MAX_BODY_BYTES);
  } catch {
    // The body could not be read; nothing can be admitted from it.
    return "oversized";
  }
  if (bytes === null) return "oversized";
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return "invalid";
  }
  return readFeishuLoginRequestEmail(body) !== null ? "admissible" : "invalid";
}

/**
 * Decides the admission of one request from its parsed JSON body, its `Cookie` header and its
 * `Content-Type` header (the same admission as `precheckFeishuLoginHttpRequest`). Pure
 * apart from drawing a new flow; it never calls a port. A 202 outcome is only answered once
 * `reserveFeishuLoginIssue` succeeded.
 */
export function admitFeishuLoginRequest(
  body: unknown,
  cookieHeader: string | null | undefined,
  contentType: string | null | undefined,
): FeishuLoginRequestOutcome {
  if (!isFeishuLoginJsonMediaType(contentType)) return INVALID_INPUT;
  const email = readFeishuLoginRequestEmail(body);
  if (email === null) return INVALID_INPUT;
  const flow = readFeishuLoginFlowCookie(cookieHeader) ?? createFeishuLoginFlow();
  return {
    status: 202,
    body: { status: "accepted" },
    cookie: feishuLoginFlowCookie(flow),
    issue: { flowHash: feishuLoginFlowHash(flow), email },
  };
}

function report(log: (key: FeishuLoginRequestLogKey) => void, key: FeishuLoginRequestLogKey): void {
  try {
    log(key);
  } catch {
    // A failing logger must not turn into an unhandled rejection of the request process.
  }
}

/** The answer of a request whose reservation failed (FSL-154). */
export const FEISHU_LOGIN_RETRY_BODY = { status: "retry" } as const;

export type FeishuLoginReserveAttempt =
  | { readonly ok: true; readonly reservation: unknown }
  | { readonly ok: false };

/**
 * FSL-154: runs the `reserve` port and waits for it, before the request answers. A rejection or a
 * synchronous throw only logs `FEISHU_LOGIN_RESERVE_FAILED` (never the error, the email or the
 * flow) and is reported as `{ ok: false }`: the endpoint answers 503 retry and never delivers.
 */
export async function reserveFeishuLoginIssue(
  port: FeishuLoginIssuePort,
  input: FeishuLoginIssueInput,
  log: (key: FeishuLoginRequestLogKey) => void,
): Promise<FeishuLoginReserveAttempt> {
  try {
    return { ok: true, reservation: await port.reserve(input) };
  } catch {
    report(log, FEISHU_LOGIN_RESERVE_FAILED);
    return { ok: false };
  }
}

/**
 * Runs the `deliver` port after the current synchronous run, so `auth.handler` settles with an
 * already fixed response before the port is called (when the response bytes reach the client is
 * up to the host server); never inline, never awaited by the request.
 * A rejection or a synchronous throw only logs `FEISHU_LOGIN_ISSUE_FAILED`.
 */
export function scheduleFeishuLoginDelivery(
  port: FeishuLoginIssuePort,
  reservation: unknown,
  log: (key: FeishuLoginRequestLogKey) => void,
): void {
  setImmediate(() => {
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(port.deliver(reservation));
    } catch {
      report(log, FEISHU_LOGIN_ISSUE_FAILED);
      return;
    }
    pending.catch(() => report(log, FEISHU_LOGIN_ISSUE_FAILED));
  });
}
