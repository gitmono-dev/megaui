import type { NextResponse } from "next/server";
import { megaFailureResponse, type MegaHttpFailureBody } from "./envelope";

export const CSRF_ORIGIN_REJECTED_CODE = "CSRF_ORIGIN_REJECTED" as const;

function parseCanonicalOrigins(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("*")) {
    return [];
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return [];
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return [];
  }
  if (parsed.username || parsed.password) {
    return [];
  }
  const results = [parsed.origin];
  // Match `@megaui/auth` (`trusted-origins.ts`): expand localhost <-> 127.0.0.1
  // loopback aliases at the exact same protocol and port so existing local/IT
  // stacks that authenticate via Better Auth can also mutate.
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    const alternateHost =
      parsed.hostname === "localhost" ? "127.0.0.1" : "localhost";
    const portSuffix = parsed.port ? `:${parsed.port}` : "";
    results.push(`${parsed.protocol}//${alternateHost}${portSuffix}`);
  }
  return results;
}

export type CsrfEnv = Readonly<Record<string, string | undefined>>;

export function resolveCanonicalAllowedOrigins(
  env: CsrfEnv = process.env,
): ReadonlySet<string> {
  const origins = new Set<string>();

  for (const single of [env.APP_BASE_URL, env.BETTER_AUTH_URL]) {
    if (!single) continue;
    for (const origin of parseCanonicalOrigins(single)) {
      origins.add(origin);
    }
  }

  if (env.BETTER_AUTH_TRUSTED_ORIGINS) {
    for (const entry of env.BETTER_AUTH_TRUSTED_ORIGINS.split(",")) {
      for (const origin of parseCanonicalOrigins(entry)) {
        origins.add(origin);
      }
    }
  }

  return origins;
}

function parseExactRequestOriginHeader(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  if (parsed.username || parsed.password) {
    return undefined;
  }
  // Reject Origin headers carrying paths, queries, fragments, or trailing slashes.
  if (parsed.origin !== trimmed) {
    return undefined;
  }
  return parsed.origin;
}

function rejectCsrfOrigin(): NextResponse<MegaHttpFailureBody> {
  return megaFailureResponse(
    {
      error: {
        code: CSRF_ORIGIN_REJECTED_CODE,
        messageKey: "errors.mega.forbidden",
        message: "Untrusted or cross-site mutation request rejected",
      },
    },
    403,
  );
}

/**
 * Canonical-origin CSRF guard (`ADR-CLB-05` / `CLB-20`) for cookie-authenticated
 * mutation routes (`POST`/`PUT`/`DELETE`). Returns a `403 CSRF_ORIGIN_REJECTED`
 * `NextResponse` on failure or `undefined` when the request is allowed.
 */
export function requireSameOriginCsrf(
  request: Request,
  env: CsrfEnv = process.env,
): NextResponse<MegaHttpFailureBody> | undefined {
  const secFetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (secFetchSite === "cross-site") {
    return rejectCsrfOrigin();
  }

  const allowedOrigins = resolveCanonicalAllowedOrigins(env);
  if (allowedOrigins.size === 0) {
    return rejectCsrfOrigin();
  }

  const requestOrigin = parseExactRequestOriginHeader(
    request.headers.get("origin"),
  );
  if (!requestOrigin || !allowedOrigins.has(requestOrigin)) {
    return rejectCsrfOrigin();
  }

  return undefined;
}
