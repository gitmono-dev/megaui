// megaui:libs/mega/services/notification-delivery.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-09 task card):
// - Webhook delivery channel dropped entirely (DEFER-RW-06, card
//   Out-of-scope): only the email channel is ported.
// - Email delivery is an injected `EmailDeliveryPort` rather than a direct
//   `@megaui/email` call — see `types.ts` diff header for why (write-set
//   scope: wiring the concrete provider touches `package.json`).
// - `deliverNotificationEmail` never throws (AC3: error isolation) —
//   upstream's delivery call sat inline in the notification-write path and
//   could reject that whole call; here a delivery failure is always
//   reported back as a typed `{ ok: false }` result instead.
// - Adds `compareBearerToken` / `extractBearerToken`: upstream's
//   `MEGA2_INTERNAL_MAIL_BEARER` check is new surface for megaui (the
//   mega2 reverse-mail-call bearer, GC-07/ER-11) — the actual HTTP
//   route lives in WA-05, but the comparison primitive is exported from
//   here so that route and this package's tests share one implementation.
import { createHash, timingSafeEqual } from "node:crypto";
import type {
  EmailDeliveryPort,
  EmailDeliveryResult,
  NotificationEmailParams,
} from "./types";

/**
 * AC3: a rejected/throwing `port.send` must never propagate — by the time
 * this runs, the in-app notification row is already committed, so an email
 * outage must not undo or block that write. Callers should treat every
 * return value here (including `{ ok: false }`) as "safe to ignore or log",
 * never as something to rethrow.
 */
export async function deliverNotificationEmail(
  port: EmailDeliveryPort | undefined,
  params: NotificationEmailParams,
): Promise<EmailDeliveryResult> {
  if (!port) return { ok: false, code: "no_provider" };
  try {
    const result = await port.send(params);
    if (result.ok) return { ok: true };
    return { ok: false, code: "delivery_failed", message: result.message };
  } catch (error) {
    return {
      ok: false,
      code: "delivery_failed",
      message: error instanceof Error ? error.message : "unknown email delivery error",
    };
  }
}

/**
 * Constant-time bearer compare for the `MEGA2_INTERNAL_MAIL_BEARER`
 * internal mail entry point (GC-07 fail-closed / ER-11 secret hygiene).
 *
 * Both sides are hashed to a fixed-length (32-byte) digest before
 * `timingSafeEqual` runs, so — unlike a naive `providedBuffer.length ===
 * expectedBuffer.length` guard — the comparison never takes a
 * length-dependent early-exit branch that could leak the real secret's
 * length via timing. `timingSafeEqual` itself never throws here because
 * both digests are always the same fixed length.
 *
 * Never logs `provided` or `expectedSecret`, and callers must not either
 * (ER-11) — do not interpolate either argument into a thrown/logged
 * message anywhere in this call chain.
 */
export function compareBearerToken(
  provided: string | null | undefined,
  expectedSecret: string,
): boolean {
  if (!expectedSecret) return false;
  const providedDigest = createHash("sha256").update(provided ?? "", "utf8").digest();
  const expectedDigest = createHash("sha256").update(expectedSecret, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Extracts the token from a `Authorization: Bearer <token>` header value.
 * Case-insensitive on the `Bearer` scheme; returns `null` (never throws)
 * when the header is missing/empty or does not use the Bearer scheme.
 */
export function extractBearerToken(authorizationHeader: string | null | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = /^\s*Bearer\s+(\S.*)$/i.exec(authorizationHeader);
  const token = match?.[1]?.trim();
  return token ? token : null;
}
