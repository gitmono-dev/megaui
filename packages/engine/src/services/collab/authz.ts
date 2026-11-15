// megaui:libs/mega/services/collab-authz.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-13 task card):
// - Upstream's `collab-authz.ts` covers doc/channel/chat-message/inbox rooms
//   and an ADR-CE-11 "default open editor" fallback for any authenticated
//   user. Those non-doc container kinds and the open-editor default don't
//   exist in this repo yet (chat/channels land in EG-07..10 / WA-05, which
//   are out of scope for this card) — this port is doc-container-only and
//   reuses the EG-02 closed role×action matrix instead of an open default
//   (fail-closed by construction: no ACL row/role => no access, GC-07).
// - Takes `Pick<AclService, "resolveDocRole">` rather than the full service
//   so tests can inject a minimal fake without wiring the ACL DB layer.
import { evaluateAcl, type AclRole, type AclService } from "../acl";
import { MegaForbiddenError, MegaUnauthorizedError } from "../../errors";

export type CollabDocAccessReason =
  | "unauthenticated"
  | "no_access"
  | "read_only"
  | "editor";

export interface CollabDocAccessResult {
  /** May join the doc room at all (read access). */
  allow: boolean;
  /** Allowed to join but not to write (viewer/no write permission). */
  readOnly: boolean;
  role: AclRole;
  reason: CollabDocAccessReason;
}

function toAccessResult(
  role: AclRole,
  canRead: boolean,
  canWrite: boolean,
): CollabDocAccessResult {
  if (!canRead) {
    return {
      allow: false,
      readOnly: true,
      role,
      reason: role === "anonymous" ? "unauthenticated" : "no_access",
    };
  }
  if (!canWrite) {
    return { allow: true, readOnly: true, role, reason: "read_only" };
  }
  return { allow: true, readOnly: false, role, reason: "editor" };
}

export function createCollabAuthzService(
  acl: Pick<AclService, "resolveDocRole">,
) {
  async function resolveDocAccess(
    docId: string,
    userId: string | null | undefined,
  ): Promise<CollabDocAccessResult> {
    const role = await acl.resolveDocRole(docId, userId);
    const canRead = evaluateAcl(role, "read").allow;
    const canWrite = evaluateAcl(role, "write").allow;
    return toAccessResult(role, canRead, canWrite);
  }

  /** Fail-closed room-join gate: no read access => reject before ever opening the room. */
  async function assertCanJoin(
    docId: string,
    userId: string | null | undefined,
  ): Promise<CollabDocAccessResult> {
    const access = await resolveDocAccess(docId, userId);
    if (access.allow) return access;
    if (access.reason === "unauthenticated") {
      throw new MegaUnauthorizedError(
        "A signed-in session is required to join this collab room",
      );
    }
    throw new MegaForbiddenError("Collab room access denied");
  }

  /**
   * Fail-closed write gate (EG-13 AC2): a validly minted collab ticket only
   * proves identity — this asserts per-document write permission
   * independently, so a read-only collaborator's writes are still denied.
   */
  async function assertCanWrite(
    docId: string,
    userId: string | null | undefined,
  ): Promise<CollabDocAccessResult> {
    const access = await assertCanJoin(docId, userId);
    if (access.readOnly) {
      throw new MegaForbiddenError(
        "Collab room write denied (read-only access)",
      );
    }
    return access;
  }

  return { resolveDocAccess, assertCanJoin, assertCanWrite };
}

export type CollabAuthzService = ReturnType<typeof createCollabAuthzService>;
