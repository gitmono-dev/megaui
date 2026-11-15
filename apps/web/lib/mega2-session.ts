import type { Auth } from "@megaui/auth";

import { getAuth } from "./auth";
import { resolveWebActor, type WebActor } from "./enterprise-session";

export interface Mega2RawSession {
  readonly session: Readonly<{ id: string; expiresAt: Date }>;
  readonly user: Readonly<{ id: string; name: string; email: string | null; image: string | null }>;
}

export interface Mega2SessionDependencies {
  readonly readSession: (headers: Headers) => Promise<Mega2RawSession | null>;
  readonly resolveActor: (headers: Headers) => Promise<WebActor | null>;
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

export function projectMega2Session(
  session: Mega2RawSession | null,
  actor: WebActor | null,
): Mega2SessionProjection | null {
  if (!session || !actor || session.user.id !== actor.userId || session.session.id !== actor.sessionId) return null;
  const name = actor.kind === "enterprise"
    ? actor.backendUsername
    : deriveMega2Actor({ name: session.user.name, email: session.user.email });
  if (!name) return null;
  return Object.freeze({
    session: Object.freeze({ id: session.session.id, expiresAt: session.session.expiresAt }),
    user: Object.freeze({
      id: session.user.id,
      name,
      email: actor.kind === "enterprise" ? actor.email ?? null : session.user.email,
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
      const projected = projectMega2Session(session, actor);
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

const productionHandler = createMega2SessionResponseHandler({
  readSession: headers => readRawSession(getAuth(), headers),
  resolveActor: resolveWebActor,
});

export function getMega2SessionResponse(request: Request): Promise<Response> {
  return productionHandler(request);
}
