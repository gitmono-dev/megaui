// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (collab/token segment)
//
// Diff vs upstream (GC-03 / EG-13 / RT-04):
// - Uses `createCollabTokenService` from `@megaui/engine` (session-gated mint).
// - Returns `{ token, userId, expiresAtMs }` only (no displayName/publicUrl).
// - Optional `?room=collection:channel:{id}` mints a v2 ticket after
//   `assertCanAccessChannel` (ADR-RT-03). Illegal rooms are 400.

import { parseCollectionChannelRoomName } from "@megaui/core";
import { MegaBadRequestError, MegaUnauthorizedError } from "@megaui/engine";

import { getChatDomain, getCollabDomain } from "@/lib/engine";
import type { WebActor } from "@/lib/enterprise-session";
import { resolveWebActor } from "@/lib/enterprise-session";
import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { invalidRoute, only } from "./shared";

export interface CollabSessionContext {
  readonly userId: string;
  readonly username: string;
  readonly enterprise?: Readonly<{ identityId: string; authEpoch: number }>;
}

export function buildCollabSessionContext(actor: WebActor): CollabSessionContext {
  const username = actor.kind === "enterprise"
    ? actor.backendUsername
    : actor.email ?? actor.userId;
  if (!username?.trim()) throw new MegaUnauthorizedError("Missing backend username for collab");
  if (actor.kind === "enterprise") {
    const identityId = actor.identityId?.trim();
    const authEpoch = actor.authEpoch;
    if (!identityId || typeof authEpoch !== "number" || !Number.isSafeInteger(authEpoch) || authEpoch < 0) {
      throw new MegaUnauthorizedError("Missing enterprise collab metadata");
    }
    return {
      userId: actor.userId,
      username,
      enterprise: { identityId, authEpoch },
    };
  }
  return { userId: actor.userId, username };
}

async function dispatchCollabTokenGet(context: MegaDispatchContext): Promise<unknown> {
  const { segments, headers, searchParams } = context;

  if (!only(segments, ["collab", "token"])) {
    return invalidRoute(segments);
  }

  const actor = await resolveWebActor(headers);
  if (!actor) {
    throw new MegaUnauthorizedError("Missing session for collab");
  }

  const sessionContext = buildCollabSessionContext(actor);
  const userId = sessionContext.userId;
  const room = searchParams.get("room")?.trim();
  if (!room) {
    return getCollabDomain().token.mintForSession(sessionContext, sessionContext.enterprise
      ? { enterprise: sessionContext.enterprise }
      : undefined);
  }

  const channelId = parseCollectionChannelRoomName(room);
  if (!channelId) {
    throw new MegaBadRequestError("Invalid collab room");
  }

  await getChatDomain().members.assertCanAccessChannel(channelId, userId);
  return getCollabDomain().token.mintForSession(sessionContext, {
    roomName: room,
    ...(sessionContext.enterprise ? { enterprise: sessionContext.enterprise } : {}),
  });
}

registerMegaRoute({
  match: (method, segments) => method === "GET" && only(segments, ["collab", "token"]),
  handle: dispatchCollabTokenGet,
});
