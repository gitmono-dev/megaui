// megaui-only (FS-27): sticky activation for development/test rehearsals.
/** FS-27：ready-check + converted ledger + atomic enterprise activation. */
import type { PoolClient } from "pg";

import {
  activateEnterprise,
  readScopeExpectation,
  type EnterpriseScopeExpectation,
} from "@megaui/database";
import { parseDirectoryDepartmentIds } from "@megaui/core";

import {
  createApprovedMutationCapability,
  registerApprovedMutationHandler,
  type GuardedWriteContext,
  type VerbSchema,
} from "../../cli/admin-approval";
import { ApprovedMutationRejection } from "../../cli/admin-mutation";
import { trustedAdminEnv } from "../../cli/admin-env";
import { DIRECTORY_FRESHNESS_LIMIT_MS, isDirectoryFresh } from "./directory-sync";
import { scopeHashOf } from "./feishu/directory";
import {
  inspectActorReservationCoverage,
  readActorInventoryState,
} from "./actor-reservations";
import { createMigrationLedger, MigrationLedgerRejected } from "./migration-ledger";
import { MigrationInputError, validMigrationIdentifier } from "./manifest";

export const ACTIVATE_ADMIN_VERB = "activate";

export const activateAdminSchema: VerbSchema = Object.freeze({
  flags: Object.freeze({
    manifest: { kind: "file" as const, required: true },
    digest: { kind: "string" as const, required: true, emitSafe: true as const },
  }),
});

function rejectReadiness(): never {
  throw new ApprovedMutationRejection("MIGRATION_REJECTED");
}

function trustedActivationConfig(): {
  env: Record<string, string | undefined>;
  expectation: EnterpriseScopeExpectation;
  tenantKey: string;
  appId: string;
  departmentIds: readonly string[];
} {
  const env = trustedAdminEnv();
  const expectation = readScopeExpectation(env);
  const tenantKey = env.FEISHU_TENANT_KEY;
  const appId = env.FEISHU_APP_ID;
  if (!expectation || (expectation.processRole !== "admin" && expectation.processRole !== "test") ||
    !["development", "test"].includes(expectation.environment) ||
    !validMigrationIdentifier(expectation.instanceId) ||
    !validMigrationIdentifier(expectation.ownerFingerprint) ||
    !validMigrationIdentifier(tenantKey) || !validMigrationIdentifier(appId)) {
    throw new ApprovedMutationRejection("INVALID_CONFIG");
  }
  let departmentIds: readonly string[];
  try {
    departmentIds = parseDirectoryDepartmentIds(env.FEISHU_DIRECTORY_DEPARTMENT_IDS);
  } catch {
    throw new ApprovedMutationRejection("INVALID_CONFIG");
  }
  return { env, expectation, tenantKey, appId, departmentIds };
}

function parseCollabEpochs(raw: string | undefined): readonly number[] {
  if (typeof raw !== "string") rejectReadiness();
  const values = raw.split(",");
  if (values.length !== 2 || values.some((value) => !/^(0|[1-9][0-9]*)$/.test(value))) rejectReadiness();
  const epochs = values.map(Number);
  if (epochs.some((value) => !Number.isSafeInteger(value) || value < 0)) rejectReadiness();
  return epochs;
}

/**
 * Rechecks the non-migration part of FS-52 on the approved transaction's
 * connection. Migration poststate itself is checked by FS-61 immediately
 * afterwards, so activation cannot rely on a stale report file.
 */
async function assertCurrentReadiness(
  client: PoolClient,
  expectation: EnterpriseScopeExpectation,
  env: Record<string, string | undefined>,
  tenantKey: string,
  appId: string,
  departmentIds: readonly string[],
  now: Date,
): Promise<number> {
  const policy = await client.query<{
    scope: string;
    owner_fingerprint: string;
    environment: string;
    deployment_role: string;
    activation_state: string;
    auth_epoch: number;
  }>(
    `select scope,owner_fingerprint,environment,deployment_role,activation_state,auth_epoch
       from enterprise_policy
      where scope = $1`,
    [expectation.instanceId],
  );
  const marker = policy.rows[0];
  if (policy.rowCount !== 1 || !marker || marker.scope !== expectation.instanceId ||
    marker.owner_fingerprint !== expectation.ownerFingerprint || marker.environment !== expectation.environment ||
    marker.deployment_role !== expectation.environment || marker.activation_state !== "maintenance" ||
    !Number.isSafeInteger(marker.auth_epoch) || marker.auth_epoch < 0) rejectReadiness();

  if (env.ENTERPRISE_WORKER_READY !== "1") rejectReadiness();
  const collabEpochs = parseCollabEpochs(env.ENTERPRISE_COLLAB_POLICY_EPOCHS);
  if (collabEpochs.some((epoch) => epoch !== marker.auth_epoch)) rejectReadiness();

  const actorState = await readActorInventoryState(client, expectation.instanceId);
  if (!inspectActorReservationCoverage(actorState, { now }).complete) rejectReadiness();

  const scopeHash = scopeHashOf({ tenantKey, appId, departmentIds });
  const directory = await client.query<{
    watermark_generation: number | null;
    snapshot_generation: number | null;
    complete: boolean | null;
    observed_at: Date | null;
  }>(
    `select watermark.generation as watermark_generation,
            snapshot.generation as snapshot_generation,
            snapshot.complete,
            snapshot.observed_at
       from enterprise_directory_watermarks as watermark
       left join enterprise_directory_snapshots as snapshot
         on snapshot.scope_hash = watermark.scope_hash
        and snapshot.generation = watermark.generation
      where watermark.scope_hash = $1`,
    [scopeHash],
  );
  const row = directory.rows[0];
  const observedAt = row?.observed_at?.getTime() ?? Number.NaN;
  if (!row || row.watermark_generation === null || row.snapshot_generation !== row.watermark_generation ||
    row.complete !== true || !Number.isFinite(observedAt) || observedAt > now.getTime() ||
    now.getTime() - observedAt > DIRECTORY_FRESHNESS_LIMIT_MS || !isDirectoryFresh(observedAt, now.getTime())) {
    rejectReadiness();
  }
  return marker.auth_epoch;
}

/** Executes activation only after all current ready-check and ledger gates pass. */
export async function runActivationMutation(
  context: GuardedWriteContext,
  client: PoolClient,
): Promise<Record<string, number>> {
  if (context.verb !== ACTIVATE_ADMIN_VERB) {
    throw new ApprovedMutationRejection("INVALID_ARGUMENT");
  }
  const { env, expectation, tenantKey, appId, departmentIds } = trustedActivationConfig();
  const bytes = context.files.bytes("manifest");
  if (!bytes || typeof context.args.digest !== "string") {
    throw new ApprovedMutationRejection("INVALID_ARGUMENT");
  }
  const now = new Date();
  try {
    const epoch = await assertCurrentReadiness(client, expectation, env, tenantKey, appId, departmentIds, now);
    if (context.args["expect-policy-epoch"] !== epoch) rejectReadiness();
    const ledger = createMigrationLedger({ expectation, authority: { tenantKey, appId }, now: () => now });
    await ledger.assertConverted(context, client);
    const transition = await activateEnterprise(client, expectation.instanceId, now);
    return { activated: transition.changed ? 1 : 0, sessionsRevoked: transition.sessionsRevoked };
  } catch (error) {
    if (error instanceof ApprovedMutationRejection) throw error;
    if (error instanceof MigrationLedgerRejected || error instanceof MigrationInputError ||
      (error instanceof Error && error.message.startsWith("ACTIVATION_"))) {
      throw new ApprovedMutationRejection("MIGRATION_REJECTED");
    }
    throw error;
  }
}

export function registerActivationAdminVerb(): void {
  registerApprovedMutationHandler(
    ACTIVATE_ADMIN_VERB,
    createApprovedMutationCapability(activateAdminSchema, runActivationMutation),
  );
}
