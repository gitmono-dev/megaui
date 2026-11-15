// megaui:libs/mega/services/cls.ts@0ff3a9d (CURRENT_USER gate)
//
// EG-05's `cls.ts` established the fail-closed workspace-membership gate
// (GC-07) as a private closure-bound function. The EG-06 attachment modules
// (checks/deps/revisions/inline) live in separate files and need the same
// check, so it moves here as a standalone function taking `database`
// explicitly — single source of truth (GC-02), no duplicate copy per file.
import { eq } from "drizzle-orm";
import { user, type Database } from "@megaui/database";
import { MegaForbiddenError, MegaUnauthorizedError } from "../../errors";

/**
 * Fail-closed workspace-membership gate shared by every CL-domain mutation.
 * "Member" means the actor resolves to a live `user` row — same baseline as
 * EG-04 issues and EG-05 CLs (no dedicated CL collaborator matrix yet).
 */
export async function assertWorkspaceMember(
  database: Database,
  actorUserId: string | null | undefined,
): Promise<string> {
  const id = actorUserId?.trim();
  if (!id) throw new MegaUnauthorizedError("A signed-in session is required");
  const [row] = await database.select({ id: user.id }).from(user).where(eq(user.id, id)).limit(1);
  if (!row) throw new MegaForbiddenError("Only workspace members can perform this action");
  return id;
}
