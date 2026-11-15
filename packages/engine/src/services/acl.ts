// megaui:libs/mega/services/acl.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-02 task card):
// - No CASL. A closed role×action matrix owns allow/deny (card AC + GC-07).
// - Workspace docs default to signed-in read/write access. Anonymous actors stay
//   denied; an explicit collaborator row can narrow access and ownership manages.
// - No `MEGA_DOCS_DATA_BACKEND=mock` / store.ts branch (DEBT-04).
// - Doc author is treated as owner even without a collaborator row.
import { and, eq } from "drizzle-orm";
import {
  megaDocCollaboratorRoles,
  megaDocCollaborators,
  megaDocs,
  type Database,
} from "@megaui/database";
import { MegaForbiddenError, MegaNotFoundError, MegaUnauthorizedError } from "../errors";

export type AclRole = "anonymous" | "none" | "member" | "admin" | "owner";
export type AclAction = "read" | "write" | "manage";

export type AclDecision = {
  allow: boolean;
  role: AclRole;
  action: AclAction;
};

const ALLOW: Record<AclRole, Record<AclAction, boolean>> = {
  anonymous: { read: false, write: false, manage: false },
  none: { read: false, write: false, manage: false },
  member: { read: true, write: false, manage: false },
  admin: { read: true, write: true, manage: false },
  owner: { read: true, write: true, manage: true },
};

/** Pure evaluator — the EG-02 truth table. */
export function evaluateAcl(role: AclRole, action: AclAction): AclDecision {
  return { allow: ALLOW[role][action], role, action };
}

export function collaboratorRoleToAclRole(
  role: string | null | undefined,
): Exclude<AclRole, "anonymous"> {
  if (role === megaDocCollaboratorRoles.OWNER) return "owner";
  if (role === megaDocCollaboratorRoles.EDITOR) return "admin";
  if (role === megaDocCollaboratorRoles.VIEWER) return "member";
  return "none";
}

export function createAclService(database: Database) {
  async function resolveDocRole(
    docId: string,
    userId: string | null | undefined,
  ): Promise<AclRole> {
    if (!userId?.trim()) return "anonymous";

    const [doc] = await database
      .select({ id: megaDocs.id, authorId: megaDocs.authorId })
      .from(megaDocs)
      .where(eq(megaDocs.id, docId))
      .limit(1);
    if (!doc) throw new MegaNotFoundError("Document", docId);
    if (doc.authorId === userId) return "owner";

    const [row] = await database
      .select({ role: megaDocCollaborators.role })
      .from(megaDocCollaborators)
      .where(
        and(
          eq(megaDocCollaborators.docId, docId),
          eq(megaDocCollaborators.userId, userId),
        ),
      )
      .limit(1);
    if (!row) return "admin";
    return collaboratorRoleToAclRole(row.role);
  }

  async function decide(
    docId: string,
    userId: string | null | undefined,
    action: AclAction,
  ): Promise<AclDecision> {
    const role = await resolveDocRole(docId, userId);
    return evaluateAcl(role, action);
  }

  async function assert(
    docId: string,
    userId: string | null | undefined,
    action: AclAction,
  ): Promise<void> {
    const decision = await decide(docId, userId, action);
    if (decision.allow) return;
    if (decision.role === "anonymous") {
      throw new MegaUnauthorizedError("A signed-in session is required");
    }
    throw new MegaForbiddenError(`Document ${action} denied`);
  }

  return {
    resolveDocRole,
    decide,
    assert,
    canRead: (docId: string, userId: string | null | undefined) =>
      decide(docId, userId, "read"),
    canWrite: (docId: string, userId: string | null | undefined) =>
      decide(docId, userId, "write"),
    canManage: (docId: string, userId: string | null | undefined) =>
      decide(docId, userId, "manage"),
  };
}

export type AclService = ReturnType<typeof createAclService>;
