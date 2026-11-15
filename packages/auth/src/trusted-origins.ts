// megaui:libs/auth/trusted-origins.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-06 task card):
// - Accepts an explicit `TrustedOriginsSources` object instead of reading
//   `process.env` alone, so unit tests and apps can inject values without
//   mutating global env (GC-09). `resolveAuthTrustedOriginsFromEnv()` keeps
//   the env-based entry for production wiring.
// - Documents the mega2 IT stack origin (`http://127.0.0.1:17001`) as a
//   supported `BETTER_AUTH_TRUSTED_ORIGINS` entry (PK-06 AC).

/**
 * Collect Better Auth trusted origins from config sources and expand
 * localhost / 127.0.0.1 pairs. Browsers treat these as different origins,
 * but local / IT stacks often mix them.
 */
function expandLocalhostAliases(value: string): string[] {
  try {
    const parsed = new URL(value);
    const origins = [parsed.origin];

    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      const alternateHost = parsed.hostname === "localhost" ? "127.0.0.1" : "localhost";
      const portSuffix = parsed.port ? `:${parsed.port}` : "";
      origins.push(`${parsed.protocol}//${alternateHost}${portSuffix}`);
    }

    return origins;
  } catch {
    return [];
  }
}

export interface TrustedOriginsSources {
  appBaseUrl?: string | undefined;
  betterAuthUrl?: string | undefined;
  /** Comma-separated extra origins (e.g. `http://127.0.0.1:17001`). */
  trustedOriginsCsv?: string | undefined;
}

/**
 * Resolve trusted origins from explicit sources (request-time / test-friendly).
 */
export function resolveAuthTrustedOrigins(sources: TrustedOriginsSources): string[] {
  const extra =
    sources.trustedOriginsCsv
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const candidates = [sources.appBaseUrl, sources.betterAuthUrl, ...extra];
  const origins = new Set<string>();
  for (const source of candidates) {
    if (!source) continue;
    for (const origin of expandLocalhostAliases(source)) {
      origins.add(origin);
    }
  }
  return [...origins];
}

/**
 * Resolve trusted origins from process env (Docker/runtime overrides).
 */
export function resolveAuthTrustedOriginsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return resolveAuthTrustedOrigins({
    appBaseUrl: env.APP_BASE_URL,
    betterAuthUrl: env.BETTER_AUTH_URL,
    trustedOriginsCsv: env.BETTER_AUTH_TRUSTED_ORIGINS,
  });
}
