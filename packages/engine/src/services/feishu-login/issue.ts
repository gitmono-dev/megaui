// megaui-only (FSL-122): the main flow of issuing a Feishu login code.
/**
 * FSL-122：验证码签发服务主流程（ADR-FSL-11「发码」）。
 *
 * `issueFeishuLoginCode({ flowHash, email })` runs four steps:
 *
 * 1. the reservation transaction writes the `reserved` row of this request and commits;
 * 2. outside any transaction, Directory v1 finds the single member of the email and reads
 *    whether the member is in office (`FeishuContactClient`, FSL-117);
 * 3. the activation transaction serializes the email with an advisory lock, voids every
 *    `active` row of the email HMAC (in any flow, sensitive fields cleared) and turns this
 *    row `active` with the email, open_id, name and code HMAC; no target, several members,
 *    an inactive member or a failed Feishu call void this row in a transaction of the same
 *    shape instead;
 * 4. after the commit, `FeishuMessageClient` sends the code as a direct message with the
 *    row id as the stable UUID of this request; `FEISHU_LOGIN_SEND_ATTEMPT` is logged
 *    before every HTTP attempt of that message (the transport fetch is wrapped, so the
 *    attempts the transport repeats inside one call are counted too).
 *
 * The log only carries the stable keys below: never an email, an open_id, a name, a code,
 * a token or a message id. The code generator is injected (engine does not depend on
 * `@megaui/auth`; FSL-150 injects its generator). The Feishu clients are built from the
 * app id and secret only: the credential `tenantKey` is the internal label
 * `app:<FEISHU_APP_ID>`, a token cache key that is never sent to Feishu. The trusted site
 * in the message is `BETTER_AUTH_URL`.
 *
 * Out of this card: the state checks before activation and the three send outcomes
 * (FSL-149), the cooldown, budget and serialization of reservations (FSL-145), the HTTP
 * entry (FSL-123) and the cleanup (FSL-146).
 */
import type { ProviderTarget } from "@megaui/core";
import {
  createFeishuLoginCodeStore,
  feishuLoginCodeHmac,
  feishuLoginEmailHmac,
  type FeishuLoginCodeStore,
} from "@megaui/database";
import type { Pool } from "pg";

import { FeishuTransport } from "../enterprise/feishu/http";
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

export type FeishuLoginIssueLogKey =
  | typeof FEISHU_LOGIN_SEND_ATTEMPT
  | typeof FEISHU_LOGIN_NO_TARGET
  | typeof FEISHU_LOGIN_INACTIVE
  | typeof FEISHU_LOGIN_PROVIDER_FAILED;

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
}

export interface FeishuLoginIssueInput {
  /** The SHA-256 of the flow cookie value, as 64 lowercase hex characters. */
  readonly flowHash: string;
  /** The email the member typed; trimmed and lowercased here before any use. */
  readonly email: string;
}

export type FeishuLoginIssueResult =
  /** The reservation collided with a concurrent one; the caller answers 503 retry. */
  | { readonly status: "retry" }
  /** Zero or several members, or no unique match on the first page. */
  | { readonly status: "no_target" }
  /** The single member is not in office. */
  | { readonly status: "inactive" }
  /** A Feishu lookup failed or answered a shape the client cannot accept. */
  | { readonly status: "provider_failed" }
  /** The row was no longer reserved when activation ran; nothing was sent. */
  | { readonly status: "not_reserved" }
  /** The row is active and the direct message was sent (one `send` call). */
  | { readonly status: "sent"; readonly send: FeishuMessageResult["kind"] };

export interface FeishuLoginIssuer {
  readonly issueFeishuLoginCode: (input: FeishuLoginIssueInput) => Promise<FeishuLoginIssueResult>;
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
  const otpHmacKey = Uint8Array.from(options.otpHmacKey);
  // Fail at construction, not at the first request, when the key is unusable.
  feishuLoginEmailHmac(otpHmacKey, "probe");
  const store: FeishuLoginCodeStore = createFeishuLoginCodeStore(options.pool);
  const log = options.log ?? ((key: FeishuLoginIssueLogKey) => console.info(key));
  const messageUrl = options.target.origin + FEISHU_MESSAGE_PATH;
  // `FEISHU_LOGIN_SEND_ATTEMPT` precedes every HTTP attempt of a direct message, including
  // the attempts the transport repeats inside one `send` call, so the key counts requests.
  const attemptLoggingFetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === messageUrl) log(FEISHU_LOGIN_SEND_ATTEMPT);
    return fetch(input, init);
  };
  const transport = new FeishuTransport({ target: options.target, fetchImpl: attemptLoggingFetch });
  const tokenManager = new FeishuTokenManager({ transport });
  const credentials: FeishuTenantCredentials = {
    tenantKey: feishuLoginTenantKey(options.appId),
    appId: options.appId,
    appSecret: options.appSecret,
  };
  const contact = new FeishuContactClient({ transport, credentials, tokenManager });
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

  return {
    async issueFeishuLoginCode(input) {
      const email = normalizeEmail(input?.email);
      const emailHmac = feishuLoginEmailHmac(otpHmacKey, email);

      // ① Reserve and commit before any Feishu call.
      const reservation = await store.reserve({ flowHash: input.flowHash, emailHmac });
      if (reservation.kind === "retry") return { status: "retry" };
      const id = reservation.id;

      // ② Look the member up outside every transaction.
      let openId: string;
      let displayName: string;
      try {
        const found = await contact.findByEmail(email);
        if (found.kind !== "unique") {
          await voidWith(id, emailHmac, FEISHU_LOGIN_NO_TARGET);
          return { status: "no_target" };
        }
        const member = await contact.readMember(found.openId);
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

      // ③ Activate under the email lock; the code itself never reaches the database.
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
      // attempt key is logged by the transport fetch before each HTTP attempt.
      const result = await messages.send({ boundOpenId: openId, code, uuid: id });
      return { status: "sent", send: result.kind };
    },
  };
}
