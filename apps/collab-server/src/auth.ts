/**
 * Collab WS auth: core ticket only (no session cookie fallback).
 * Doc authz is injectible so CS-01 does not import @megaui/engine (ADR-ARCH-01).
 */

import {
  resolveAuthMode,
  type AuthMode,
  type AuthModeSource,
  type EnterprisePolicyResponse,
} from "@megaui/core";
import { verifyCollabTicket } from "@megaui/core/collab/ticket";

import { parseRoomName, type ParsedRoom } from "./rooms.js";
import { assertCollabPolicyCompatible } from "./enterprise-policy.js";

export type CollabDocAccessReason =
  | "unauthenticated"
  | "no_access"
  | "read_only"
  | "editor";

/** Mirror of engine CollabDocAccessResult (contract copy — do not import engine). */
export interface CollabDocAccessResult {
  allow: boolean;
  readOnly: boolean;
  role: string;
  reason: CollabDocAccessReason;
}

export type ResolveDocAccess = (
  docId: string,
  userId: string,
) => Promise<CollabDocAccessResult>;

export interface CollabAuthContext {
  userId: string;
  identityId?: string;
  authEpoch?: number;
  room: ParsedRoom;
  role: string;
  readOnly: boolean;
}

export interface CollabPolicyCheck {
  readonly localMode: AuthMode;
  readonly policy: EnterprisePolicyResponse;
  readonly qualify?: (input: { localUserId: string; identityId: string; authEpoch: number }) => Promise<boolean>;
}

export class CollabAuthError extends Error {
  readonly code: "UNAUTHORIZED" | "FORBIDDEN";

  constructor(code: "UNAUTHORIZED" | "FORBIDDEN", message: string) {
    super(message);
    this.name = "CollabAuthError";
    this.code = code;
  }
}

/** Deny-all authz (GC-07 default when no adapter is configured). */
export const denyAllDocAccess: ResolveDocAccess = async () => ({
  allow: false,
  readOnly: true,
  role: "anonymous",
  reason: "no_access",
});

/**
 * Dev/test helper: any authenticated ticket holder may edit.
 * Enable only via `MEGA_COLLAB_DEV_ALLOW_AUTHENTICATED=1`.
 */
export const allowAuthenticatedEditor: ResolveDocAccess = async () => ({
  allow: true,
  readOnly: false,
  role: "owner",
  reason: "editor",
});

export function createMapDocAccess(
  grants: Record<string, CollabDocAccessResult>,
): ResolveDocAccess {
  return async (docId) =>
    grants[docId] ?? {
      allow: false,
      readOnly: true,
      role: "none",
      reason: "no_access",
    };
}

/**
 * FSL-128: whether this collab process runs in Feishu mode, decided by
 * `resolveAuthMode` (FSL-116): `AUTH_MODE=enterprise` + `AUTH_PROVIDER=feishu`.
 *
 * In Feishu mode collab checks connections like `legacy` without a policy
 * bridge: the server never builds an enterprise policy bridge (even when
 * enterprise policy keys are set or one is injected) and passes no `policy` to
 * `authenticateCollabConnection`, so the ordinary collab ticket checks
 * (signature, expiry, room binding, document access) are the whole check and
 * no enterprise ticket fields are required. A combination `resolveAuthMode`
 * rejects (such as `legacy` + `feishu` or `enterprise` + `local`) throws its
 * `AuthModeError`, so the server refuses to start. Without `AUTH_PROVIDER` the
 * result is always `false` and the existing parsing is unchanged.
 */
export function isFeishuCollabMode(source: AuthModeSource): boolean {
  const resolved = resolveAuthMode(source);
  return resolved.mode === "enterprise" && resolved.provider === "feishu";
}

export function resolveTicketSecret(): string | null {
  return process.env.MEGA_COLLAB_INTERNAL_TOKEN?.trim() || null;
}

export async function authenticateCollabConnection(input: {
  documentName: string;
  token?: string | null;
  secret?: string | null;
  resolveDocAccess?: ResolveDocAccess;
  nowMs?: number;
  policy?: CollabPolicyCheck;
}): Promise<CollabAuthContext> {
  if (input.policy) {
    try {
      assertCollabPolicyCompatible(input.policy.localMode, input.policy.policy);
    } catch {
      throw new CollabAuthError("UNAUTHORIZED", "Enterprise policy is incompatible");
    }
  }
  const room = parseRoomName(input.documentName);
  if (!room) {
    throw new CollabAuthError("FORBIDDEN", `Unsupported room: ${input.documentName}`);
  }

  const secret = input.secret ?? resolveTicketSecret();
  if (!secret) {
    throw new CollabAuthError("UNAUTHORIZED", "Collab ticket secret is not configured");
  }

  const rawToken = input.token?.trim();
  if (!rawToken) {
    throw new CollabAuthError("UNAUTHORIZED", "Missing collab ticket");
  }

  const verified = verifyCollabTicket(rawToken, secret, { nowMs: input.nowMs });
  if (!verified) {
    throw new CollabAuthError("UNAUTHORIZED", "Invalid or expired collab ticket");
  }

  if (input.policy && input.policy.localMode !== "legacy") {
    if (!verified.identityId || verified.authEpoch === undefined ||
      verified.authEpoch !== input.policy.policy.policy_epoch || !input.policy.qualify) {
      throw new CollabAuthError("UNAUTHORIZED", "Enterprise collab ticket is stale");
    }
    let eligible: boolean;
    try {
      eligible = await input.policy.qualify({
        localUserId: verified.userId,
        identityId: verified.identityId,
        authEpoch: verified.authEpoch,
      });
    } catch {
      throw new CollabAuthError("UNAUTHORIZED", "Enterprise eligibility is unavailable");
    }
    if (!eligible) throw new CollabAuthError("UNAUTHORIZED", "Enterprise identity is not eligible");
  }

  switch (room.kind) {
    case "collection": {
      // DEV_ALLOW is never consulted here (ADR-RT-02 / DEBT-RT-02).
      if (verified.roomName !== room.documentName) {
        throw new CollabAuthError(
          "FORBIDDEN",
          `Ticket is not bound to ${room.documentName}`,
        );
      }
      return {
        userId: verified.userId,
        ...(verified.identityId ? { identityId: verified.identityId, authEpoch: verified.authEpoch } : {}),
        room,
        role: "member",
        readOnly: true,
      };
    }
    case "container": {
      const resolve = input.resolveDocAccess ?? denyAllDocAccess;
      const access = await resolve(room.containerId, verified.userId);
      if (!access.allow) {
        throw new CollabAuthError("FORBIDDEN", `No access to ${room.documentName}`);
      }
      return {
        userId: verified.userId,
        ...(verified.identityId ? { identityId: verified.identityId, authEpoch: verified.authEpoch } : {}),
        room,
        role: access.role,
        readOnly: access.readOnly,
      };
    }
    default: {
      const _exhaustive: never = room;
      throw new CollabAuthError("FORBIDDEN", `Unsupported room: ${input.documentName}`);
    }
  }
}
