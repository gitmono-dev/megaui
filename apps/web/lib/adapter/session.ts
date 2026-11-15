// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (resolveAclUserId)
//
// Diff vs upstream (GC-03 / WA-04):
// - Session resolution only; ACL checks stay in `@megaui/engine` services
//   (no route-layer `canRead` / `canWrite` duplication).
// - No mock-store `ensureMockWorkspaceUser` shim (DEBT-04).

import { resolveWebActor } from "@/lib/enterprise-session";

/** Resolve the qualified actor for engine ACL hooks. */
export async function resolveActorUserId(headers: Headers): Promise<string | null> {
  return (await resolveWebActor(headers))?.userId ?? null;
}
