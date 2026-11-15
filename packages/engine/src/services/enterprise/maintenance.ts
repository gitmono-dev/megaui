// megaui-only (FS-79): persistent maintenance command has no upstream counterpart.
/** FS-79：受审批保护的 maintenance 管理命令。 */
import type { PoolClient } from "pg";

import { enterEnterpriseMaintenance } from "@megaui/database";

import {
  createApprovedMutationCapability,
  registerApprovedMutationHandler,
  type GuardedWriteContext,
  type VerbSchema,
} from "../../cli/admin-approval";

export const MAINTENANCE_ADMIN_VERB = "maintenance";

/** Maintenance has no behaviour flags: target, operation id, and epoch are common signed flags. */
export const maintenanceAdminSchema: VerbSchema = Object.freeze({
  flags: Object.freeze({}),
});

/** Executes only inside FS-81's runApprovedMutation transaction. */
export async function runMaintenanceMutation(
  context: GuardedWriteContext,
  client: PoolClient,
): Promise<Record<string, number>> {
  if (context.verb !== MAINTENANCE_ADMIN_VERB) {
    throw new Error("[@megaui/engine] maintenance handler received a different verb.");
  }
  const scope = context.args.target;
  if (typeof scope !== "string" || scope.trim() === "") {
    throw new Error("[@megaui/engine] maintenance handler requires the signed target scope.");
  }
  const transition = await enterEnterpriseMaintenance(client, scope);
  return { policyTransitions: transition.changed ? 1 : 0 };
}

/**
 * The CLI dispatch may register this verb only through the existing complete
 * approval + scope guard. dispatchPinnedVerb then owns its runApprovedMutation
 * call; this module never opens a pool or invokes the handler directly.
 */
export function registerMaintenanceAdminVerb(): void {
  registerApprovedMutationHandler(
    MAINTENANCE_ADMIN_VERB,
    createApprovedMutationCapability(maintenanceAdminSchema, runMaintenanceMutation),
  );
}
