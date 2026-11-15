// megaui:libs/email/internal/bearer.ts@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-05):
// - Delegates constant-time compare to `@megaui/engine` (`compareBearerToken`).

import { compareBearerToken, extractBearerToken } from "@megaui/engine";

/** Env key shared with mega2 compose / SecretRef injection. */
export const INTERNAL_MAIL_BEARER_ENV = "MEGA2_INTERNAL_MAIL_BEARER";

export { extractBearerToken };

export function getConfiguredInternalMailBearer(): string | undefined {
  const value = process.env[INTERNAL_MAIL_BEARER_ENV];
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return value;
}

export function verifyInternalMailBearer(authorization: string | null): boolean {
  const expected = getConfiguredInternalMailBearer();
  if (!expected) {
    return false;
  }
  const provided = extractBearerToken(authorization);
  if (!provided) {
    return false;
  }
  return compareBearerToken(provided, expected);
}
