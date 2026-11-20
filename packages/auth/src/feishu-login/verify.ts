// megaui:packages/auth/src/enterprise-otp/verify.ts@24a8551 (megaui-only FSL-124, FSL-151, FSL-125, FSL-152, FSL-169: the verify endpoint of the Feishu login)
/**
 * FSL-124 (success path), FSL-151 (failure path and concurrency), FSL-125 (first-login account
 * creation), FSL-152 (its conflict, rollback and concurrency) and FSL-169 (the compensation of a
 * failed session issue): `POST /feishu-login/verify` (ADR-FSL-11 「校验」).
 *
 * - The request is `application/json` and its body (at most 4096 bytes) is exactly
 *   `{ "code": <string> }`; the code is trimmed and uppercased and must then be 8 characters of
 *   the code alphabet. Anything else answers 400 `{ "code": "INVALID_INPUT" }` and reads no row.
 * - A well-formed code is checked against the newest row of the flow named by the flow cookie in
 *   one transaction (`consumeFeishuLoginCode`) that locks that row `FOR UPDATE`: only an unexpired
 *   `active` row below the failure limit whose code HMAC matches in constant time is consumed, its
 *   email, open_id, name and code HMAC cleared, and the binding of `(app_id, open_id_hmac)` read,
 *   where `open_id_hmac` is
 *   HMAC-SHA256(`ENTERPRISE_OTP_HMAC_KEY`, "feishu-identity:v1:" + app_id + ":" + open_id).
 *   When the member has no binding (first login, FSL-125), the same transaction takes the
 *   member's identity lock, reads the binding again (a concurrent first login of the same member
 *   that committed it meanwhile is found, so only one user is created, FSL-152), and otherwise
 *   creates a Better Auth user (a fresh ID from the Better Auth ID generator, the login email held
 *   by the row, `emailVerified = true`, the name read when the code was issued) and inserts the
 *   binding `(app_id, open_id_hmac, user_id)`; the open_id itself is never stored. A later login of
 *   the same member finds that binding and creates neither a user nor a binding.
 *   A wrong code compared against such a row adds one to its `failed_attempts`; the wrong code that
 *   brings it to 5 (`FEISHU_LOGIN_MAX_FAILED_ATTEMPTS`) also turns it `void` with those four fields
 *   cleared, so the correct code no longer succeeds. Concurrent submissions that lock the same row
 *   run one after the other, so once one of them consumed the row and committed, every later one
 *   answers 401.
 * - After that commit a plain Better Auth session (8 hours, no enterprise field) is issued with
 *   `internalAdapter.createSession`, marked in `feishu_login_sessions`, and its cookie set: 200
 *   `{ "status": "ok" }`.
 * - FSL-169: when reading the user throws (or finds no user) or `createSession` throws, no
 *   session object is held and nothing is deleted; when the marker insert throws, the session
 *   just issued is deleted with `internalAdapter.deleteSession` (a marker row, if one was written,
 *   goes with it by its `on delete cascade`). Either way no session cookie is set, the stable log
 *   key `FEISHU_LOGIN_SESSION_FAILED` is logged and the answer is 503 `{ "status": "retry" }`.
 *   When that deletion throws as well, `FEISHU_LOGIN_SESSION_REVOKE_FAILED` is logged first; the
 *   state of the two tables is then unknown (a write may have committed with its acknowledgement
 *   lost), but the session token was never sent. The code is already consumed and the user and
 *   binding are committed, so the member requests a new code and logs in without a new account.
 *   A deliberate refusal of `createSession` (a Better Auth `APIError`, such as the admin plugin's
 *   403 `BANNED_USER` for a banned user) is not a failure: it is rethrown unchanged. Setting the
 *   cookie (signing in memory, no database access) is not compensated: if it throws, the
 *   endpoint throws.
 * - FSL-152: when a local user already holds the login email of a member without a binding, nothing
 *   is merged: no user is created or changed and no binding is written, the consumption of the
 *   code commits, the stable log key `FEISHU_LOGIN_ACCOUNT_CONFLICT` (nothing else) is logged, and
 *   the answer is 409 `{ "status": "account_conflict" }` without a session cookie.
 * - FSL-152: any other failure of the account creation rolls the whole transaction back (no user,
 *   no binding, and the row stays `active`, so the same code can be submitted again) and the
 *   endpoint throws `FEISHU_LOGIN_ACCOUNT_CREATE_FAILED` without the database error.
 * - Every other outcome — no flow cookie, no row, a newest row that is not an unexpired `active`
 *   one (expired, `reserved`, `void` — including voided by the failure limit — or `consumed`), or
 *   a wrong code — answers the same 401 `{ "status": "invalid" }` (so would an `unbound` result,
 *   which this endpoint never gets: it always passes `newUserId`).
 */
import { createHmac } from "node:crypto";
import { APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import {
  consumeFeishuLoginCode,
  recordFeishuLoginSession,
  type DatabaseClient,
} from "@megaui/database";

import { ENTERPRISE_OTP_ALPHABET, ENTERPRISE_OTP_LENGTH } from "../enterprise-otp/code";
import { feishuLoginFlowHash, readFeishuLoginFlowCookie } from "./cookie";
import { isFeishuLoginJsonMediaType } from "./request";

/** The purpose label of the identity HMAC (ADR-FSL-11, FSL-120). */
export const FEISHU_LOGIN_IDENTITY_HMAC_LABEL = "feishu-identity:v1:";
/** A Feishu login session lives 8 hours from its issue (ADR-FSL-11). */
export const FEISHU_LOGIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
/** The largest verify body accepted; larger bodies are invalid input (400). */
export const FEISHU_LOGIN_VERIFY_MAX_BODY_BYTES = 4096;

const HMAC_KEY_BYTES = 32;

/** Logged when a local user already holds the login email of a member without a binding (FSL-152). */
export const FEISHU_LOGIN_ACCOUNT_CONFLICT = "FEISHU_LOGIN_ACCOUNT_CONFLICT";

/** FSL-169: logged when the session could not be issued or marked; the answer is 503 retry. */
export const FEISHU_LOGIN_SESSION_FAILED = "FEISHU_LOGIN_SESSION_FAILED";
/** FSL-169: logged when the session issued before a failed marker insert could not be deleted. */
export const FEISHU_LOGIN_SESSION_REVOKE_FAILED = "FEISHU_LOGIN_SESSION_REVOKE_FAILED";

export type FeishuLoginVerifyLogKey =
  | typeof FEISHU_LOGIN_ACCOUNT_CONFLICT
  | typeof FEISHU_LOGIN_SESSION_FAILED
  | typeof FEISHU_LOGIN_SESSION_REVOKE_FAILED;

export interface FeishuLoginVerifyOptions {
  /** The pool that holds `feishu_login_codes`, `feishu_identities` and `feishu_login_sessions`. */
  readonly pool: DatabaseClient["pool"];
  /** `FEISHU_APP_ID`. */
  readonly appId: string;
  /** The decoded 32-byte `ENTERPRISE_OTP_HMAC_KEY`. Private: never logged. */
  readonly otpHmacKey: Uint8Array;
  /** Receives stable log keys only (FSL-152, FSL-169). Defaults to `console.warn`. */
  readonly log?: (key: FeishuLoginVerifyLogKey) => void;
}

/** Validated verify options; the key is copied so later changes of the caller's buffer do not apply. */
export function readFeishuLoginVerifyOptions(options: FeishuLoginVerifyOptions): FeishuLoginVerifyOptions {
  if (
    !options ||
    !options.pool ||
    typeof options.pool.connect !== "function" ||
    typeof options.pool.query !== "function" ||
    typeof options.appId !== "string" ||
    options.appId.trim() === "" ||
    !(options.otpHmacKey instanceof Uint8Array) ||
    options.otpHmacKey.length !== HMAC_KEY_BYTES ||
    (options.log !== undefined && typeof options.log !== "function")
  ) {
    throw new Error("INVALID_FEISHU_LOGIN_PLUGIN_CONFIG");
  }
  return {
    pool: options.pool,
    appId: options.appId,
    otpHmacKey: Uint8Array.from(options.otpHmacKey),
    ...(options.log === undefined ? {} : { log: options.log }),
  };
}

function reportVerify(options: FeishuLoginVerifyOptions, key: FeishuLoginVerifyLogKey): void {
  try {
    (options.log ?? console.warn)(key);
  } catch {
    // A failing logger must not change the answer.
  }
}

/**
 * HMAC-SHA256(key, "feishu-identity:v1:" + appId + ":" + openId) as 64 lowercase hex characters:
 * the `open_id_hmac` of `feishu_identities`, which never stores the open_id itself (only an
 * `active` code row holds it, until consumed, voided or cleaned up).
 */
export function feishuLoginOpenIdHmac(key: Uint8Array, appId: string, openId: string): string {
  if (!(key instanceof Uint8Array) || key.length !== HMAC_KEY_BYTES) throw new Error("INVALID_FEISHU_LOGIN_HMAC_KEY");
  if (typeof appId !== "string" || appId === "") throw new Error("INVALID_FEISHU_LOGIN_APP_ID");
  if (typeof openId !== "string" || openId === "") throw new Error("INVALID_FEISHU_LOGIN_OPEN_ID");
  return createHmac("sha256", key)
    .update(`${FEISHU_LOGIN_IDENTITY_HMAC_LABEL}${appId}:${openId}`, "utf8")
    .digest("hex");
}

/** The trimmed, uppercased code when it is 8 characters of the code alphabet; otherwise `null`. */
export function normalizeFeishuLoginCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  if (code.length !== ENTERPRISE_OTP_LENGTH) return null;
  for (const char of code) if (!ENTERPRISE_OTP_ALPHABET.includes(char)) return null;
  return code;
}

/** The normalized code of a parsed body that is exactly `{ "code": <string> }`, or `null`. */
export function readFeishuLoginVerifyCode(body: unknown): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "code") return null;
  return normalizeFeishuLoginCode((body as { readonly code: unknown }).code);
}

/** Reads at most `limit` bytes; `null` (and the stream cancelled) once more have been read. */
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
        // Not awaited: cancelling one branch of a teed body only settles once the other one is.
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
 * Classifies an HTTP verify request before the framework parses its body, reading a clone and
 * stopping once more than `FEISHU_LOGIN_VERIFY_MAX_BODY_BYTES` have been read (counted per chunk).
 * Only `admissible` requests reach the endpoint; the plugin's `onRequest` answers the rest 400.
 */
export async function precheckFeishuLoginVerifyHttpRequest(request: Request): Promise<"admissible" | "invalid"> {
  if (!isFeishuLoginJsonMediaType(request.headers.get("content-type"))) return "invalid";
  const stream = request.clone().body;
  if (stream === null) return "invalid";
  let bytes: Uint8Array | null;
  try {
    bytes = await readBoundedBody(stream, FEISHU_LOGIN_VERIFY_MAX_BODY_BYTES);
  } catch {
    return "invalid";
  }
  if (bytes === null) return "invalid";
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return "invalid";
  }
  return readFeishuLoginVerifyCode(body) !== null ? "admissible" : "invalid";
}

export const FEISHU_LOGIN_VERIFY_INVALID_INPUT = { code: "INVALID_INPUT" } as const;
export const FEISHU_LOGIN_VERIFY_INVALID = { status: "invalid" } as const;
export const FEISHU_LOGIN_VERIFY_OK = { status: "ok" } as const;
export const FEISHU_LOGIN_VERIFY_ACCOUNT_CONFLICT = { status: "account_conflict" } as const;
export const FEISHU_LOGIN_VERIFY_RETRY = { status: "retry" } as const;

type BetterAuthEndpointContext = Parameters<typeof setSessionCookie>[0];

export type FeishuLoginVerifyResponse =
  | { readonly status: 400; readonly body: typeof FEISHU_LOGIN_VERIFY_INVALID_INPUT }
  | { readonly status: 401; readonly body: typeof FEISHU_LOGIN_VERIFY_INVALID }
  | { readonly status: 409; readonly body: typeof FEISHU_LOGIN_VERIFY_ACCOUNT_CONFLICT }
  | { readonly status: 503; readonly body: typeof FEISHU_LOGIN_VERIFY_RETRY }
  | { readonly status: 200; readonly body: typeof FEISHU_LOGIN_VERIFY_OK };

type InternalAdapter = BetterAuthEndpointContext["context"]["internalAdapter"];
type IssuedUser = NonNullable<Awaited<ReturnType<InternalAdapter["findUserById"]>>>;
type IssuedSession = Awaited<ReturnType<InternalAdapter["createSession"]>>;

/**
 * Issues the Feishu login session of `userId` after the consuming transaction committed: a plain
 * Better Auth session of 8 hours (only `expiresAt` is overridden, no enterprise field is set),
 * then its `feishu_login_sessions` row, then the session cookie. FSL-169: `"retry"` (no cookie
 * set) when the user cannot be read, the session cannot be created or the marker cannot be
 * written; in the last case the session just created is deleted first. A Better Auth `APIError`
 * of `createSession` (a deliberate refusal) and a failure of setting the cookie are thrown
 * unchanged.
 */
async function issueFeishuLoginSession(
  ctx: BetterAuthEndpointContext,
  options: FeishuLoginVerifyOptions,
  userId: string,
): Promise<"issued" | "retry"> {
  const adapter = ctx.context.internalAdapter;
  let user: IssuedUser;
  let session: IssuedSession;
  try {
    const found = await adapter.findUserById(userId);
    if (!found) return "retry";
    user = found;
  } catch {
    return "retry";
  }
  try {
    const expiresAt = new Date(Date.now() + FEISHU_LOGIN_SESSION_TTL_SECONDS * 1000);
    session = await adapter.createSession(userId, false, { expiresAt }, true);
  } catch (error) {
    // A deliberate refusal (a hook's APIError, such as BANNED_USER) keeps its own answer.
    if (error instanceof APIError) throw error;
    return "retry";
  }
  try {
    await recordFeishuLoginSession(options.pool, session.id);
  } catch {
    // An unmarked session must not stay usable: delete it (a marker row written despite the
    // error goes with it by its cascade). Its token has not been sent: the cookie comes later.
    try {
      await adapter.deleteSession(session.token);
    } catch {
      reportVerify(options, FEISHU_LOGIN_SESSION_REVOKE_FAILED);
    }
    return "retry";
  }
  await setSessionCookie(ctx, { session, user }, false, { maxAge: FEISHU_LOGIN_SESSION_TTL_SECONDS });
  return "issued";
}

/**
 * The ID of the user a first login creates: the Better Auth ID generator of this auth instance,
 * so a Feishu user's ID has the same shape as any other Better Auth user's.
 */
function newFeishuLoginUserId(ctx: BetterAuthEndpointContext): string {
  const id: unknown = ctx.context.generateId({ model: "user" });
  if (typeof id !== "string" || id.trim() === "") throw new Error("FEISHU_LOGIN_VERIFY_UNAVAILABLE");
  return id;
}

/**
 * Decides one verify call from its parsed body and its `Cookie` / `Content-Type` headers, and on
 * success issues the session on `ctx`. The body is checked first (400), then the flow and the
 * code (401, 409, 503 or 200).
 */
export async function verifyFeishuLoginCode(
  ctx: BetterAuthEndpointContext,
  options: FeishuLoginVerifyOptions,
  body: unknown,
  cookieHeader: string | null | undefined,
  contentType: string | null | undefined,
): Promise<FeishuLoginVerifyResponse> {
  if (!isFeishuLoginJsonMediaType(contentType)) return { status: 400, body: FEISHU_LOGIN_VERIFY_INVALID_INPUT };
  const code = readFeishuLoginVerifyCode(body);
  if (code === null) return { status: 400, body: FEISHU_LOGIN_VERIFY_INVALID_INPUT };
  const flow = readFeishuLoginFlowCookie(cookieHeader);
  if (flow === undefined) return { status: 401, body: FEISHU_LOGIN_VERIFY_INVALID };
  const result = await consumeFeishuLoginCode(options.pool, {
    flowHash: feishuLoginFlowHash(flow),
    code,
    otpHmacKey: options.otpHmacKey,
    appId: options.appId,
    openIdHmac: (openId) => feishuLoginOpenIdHmac(options.otpHmacKey, options.appId, openId),
    newUserId: newFeishuLoginUserId(ctx),
  });
  if (result.kind === "conflict") {
    reportVerify(options, FEISHU_LOGIN_ACCOUNT_CONFLICT);
    return { status: 409, body: FEISHU_LOGIN_VERIFY_ACCOUNT_CONFLICT };
  }
  if (result.kind !== "consumed") return { status: 401, body: FEISHU_LOGIN_VERIFY_INVALID };
  if ((await issueFeishuLoginSession(ctx, options, result.userId)) === "retry") {
    reportVerify(options, FEISHU_LOGIN_SESSION_FAILED);
    return { status: 503, body: FEISHU_LOGIN_VERIFY_RETRY };
  }
  return { status: 200, body: FEISHU_LOGIN_VERIFY_OK };
}
