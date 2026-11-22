// FSL-156: a Feishu session (FSL-126's `WebActor.kind === "feishu"`) is projected to
// Mega2 with `user.name` = `fs_<Better Auth user ID>`, never the Feishu display name or
// the email local part. Before answering, every other local user's Mega2 user name is
// derived with `deriveMega2Actor` (the same rule as Mega2's `into_login_user`); when one
// of them equals that principal, or the check cannot be completed, the session is
// projected as `null` and the stable log key `FEISHU_LOGIN_PRINCIPAL_CONFLICT` is emitted.
// Legacy actors keep their projection unchanged and run no check. FSL-132: no enterprise
// actor is produced any more and one is never projected (fail-closed).
import type { Auth } from "@megaui/auth";
import { getPool } from "@megaui/database";

import { getAuth } from "./auth";
import { resolveWebActor, type WebActor } from "./enterprise-session";

export interface Mega2RawSession {
  readonly session: Readonly<{ id: string; expiresAt: Date }>;
  readonly user: Readonly<{ id: string; name: string; email: string | null; image: string | null }>;
}

/** A local user whose Mega2 user name may equal a Feishu principal (FSL-156). */
export interface Mega2PrincipalCandidate {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  /** `enterprise_profile.backend_username`, or null when the user has no enterprise profile. */
  readonly frozenBackendUsername: string | null;
}

export const FEISHU_LOGIN_PRINCIPAL_CONFLICT = "FEISHU_LOGIN_PRINCIPAL_CONFLICT";

export interface Mega2SessionDependencies {
  readonly readSession: (headers: Headers) => Promise<Mega2RawSession | null>;
  readonly resolveActor: (headers: Headers) => Promise<WebActor | null>;
  /**
   * FSL-156: every local user other than `userId` whose derived Mega2 user name could
   * equal `principal` (a superset is allowed; the handler derives and compares each).
   * Without it a Feishu session is projected as `null`.
   */
  readonly readPrincipalCandidates?: (principal: string, userId: string) => Promise<readonly Mega2PrincipalCandidate[]>;
  /** Receives the stable log key only. Defaults to `console.warn`. */
  readonly log?: (key: typeof FEISHU_LOGIN_PRINCIPAL_CONFLICT) => void;
}

/** FSL-156: the Mega2 principal of a Feishu user, `fs_<Better Auth user ID>`. */
export function feishuMega2Principal(userId: string): string {
  return `fs_${userId}`;
}

function rustTrim(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

/** REF-10's WebsiteAuthUserJson::into_login_user actor derivation. */
export function deriveMega2Actor(input: {
  readonly name: string;
  readonly email: string | null;
  readonly frozenBackendUsername?: string | null;
}): string | undefined {
  if (input.frozenBackendUsername !== undefined && input.frozenBackendUsername !== null) {
    return input.frozenBackendUsername;
  }
  if (rustTrim(input.name) !== "") return input.name;
  const at = input.email?.indexOf("@") ?? -1;
  const localPart = at < 0 ? undefined : rustTrim(input.email!.slice(0, at));
  return localPart === "" ? undefined : localPart;
}

export interface Mega2SessionProjection {
  readonly session: Readonly<{ id: string; expiresAt: Date }>;
  readonly user: Readonly<{
    id: string;
    name: string;
    email: string | null;
    image: string | null;
    banned: false;
  }>;
}

function sameSession(session: Mega2RawSession | null, actor: WebActor | null): session is Mega2RawSession {
  return Boolean(session && actor && session.user.id === actor.userId && session.session.id === actor.sessionId);
}

/**
 * A Feishu actor is projected only when the caller passes `feishuPrincipalChecked`,
 * i.e. after the principal conflict check of FSL-156 found no conflict.
 */
export function projectMega2Session(
  session: Mega2RawSession | null,
  actor: WebActor | null,
  options: Readonly<{ feishuPrincipalChecked?: boolean }> = {},
): Mega2SessionProjection | null {
  if (!sameSession(session, actor) || !actor) return null;
  if (actor.kind === "feishu" && options.feishuPrincipalChecked !== true) return null;
  const name = actor.kind === "feishu"
    ? feishuMega2Principal(actor.userId)
    : deriveMega2Actor({ name: session.user.name, email: session.user.email });
  if (!name) return null;
  return Object.freeze({
    session: Object.freeze({ id: session.session.id, expiresAt: session.session.expiresAt }),
    user: Object.freeze({
      id: session.user.id,
      name,
      email: session.user.email,
      image: session.user.image,
      banned: false as const,
    }),
  });
}

function readRawSession(auth: Auth, headers: Headers): Promise<Mega2RawSession | null> {
  return auth.api.getSession({
    headers,
    query: { disableCookieCache: true, disableRefresh: true },
  }).then(result => result ? {
    session: { id: result.session.id, expiresAt: result.session.expiresAt },
    user: {
      id: result.user.id,
      name: result.user.name,
      email: result.user.email ?? null,
      image: result.user.image ?? null,
    },
  } : null);
}

/**
 * True only when the check completed and no other local user derives `principal`.
 * Every failure (missing port, query error, malformed row) answers false.
 */
async function feishuPrincipalIsFree(
  dependencies: Mega2SessionDependencies,
  principal: string,
  userId: string,
): Promise<boolean> {
  if (!dependencies.readPrincipalCandidates) return false;
  try {
    const candidates = await dependencies.readPrincipalCandidates(principal, userId);
    if (!Array.isArray(candidates)) return false;
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.id !== "string" || typeof candidate.name !== "string"
        || (candidate.email !== null && typeof candidate.email !== "string")
        || (candidate.frozenBackendUsername !== null && typeof candidate.frozenBackendUsername !== "string")) return false;
      if (candidate.id === userId) continue;
      const derived = deriveMega2Actor({
        name: candidate.name,
        email: candidate.email,
        frozenBackendUsername: candidate.frozenBackendUsername,
      });
      if (derived === principal) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function emitPrincipalConflict(dependencies: Mega2SessionDependencies): void {
  try {
    (dependencies.log ?? (key => console.warn(key)))(FEISHU_LOGIN_PRINCIPAL_CONFLICT);
  } catch {
    // The response does not depend on the logger.
  }
}

export function createMega2SessionResponseHandler(dependencies: Mega2SessionDependencies) {
  return async (request: Request): Promise<Response> => {
    try {
      const actor = await dependencies.resolveActor(request.headers);
      if (!actor) {
        return Response.json(null, {
          status: 200,
          headers: { "cache-control": "no-store" },
        });
      }
      const session = await dependencies.readSession(request.headers);
      let feishuPrincipalChecked = false;
      if (actor.kind === "feishu" && sameSession(session, actor)) {
        feishuPrincipalChecked = await feishuPrincipalIsFree(dependencies, feishuMega2Principal(actor.userId), actor.userId);
        if (!feishuPrincipalChecked) emitPrincipalConflict(dependencies);
      }
      const projected = projectMega2Session(session, actor, { feishuPrincipalChecked });
      return Response.json(projected, {
        status: 200,
        headers: { "cache-control": "no-store" },
      });
    } catch {
      return Response.json(null, {
        status: 200,
        headers: { "cache-control": "no-store" },
      });
    }
  };
}

/**
 * The prefilter keeps every user whose derived Mega2 user name can equal `principal`:
 * a frozen enterprise principal equal to it, a `name` equal to it (a non-blank `name`
 * is used verbatim), or an email containing it (the trimmed local part). The handler
 * then applies `deriveMega2Actor` to each row. FSL-139 removes the `enterprise_profile`
 * join together with the enterprise database code.
 */
async function readPrincipalCandidates(principal: string, userId: string): Promise<readonly Mega2PrincipalCandidate[]> {
  const result = await getPool().query<Mega2PrincipalCandidate>(
    `select candidate.id as "id",
            candidate.name as "name",
            candidate.email as "email",
            profile.backend_username as "frozenBackendUsername"
       from "user" as candidate
       left join enterprise_profile as profile on profile.user_id = candidate.id
      where candidate.id <> $2
        and (candidate.name = $1
             or strpos(candidate.email, $1) > 0
             or profile.backend_username = $1)`,
    [principal, userId],
  );
  return result.rows;
}

const productionHandler = createMega2SessionResponseHandler({
  readSession: headers => readRawSession(getAuth(), headers),
  resolveActor: resolveWebActor,
  readPrincipalCandidates,
});

export function getMega2SessionResponse(request: Request): Promise<Response> {
  return productionHandler(request);
}
