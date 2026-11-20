// megaui-only (FSL-122): the main flow of issuing a Feishu login code.
/**
 * FSL-122：验证码签发服务主流程（ADR-FSL-11「发码」）。
 *
 * FSL-154 splits the flow into two ports (ADR-FSL-11 「flow 绑定」): `reserveFeishuLoginCode`
 * (step 1, database only; the request endpoint waits for it before it answers) and
 * `deliverFeishuLoginCode` (steps 2–4, Feishu; run after the answer with what the reservation
 * returned). `issueFeishuLoginCode({ flowHash, email })` runs both, one after the other:
 *
 * 1. the reservation transaction takes the flow lock, the email lock (the one activation
 *    takes) and the global lock (FSL-145), in that order. It first voids the row of the
 *    largest `flow_seq` of the flow (whatever its email and state, unless `consumed`), so
 *    once it has committed no earlier reservation or code of the flow is valid any more; then
 *    it decides the cooldown (a reservation of the email HMAC in the last 60 seconds:
 *    `FEISHU_LOGIN_COOLDOWN`) and the global budget (120 reservations of all emails in the last
 *    60 seconds: `FEISHU_LOGIN_GLOBAL_BUDGET`). A refused request commits only that void,
 *    writes no new row and calls nothing. Otherwise it writes the `reserved` row of this request
 *    and commits, which releases the locks before any Feishu call. It never calls Feishu and
 *    never reads an account;
 * 2. the delivery starts: a reservation already expired (two minutes after its creation) is
 *    voided and Feishu is never called (FSL-145). Then, outside any transaction, Directory v1
 *    finds the single member of the email and reads whether the member is in office
 *    (`FeishuContactClient`, FSL-117);
 * 3. the activation transaction takes the flow lock, then the email lock, and locks this
 *    row; only a still unexpired `reserved` row with no later reservation (`email_seq`) of
 *    the email activates (FSL-149): every `active` row of the email HMAC (in any flow,
 *    sensitive fields cleared) is voided and this row turns `active` with the email,
 *    open_id, name and code HMAC. A stale reservation (voided by a later request of the flow,
 *    superseded by a later reservation of the email, expired) is voided or left as it is, and
 *    nothing is sent. No target, several members, an inactive member or a failed Feishu call
 *    void this row in a transaction of the same shape (flow lock, then email lock) instead;
 * 4. after the commit, `FeishuMessageClient` sends the code as a direct message with the
 *    row id as the stable UUID of this request. The transport makes exactly one HTTP
 *    attempt per call (`maxAttempts: 1`); this service owns the retries (FSL-149): an
 *    `unknown` attempt is retried with the same UUID at most twice, a `rejected` one is not.
 *    Every attempt `rejected` voids the row with a conditional write-back; any `unknown`
 *    without an `accepted` keeps it `active` (`FEISHU_LOGIN_SEND_UNKNOWN`), because the code
 *    may have been delivered. `FEISHU_LOGIN_SEND_ATTEMPT` is logged before every HTTP attempt
 *    of the message, ahead of the transport's last deadline check (FSL-160).
 *
 * The log only carries the stable keys below: never an email, an open_id, a name, a code,
 * a token or a message id. The code generator is injected (engine does not depend on
 * `@megaui/auth`; FSL-150 injects its generator). The Feishu clients are built from the
 * app id and secret only: the credential `tenantKey` is the internal label
 * `app:<FEISHU_APP_ID>`, a token cache key that is never sent to Feishu. The trusted site
 * in the message is `BETTER_AUTH_URL`.
 *
 * One attempt is classified as: HTTP 2xx with a successful business answer `accepted`;
 * HTTP 429 and an explicit business refusal `rejected` (Feishu did not take it, no retry);
 * HTTP 5xx, a timeout, a dropped connection, a 3xx answer to the message request and a 2xx
 * answer that does not meet the success criteria `unknown`. The message client reports a 429
 * as `unknown` (transient), so the service reads the HTTP status of the message request from
 * the wrapped fetch and turns a 429 into `rejected`.
 *
 * Absolute deadline (FSL-160): the reservation expiry (two minutes after its creation) bounds
 * every Feishu request of the delivery. The service samples its clock right before the
 * reservation transaction and uses that instant plus the reservation TTL as the deadline, which
 * is never later than the stored `expires_at` (the row is created after that instant). The
 * deadline reaches the token manager, the directory client and the message client, and through
 * them the transport: no request starts once it has passed (`transport_deadline`) and every HTTP
 * attempt's abort timer is set to the time left before it (fired through the event loop). The delivery takes one token at its start (through the shared refresh)
 * and uses that token for every directory and message call; it never refreshes during the
 * delivery, so a reservation makes at most one token HTTP request. A failed or late token, and a
 * passed deadline during the lookup, void the row as a provider failure; a passed deadline
 * during the send stops the retries, and the attempts made so far decide the outcome (an attempt
 * refused by the deadline never reached Feishu and counts as `rejected`).
 *
 * Out of this service: the HTTP entry (FSL-123, FSL-154) and the cleanup (FSL-146).
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { ProviderTarget } from "@megaui/core";
import {
  createFeishuLoginCodeStore,
  FEISHU_LOGIN_RESERVATION_TTL_SECONDS,
  feishuLoginCodeHmac,
  feishuLoginEmailHmac,
  type FeishuLoginCodeStore,
} from "@megaui/database";
import type { Pool } from "pg";

import {
  FEISHU_BACKOFF_BASE_MS,
  FEISHU_OPERATION_BUDGET_MS,
  FeishuTransport,
} from "../enterprise/feishu/http";
import {
  FEISHU_MESSAGE_PATH,
  FeishuMessageClient,
  type FeishuMessageResult,
} from "../enterprise/feishu/message";
import { FeishuTokenManager } from "../enterprise/feishu/token";
import type { FeishuTenantCredentials } from "../enterprise/feishu/types";
import { FeishuContactClient } from "../feishu/contact";

/** The stable log keys of the issue flow. */
export const FEISHU_LOGIN_SEND_ATTEMPT = "FEISHU_LOGIN_SEND_ATTEMPT";
export const FEISHU_LOGIN_NO_TARGET = "FEISHU_LOGIN_NO_TARGET";
export const FEISHU_LOGIN_INACTIVE = "FEISHU_LOGIN_INACTIVE";
export const FEISHU_LOGIN_PROVIDER_FAILED = "FEISHU_LOGIN_PROVIDER_FAILED";
export const FEISHU_LOGIN_SEND_UNKNOWN = "FEISHU_LOGIN_SEND_UNKNOWN";
export const FEISHU_LOGIN_SEND_REJECTED = "FEISHU_LOGIN_SEND_REJECTED";
/** FSL-145: the email HMAC has a reservation of the last 60 seconds; no row, no Feishu call. */
export const FEISHU_LOGIN_COOLDOWN = "FEISHU_LOGIN_COOLDOWN";
/** FSL-145: the global budget of the last 60 seconds is spent; no row, no Feishu call. */
export const FEISHU_LOGIN_GLOBAL_BUDGET = "FEISHU_LOGIN_GLOBAL_BUDGET";

export type FeishuLoginIssueLogKey =
  | typeof FEISHU_LOGIN_SEND_ATTEMPT
  | typeof FEISHU_LOGIN_NO_TARGET
  | typeof FEISHU_LOGIN_INACTIVE
  | typeof FEISHU_LOGIN_PROVIDER_FAILED
  | typeof FEISHU_LOGIN_SEND_UNKNOWN
  | typeof FEISHU_LOGIN_SEND_REJECTED
  | typeof FEISHU_LOGIN_COOLDOWN
  | typeof FEISHU_LOGIN_GLOBAL_BUDGET;

/** How many times an `unknown` send is retried with the same UUID (three attempts at most). */
export const FEISHU_LOGIN_SEND_MAX_RETRIES = 2;

/** The longest email the request path admits (ADR-FSL-11). */
const MAX_EMAIL_LENGTH = 254;

/** The internal token-cache label of an app; it is never sent to Feishu (ADR-FSL-12). */
export function feishuLoginTenantKey(appId: string): string {
  return `app:${appId}`;
}

export interface FeishuLoginIssuerOptions {
  /** The database pool that holds `feishu_login_codes`. */
  readonly pool: Pool;
  /** `FEISHU_APP_ID`. */
  readonly appId: string;
  /** `FEISHU_APP_SECRET`. Private: never logged. */
  readonly appSecret: string;
  /** The decoded 32-byte `ENTERPRISE_OTP_HMAC_KEY`. Private: never logged. */
  readonly otpHmacKey: Uint8Array;
  /** `BETTER_AUTH_URL`: the only site the message tells the member to trust. */
  readonly trustedSiteUrl: string;
  /** The frozen provider target (FSL-148). */
  readonly target: ProviderTarget;
  /** The 8-character code generator (FSL-150 injects the `@megaui/auth` one). */
  readonly generateCode: () => string;
  /** Receives the stable log keys only. Defaults to `console.info`. */
  readonly log?: (key: FeishuLoginIssueLogKey) => void;
  /**
   * The timeout of one HTTP attempt (token, directory or message), in milliseconds.
   * Defaults to `FEISHU_OPERATION_BUDGET_MS`; tests shorten it to provoke a timeout.
   */
  readonly attemptTimeoutMs?: number;
  /** The base delay before a service retry of an `unknown` send. Defaults to 250 ms. */
  readonly retryBackoffMs?: number;
  /**
   * FSL-160: the clock of the delivery deadline, the transport and the token cache, in
   * milliseconds. Defaults to a monotonic clock (`performance.timeOrigin + performance.now()`);
   * tests inject a clock to pass the deadline.
   */
  readonly now?: () => number;
}

export interface FeishuLoginIssueInput {
  /** The SHA-256 of the flow cookie value, as 64 lowercase hex characters. */
  readonly flowHash: string;
  /** The email the member typed; trimmed and lowercased here before any use. */
  readonly email: string;
}

/**
 * What `reserveFeishuLoginCode` resolves with, once its transaction has committed (FSL-154); the
 * request endpoint hands it, unread, to `deliverFeishuLoginCode` after the answer. It carries the
 * normalized email for the lookup and is never logged or stored.
 */
export type FeishuLoginReservation =
  | {
      readonly status: "reserved";
      /** The row id: also the stable UUID of the message. */
      readonly id: string;
      readonly email: string;
      readonly emailHmac: string;
      /** FSL-160: the absolute deadline of every Feishu request of this reservation. */
      readonly deadline: number;
    }
  /** Refused by the cooldown or the budget; the delivery does nothing. */
  | { readonly status: "cooldown" }
  | { readonly status: "budget" };

/**
 * Thrown by `reserveFeishuLoginCode` when the reservation collided with a concurrent one on a
 * unique order number (rolled back, nothing changed); the request endpoint answers 503 retry.
 */
export const FEISHU_LOGIN_RESERVE_RETRY = "FEISHU_LOGIN_RESERVE_RETRY";

export type FeishuLoginDeliveryResult =
  /** Refused at the reservation (FSL-145): nothing was called. */
  | { readonly status: "cooldown" }
  | { readonly status: "budget" }
  /** Zero or several members, or no unique match on the first page. */
  | { readonly status: "no_target" }
  /** The single member is not in office. */
  | { readonly status: "inactive" }
  /** A Feishu lookup failed or answered a shape the client cannot accept. */
  | { readonly status: "provider_failed" }
  /**
   * The row was no longer an unexpired reservation when the delivery started (FSL-145: no
   * Feishu call at all), or no longer an unexpired, newest reservation when activation ran
   * (voided, consumed, expired or superseded by a later reservation of the email); nothing
   * was sent.
   */
  | { readonly status: "not_reserved" }
  /**
   * The row was activated and the direct message attempted: `accepted` keeps it active,
   * `rejected` (every attempt rejected) voided it unless it changed meanwhile, `unknown`
   * (some attempt unknown, none accepted) keeps it active.
   */
  | { readonly status: "sent"; readonly send: FeishuMessageResult["kind"] };

export type FeishuLoginIssueResult =
  /** The reservation collided with a concurrent one; the caller answers 503 retry. */
  | { readonly status: "retry" }
  /**
   * FSL-145: refused before any new row or Feishu call, because the email has a reservation of
   * the last 60 seconds (`cooldown`) or the global budget is spent (`budget`). The request path
   * answers these like any accepted request; they never depend on whether the account exists.
   */
  | FeishuLoginDeliveryResult;

export interface FeishuLoginIssuer {
  /**
   * FSL-154 step 1, database only: resolves once the reservation transaction has committed
   * (refusals included; a failing logger does not change that); throws `FEISHU_LOGIN_RESERVE_RETRY`
   * on a unique collision (rolled back) and rethrows any database error (the request endpoint
   * answers both 503 retry). A database error is usually a rolled-back transaction; when the
   * connection fails during the commit itself, its outcome is unknown.
   */
  readonly reserveFeishuLoginCode: (input: FeishuLoginIssueInput) => Promise<FeishuLoginReservation>;
  /** FSL-154 steps 2–4: the Feishu lookup, the activation or void and the message. */
  readonly deliverFeishuLoginCode: (reservation: FeishuLoginReservation) => Promise<FeishuLoginDeliveryResult>;
  /** Both ports, one after the other; a unique collision is `{ status: "retry" }`. */
  readonly issueFeishuLoginCode: (input: FeishuLoginIssueInput) => Promise<FeishuLoginIssueResult>;
}

/** One send attempt: the HTTP status its message request received. */
interface SendAttemptContext {
  status: number | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Milliseconds on a clock that never steps back or jumps with the wall clock. */
function monotonicNow(): number {
  return performance.timeOrigin + performance.now();
}

function normalizeEmail(email: unknown): string {
  if (typeof email !== "string") throw new Error("INVALID_FEISHU_LOGIN_EMAIL");
  const normalized = email.trim().toLowerCase();
  if (normalized === "" || normalized.length > MAX_EMAIL_LENGTH) {
    throw new Error("INVALID_FEISHU_LOGIN_EMAIL");
  }
  return normalized;
}

/** Builds the issue service from the four configuration values and the injected seams. */
export function createFeishuLoginIssuer(options: FeishuLoginIssuerOptions): FeishuLoginIssuer {
  if (!options || !options.pool || typeof options.generateCode !== "function") {
    throw new Error("INVALID_FEISHU_LOGIN_ISSUER_CONFIG");
  }
  const attemptTimeoutMs = options.attemptTimeoutMs ?? FEISHU_OPERATION_BUDGET_MS;
  const retryBackoffMs = options.retryBackoffMs ?? FEISHU_BACKOFF_BASE_MS;
  // A monotonic clock by default: a wall-clock step cannot move the deadline (FSL-160).
  const now = options.now ?? monotonicNow;
  if (typeof now !== "function") throw new Error("INVALID_FEISHU_LOGIN_ISSUER_CONFIG");
  if (
    !Number.isSafeInteger(attemptTimeoutMs) ||
    attemptTimeoutMs < 1 ||
    !Number.isSafeInteger(retryBackoffMs) ||
    retryBackoffMs < 0
  ) {
    throw new Error("INVALID_FEISHU_LOGIN_ISSUER_CONFIG");
  }
  const otpHmacKey = Uint8Array.from(options.otpHmacKey);
  // Fail at construction, not at the first request, when the key is unusable.
  feishuLoginEmailHmac(otpHmacKey, "probe");
  const store: FeishuLoginCodeStore = createFeishuLoginCodeStore(options.pool);
  const log = options.log ?? ((key: FeishuLoginIssueLogKey) => console.info(key));
  const messageUrl = options.target.origin + FEISHU_MESSAGE_PATH;
  // Each `send` attempt runs in its own context, so concurrent requests never share it.
  const sendAttempt = new AsyncLocalStorage<SendAttemptContext>();
  // The HTTP status of the message request is kept for the classification; it is never shared,
  // because each attempt makes its own message request. (`FEISHU_LOGIN_SEND_ATTEMPT` is logged
  // by `sendOnce` before the attempt, ahead of the transport's deadline check, FSL-160.)
  const statusRecordingFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== messageUrl) return fetch(input, init);
    const response = await fetch(input, init);
    const context = sendAttempt.getStore();
    if (context) context.status = response.status;
    return response;
  };
  // One HTTP attempt per call (FSL-149): the retries of a send are decided below, and a
  // transient lookup failure voids the row as a provider failure.
  const transport = new FeishuTransport({
    target: options.target,
    fetchImpl: statusRecordingFetch,
    maxAttempts: 1,
    budgetMs: attemptTimeoutMs,
    now,
  });
  // One clock for the deadline, the transport and the token cache (FSL-160).
  const tokenManager = new FeishuTokenManager({ transport, now });
  const credentials: FeishuTenantCredentials = {
    tenantKey: feishuLoginTenantKey(options.appId),
    appId: options.appId,
    appSecret: options.appSecret,
  };
  const contact = new FeishuContactClient({ transport, credentials, tokenManager });
  // Every send passes the token of its delivery explicitly (FSL-160): the client never asks
  // the token manager on this path.
  const messages = new FeishuMessageClient({
    transport,
    credentials,
    tokenManager,
    trustedSiteUrl: options.trustedSiteUrl,
  });
  const generateCode = options.generateCode;

  async function voidWith(
    id: string,
    emailHmac: string,
    key: FeishuLoginIssueLogKey,
  ): Promise<void> {
    await store.voidReservation({ id, emailHmac });
    log(key);
  }

  /**
   * One send attempt with the token and the deadline of its delivery, classified by the rules of
   * FSL-149. An attempt the deadline refused never left the process: the client reports it as
   * `rejected` (`deadline`), which ends the retries (FSL-160).
   */
  async function sendOnce(
    openId: string,
    code: string,
    id: string,
    token: string,
    deadline: number,
  ): Promise<FeishuMessageResult["kind"]> {
    // An attempt whose deadline has already passed is not made and logs nothing (`rejected`:
    // Feishu never saw it). Otherwise `FEISHU_LOGIN_SEND_ATTEMPT` precedes the attempt; the
    // transport checks the deadline once more as its last step before `fetch`, after this log,
    // so a slow log can never start a request past the deadline. Only when the deadline passes
    // after this log and before that last check (during the log, the message preparation and
    // serialization, or a scheduling pause) is a key logged for an attempt the transport then
    // refuses: the key never undercounts the requests.
    if (deadline - now() <= 0) return "rejected";
    log(FEISHU_LOGIN_SEND_ATTEMPT);
    const context: SendAttemptContext = { status: undefined };
    const result = await sendAttempt.run(context, () =>
      messages.send({ boundOpenId: openId, code, uuid: id }, { token, deadline }),
    );
    // The client reports HTTP 429 as transient; Feishu did not take the request, so it is a
    // rejection here. 5xx, timeouts and dropped connections stay `unknown`.
    if (result.kind === "unknown" && context.status === 429) return "rejected";
    // A 2xx answer that does not meet the success criteria (`invalid_response`) is no explicit
    // refusal: Feishu may have taken the message, so it is `unknown`, never `rejected`.
    if (result.kind === "rejected" && result.reason === "invalid_response") return "unknown";
    // The client reports a 3xx answer to the message request (`transport_redirect`) as a
    // rejection, but it is an answer to a POST Feishu may already have taken: `unknown`.
    // (A 3xx at the token stage stays `rejected`: no message was sent then.)
    if (
      result.kind === "rejected" &&
      context.status !== undefined &&
      context.status >= 300 &&
      context.status < 400
    ) {
      return "unknown";
    }
    return result.kind;
  }

  function logQuietly(key: FeishuLoginIssueLogKey): void {
    try {
      log(key);
    } catch {
      // A failing logger never changes the result of a committed reservation.
    }
  }

  async function reserveFeishuLoginCode(input: FeishuLoginIssueInput): Promise<FeishuLoginReservation> {
    const email = normalizeEmail(input?.email);
    const emailHmac = feishuLoginEmailHmac(otpHmacKey, email);
    // FSL-160: the absolute deadline of every Feishu request of this reservation. The clock is
    // read before the reservation transaction, and the row's `created_at` is read by the
    // database after it; the deadline is this reading plus the same two-minute TTL. Only the
    // elapsed time on each clock matters, so a constant offset between the service clock and
    // the database clock cancels out: the deadline falls at most two minutes after this
    // instant, never after the stored `expires_at`.
    const deadline = now() + FEISHU_LOGIN_RESERVATION_TTL_SECONDS * 1000;

    // ① Reserve and commit before any Feishu call (FSL-154: before the request answers). The
    // flow's newest row is voided first; the cooldown and the global budget are then decided
    // under the flow, email and global locks, and a refusal writes no new row.
    const reservation = await store.reserve({ flowHash: input.flowHash, emailHmac });
    if (reservation.kind === "retry") throw new Error(FEISHU_LOGIN_RESERVE_RETRY);
    // The transaction has committed (the flow's earlier code is void): from here on nothing may
    // throw, or the request would answer 503 for a reservation that stands. A failing logger is
    // ignored.
    if (reservation.kind === "cooldown") {
      logQuietly(FEISHU_LOGIN_COOLDOWN);
      return { status: "cooldown" };
    }
    if (reservation.kind === "budget") {
      logQuietly(FEISHU_LOGIN_GLOBAL_BUDGET);
      return { status: "budget" };
    }
    return { status: "reserved", id: reservation.id, email, emailHmac, deadline };
  }

  async function deliverFeishuLoginCode(reservation: FeishuLoginReservation): Promise<FeishuLoginDeliveryResult> {
    if (reservation.status !== "reserved") return { status: reservation.status };
    const { id, email, emailHmac, deadline } = reservation;
    // ② The delivery starts: an expired reservation is voided and Feishu is never called
    // (the budget counts reservations, each one triggers at most one delivery).
    const delivery = await store.beginDelivery({ id, emailHmac });
    if (delivery.kind !== "live") return { status: "not_reserved" };

    // Take the one token of this delivery (through the shared refresh), then look the member
    // up outside every transaction with that token; every call carries the deadline, and a
    // passed deadline (`transport_deadline`) voids the row like any failed lookup (FSL-160).
    let token: string;
    let openId: string;
    let displayName: string;
    try {
      token = await tokenManager.getToken(credentials, { deadline });
      const found = await contact.findByEmail(email, { token, deadline });
      if (found.kind !== "unique") {
        await voidWith(id, emailHmac, FEISHU_LOGIN_NO_TARGET);
        return { status: "no_target" };
      }
      const member = await contact.readMember(found.openId, { token, deadline });
      if (member.kind !== "active") {
        await voidWith(id, emailHmac, FEISHU_LOGIN_INACTIVE);
        return { status: "inactive" };
      }
      openId = found.openId;
      displayName = member.name;
    } catch {
      // Transport errors and unacceptable shapes alike: fail closed, never echo the cause.
      await voidWith(id, emailHmac, FEISHU_LOGIN_PROVIDER_FAILED);
      return { status: "provider_failed" };
    }

    // ③ Activate under the flow lock, then the email lock (the same two locks as every
    // write-back above, FSL-154); the code itself never reaches the database. A reservation
    // voided by a later request of the flow is no longer `reserved` and sends nothing.
    const code = generateCode();
    const activated = await store.activate({
      id,
      emailHmac,
      email,
      openId,
      displayName,
      codeHmac: feishuLoginCodeHmac(otpHmacKey, id, code),
    });
    if (activated.kind !== "active") return { status: "not_reserved" };

    // ④ Send after the commit, with the row id as the stable UUID of this request; the
    // attempt key is logged by `sendOnce` before each HTTP attempt. Only an
    // `unknown` attempt is retried, with the same UUID and payload, the token of this delivery
    // and its deadline: no token is refreshed here, and once the deadline has passed the next
    // attempt is refused before it leaves (`rejected`), which ends the retries (FSL-160).
    let sawUnknown = false;
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await sendOnce(openId, code, id, token, deadline);
      if (outcome === "accepted") return { status: "sent", send: "accepted" };
      if (outcome === "rejected") break;
      sawUnknown = true;
      if (attempt >= FEISHU_LOGIN_SEND_MAX_RETRIES) break;
      await sleep(retryBackoffMs * 2 ** attempt);
    }
    if (sawUnknown) {
      // Feishu may hold the message: the code stays valid until it expires.
      log(FEISHU_LOGIN_SEND_UNKNOWN);
      return { status: "sent", send: "unknown" };
    }
    // Every attempt was rejected: void the row unless it changed meanwhile.
    await store.voidRejectedSend({ id, emailHmac });
    log(FEISHU_LOGIN_SEND_REJECTED);
    return { status: "sent", send: "rejected" };
  }

  return {
    reserveFeishuLoginCode,
    deliverFeishuLoginCode,
    async issueFeishuLoginCode(input) {
      let reservation: FeishuLoginReservation;
      try {
        reservation = await reserveFeishuLoginCode(input);
      } catch (error) {
        if (error instanceof Error && error.message === FEISHU_LOGIN_RESERVE_RETRY) return { status: "retry" };
        throw error;
      }
      return deliverFeishuLoginCode(reservation);
    },
  };
}
