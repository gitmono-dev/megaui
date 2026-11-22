// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-13 task card):
// - Upstream minted directly inside the `/api/mega/collab/token` route handler
//   dispatch (`only(segments, ['collab', 'token'])`), reading
//   `MEGA_COLLAB_INTERNAL_TOKEN` from `process.env` inline and calling
//   `auth.api.getSession` itself. This port extracts the session-gated core
//   into `@megaui/engine`, decoupled from HTTP/cookie transport and the
//   session provider, so both the BFF route (WA-05) and any future call
//   site can share one fail-closed implementation.
// - `MEGA_COLLAB_INTERNAL_TOKEN` doubles as the ticket HMAC secret *and* the
//   internal-bridge bearer token upstream; that overload is preserved here
//   (see `internal-bridge.ts` for the bridge side) rather than introducing a
//   second env var.
// - Drops `assertCanJoinCollab` (upstream's ADR-CE-11 open-editor gate on
//   minting itself); this repo's `createCollabAuthzService` (`authz.ts`)
//   judges per-document access only at write time (EG-13 AC2).
// - FSL-134: tickets carry no enterprise metadata; every session gets an
//   ordinary v1 (or channel-bound v2) ticket.
import { parseCollectionChannelRoomName } from "@megaui/core";
import {
  COLLAB_TICKET_TTL_MS,
  mintCollabTicket,
  verifyCollabTicket,
} from "@megaui/core/collab/ticket";
import { requireSession, type SessionContext } from "../../context";
import { MegaBadRequestError, MegaInternalError } from "../../errors";

export interface CollabTokenEnv {
  MEGA_COLLAB_INTERNAL_TOKEN?: string;
}

export interface CollabTokenConfig {
  /** Explicit secret (tests / callers that don't want a process.env read). */
  secret?: string;
  env?: CollabTokenEnv;
  nowMs?: number;
  ttlMs?: number;
}

export interface MintedCollabToken {
  token: string;
  userId: string;
  expiresAtMs: number;
}

function resolveCollabTokenSecret(config?: CollabTokenConfig): string | null {
  const explicit = config?.secret?.trim();
  if (explicit) return explicit;
  const fromEnv = (
    config?.env ?? (process.env as CollabTokenEnv)
  ).MEGA_COLLAB_INTERNAL_TOKEN?.trim();
  return fromEnv || null;
}

/**
 * Session-gated collab ticket minting + verification (EG-13 AC1/AC2).
 *
 * Minting only requires a *valid session* — it is not a per-document write
 * grant. Per-document write access is judged separately by
 * `createCollabAuthzService`, so a member with read-only doc access can
 * still mint a ticket successfully (needed to open the room read-only) even
 * though a subsequent write will be denied (EG-13 AC2, fail-closed).
 */
export function createCollabTokenService(config?: CollabTokenConfig) {
  function secretOrThrow(): string {
    const secret = resolveCollabTokenSecret(config);
    if (!secret) {
      // GC-07/ER-11: operable message naming the missing var, never a value.
      throw new MegaInternalError(
        "Collab bridge is not configured (MEGA_COLLAB_INTERNAL_TOKEN unset)",
      );
    }
    return secret;
  }

  function mintForSession(
    session: Partial<SessionContext> | null | undefined,
    options?: { roomName?: string },
  ): MintedCollabToken {
    const { userId } = requireSession(session);
    const secret = secretOrThrow();
    const nowMs = config?.nowMs ?? Date.now();
    const ttlMs = config?.ttlMs ?? COLLAB_TICKET_TTL_MS;
    const roomName = options?.roomName?.trim();
    if (roomName) {
      if (!parseCollectionChannelRoomName(roomName)) {
        throw new MegaBadRequestError("Invalid collab room");
      }
      const token = mintCollabTicket(userId, secret, { nowMs, ttlMs, roomName });
      return { token, userId, expiresAtMs: nowMs + ttlMs };
    }
    const token = mintCollabTicket(userId, secret, { nowMs, ttlMs });
    return { token, userId, expiresAtMs: nowMs + ttlMs };
  }

  /** Fail-closed: an unconfigured secret rejects rather than throwing. */
  function verify(token: string, options?: { nowMs?: number }): string | null {
    const secret = resolveCollabTokenSecret(config);
    if (!secret) return null;
    return (
      verifyCollabTicket(token, secret, {
        nowMs: options?.nowMs ?? config?.nowMs,
      })?.userId ?? null
    );
  }

  function isConfigured(): boolean {
    return resolveCollabTokenSecret(config) !== null;
  }

  return { mintForSession, verify, isConfigured };
}

export type CollabTokenService = ReturnType<typeof createCollabTokenService>;
