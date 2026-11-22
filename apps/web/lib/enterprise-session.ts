// megaui-only (FS-15): one protected Web actor resolver for pages and BFF.
//
// The resolver treats the verified Better Auth session as the only input from
// the request. FSL-132: it has exactly two branches, legacy and Feishu; the old
// enterprise authority, eligibility and maintenance branches are gone.
//
// FSL-126: with AUTH_MODE=enterprise and AUTH_PROVIDER=feishu the resolver
// accepts only a Better Auth session that has a `feishu_login_sessions` row
// written at most eight hours ago; any other session of the same user is
// treated as signed out. The Auth instance it reads sessions with is whatever
// `getAuth()` returns (its Feishu-mode construction is FSL-150).
import type { Auth } from "@megaui/auth";
import { resolveAuthMode } from "@megaui/core";
import { getPool } from "@megaui/database";

import { getAuth } from "./auth";

export interface WebSessionSnapshot {
  readonly user: Readonly<{ id: string; email?: string | null }>;
  readonly session: Readonly<{ id: string }>;
}

export interface WebActor {
  /** `resolveWebActor` produces only these two kinds (FSL-132, FSL-134). */
  readonly kind: "legacy" | "feishu";
  readonly userId: string;
  readonly email?: string | null;
  readonly sessionId: string;
}

export interface LegacyWebActorResolverPorts {
  readonly readSession: (headers: Headers) => Promise<WebSessionSnapshot | null>;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function validSnapshot(value: WebSessionSnapshot | null): value is WebSessionSnapshot {
  return Boolean(value && validText(value.user?.id) && validText(value.session?.id));
}

/** Pure legacy decision layer: any valid Better Auth session is the actor. */
export function createLegacyWebActorResolver(ports: LegacyWebActorResolverPorts) {
  return async (headers: Headers): Promise<WebActor | null> => {
    let snapshot: WebSessionSnapshot | null;
    try {
      snapshot = await ports.readSession(headers);
    } catch {
      return null;
    }
    if (!validSnapshot(snapshot)) return null;
    return Object.freeze({
      kind: "legacy" as const,
      userId: snapshot.user.id,
      ...(snapshot.user.email !== undefined ? { email: snapshot.user.email } : {}),
      sessionId: snapshot.session.id,
    });
  };
}

/** FSL-126: a Feishu login session is accepted for this long after its marker row was written. */
export const FEISHU_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/**
 * Which session entry the deployment uses. `existing` is the legacy path (AUTH_MODE
 * unset or `legacy`, AUTH_PROVIDER unset or `local`). A pair that `resolveAuthMode`
 * refuses is `invalid` and resolves no actor (fail-closed); from FSL-132 that includes
 * `maintenance` and `enterprise` without AUTH_PROVIDER.
 */
export type WebSessionEntry = "existing" | "feishu" | "invalid";

export function resolveWebSessionEntry(source: NodeJS.Dict<string> = process.env): WebSessionEntry {
  try {
    const resolved = resolveAuthMode({ AUTH_MODE: source.AUTH_MODE, AUTH_PROVIDER: source.AUTH_PROVIDER });
    return resolved.mode === "enterprise" && resolved.provider === "feishu" ? "feishu" : "existing";
  } catch {
    return "invalid";
  }
}

export interface FeishuWebActorResolverPorts {
  readonly readSession: (headers: Headers) => Promise<WebSessionSnapshot | null>;
  /**
   * Age in milliseconds of the session's `feishu_login_sessions` row, or null when it has
   * none. Production measures it on the database clock, the clock that wrote `created_at`.
   */
  readonly readFeishuSessionAgeMs: (session: WebSessionSnapshot) => Promise<number | null>;
}

/**
 * Pure Feishu-mode decision layer. Continued use never extends the limit:
 * the age is measured from the marker row, which no request rewrites, so a
 * Better Auth refresh of the session expiry cannot keep it alive. A negative
 * age (a row dated in the future of its own clock) is refused as well.
 */
export function createFeishuWebActorResolver(ports: FeishuWebActorResolverPorts) {
  return async (headers: Headers): Promise<WebActor | null> => {
    let snapshot: WebSessionSnapshot | null;
    try {
      snapshot = await ports.readSession(headers);
    } catch {
      return null;
    }
    if (!validSnapshot(snapshot)) return null;
    let ageMs: number | null;
    try {
      ageMs = await ports.readFeishuSessionAgeMs(snapshot);
    } catch {
      return null;
    }
    if (typeof ageMs !== "number" || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > FEISHU_SESSION_MAX_AGE_MS) return null;
    return Object.freeze({
      kind: "feishu" as const,
      userId: snapshot.user.id,
      ...(snapshot.user.email !== undefined ? { email: snapshot.user.email } : {}),
      sessionId: snapshot.session.id,
    });
  };
}

type Pool = Pick<ReturnType<typeof getPool>, "query">;

/**
 * Both ends of the age come from PostgreSQL: `created_at` is written by the column
 * default `now()`, and the age is taken against `clock_timestamp()` of this read, so
 * the Web process clock (and any skew to the database) plays no part.
 */
async function readFeishuLoginSessionAgeMs(pool: Pool, session: WebSessionSnapshot): Promise<number | null> {
  const result = await pool.query(
    `select (extract(epoch from (clock_timestamp() - marker.created_at)) * 1000)::float8 as "ageMs"
       from feishu_login_sessions as marker
       join "session" as current_session on current_session.id = marker.session_id
      where marker.session_id = $1
        and current_session.user_id = $2
      limit 2`,
    [session.session.id, session.user.id],
  );
  if (result.rows.length !== 1) return null;
  const ageMs = (result.rows[0] as { ageMs?: unknown }).ageMs;
  return typeof ageMs === "number" ? ageMs : null;
}

function readSessionSnapshot(auth: Auth, headers: Headers): Promise<WebSessionSnapshot | null> {
  return auth.api.getSession({
    headers,
    // The actor gate must never authorize from a stale signed cache.
    query: { disableCookieCache: true, disableRefresh: true },
  }).then(result => result ? {
    user: { id: result.user.id, email: result.user.email ?? null },
    session: { id: result.session.id },
  } : null);
}

/** Resolve a request into an actor (legacy or Feishu), or null for every failure. */
export async function resolveWebActor(headers: Headers): Promise<WebActor | null> {
  try {
    const entry = resolveWebSessionEntry();
    if (entry === "invalid") return null;
    if (entry === "feishu") {
      const pool = getPool();
      return await createFeishuWebActorResolver({
        readSession: input => readSessionSnapshot(getAuth(), input),
        readFeishuSessionAgeMs: session => readFeishuLoginSessionAgeMs(pool, session),
      })(headers);
    }
    return await createLegacyWebActorResolver({
      readSession: input => readSessionSnapshot(getAuth(), input),
    })(headers);
  } catch {
    return null;
  }
}
