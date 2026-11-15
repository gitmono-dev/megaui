// megaui-only (FS-06): approved historical prebinding preserves users and sessions.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { bindHistoricalIdentity } from "@megaui/database";
import { createApprovedMutationCapability, registerApprovedMutationHandler, type GuardedWriteContext } from "../../cli/admin-approval";
import { ApprovedMutationRejection, type ApplyMutationResult } from "../../cli/admin-mutation";
import { trustedAdminProviderConfiguration } from "./admin-provider";
import { createEnterpriseEligibilityService, createPostgresAuthenticationEligibilityReader } from "./eligibility";
import { FeishuTransport } from "./feishu/http";
import { FeishuTokenManager } from "./feishu/token";
import { SingleMemberDirectoryReader } from "./feishu/directory";
import { parseMigrationManifest, MigrationSourceError } from "./manifest";
import { createMigrationLedger, MigrationLedgerRejected } from "./migration-ledger";

async function runApplyMutation(context: GuardedWriteContext, client: PoolClient): Promise<ApplyMutationResult> {
  if (context.verb !== "apply") throw new ApprovedMutationRejection("INVALID_ARGUMENT");
  const config = trustedAdminProviderConfiguration();
  if (context.args.target !== config.scope) throw new ApprovedMutationRejection("MIGRATION_REJECTED");
  const bytes = context.files.bytes("manifest"), batch = context.args["batch-number"];
  if (!bytes) throw new ApprovedMutationRejection("INVALID_ARGUMENT");
  const members = parseMigrationManifest(bytes, config);
  if (!Number.isSafeInteger(batch) || Number(batch) < 0 || Number(batch) >= Math.ceil(members.length / 100)) {
    throw new ApprovedMutationRejection("INVALID_ARGUMENT");
  }
  const start = Number(batch) * 100;
  const transport = new FeishuTransport({ target: config.target });
  const tokens = new FeishuTokenManager({ transport });
  const directoryReader = new SingleMemberDirectoryReader({ transport,
    credentials: { tenantKey: config.tenantKey, appId: config.appId, appSecret: config.appSecret },
    getToken: credentials => tokens.getToken(credentials) });
  const eligibility = createEnterpriseEligibilityService({ policyScope: config.scope, authMode: config.mode,
    directoryScope: { tenantKey: config.tenantKey, appId: config.appId, departmentIds: config.departmentIds },
    directoryReader, databaseReader: createPostgresAuthenticationEligibilityReader(client) });
  // Prebinding has no local identity yet. Directory admission is the applicable port,
  // and all provider I/O completes before the ledger's source barrier.
  for (const member of members.slice(start, start + 100)) {
    if (!await eligibility.directoryAdmission(member.open_id)) throw new ApprovedMutationRejection("MIGRATION_REJECTED");
  }
  try {
    const ledger = createMigrationLedger({ expectation: config.expectation,
      authority: { tenantKey: config.tenantKey, appId: config.appId } });
    const result = await ledger.executeBatch(context, client, async (transaction, selected) => {
      for (const member of selected) await bindHistoricalIdentity(transaction, {
        localUserId: member.local_user_id, identityId: randomUUID(), tenantKey: config.tenantKey,
        appId: config.appId, openId: member.open_id, loginName: member.login_name, backendUsername: member.backend_username,
      });
    });
    return { resultCounts: { bound: result.processed },
      applied: result.localUserIds.map((localUserId, index) => ({ row: start + index + 1, localUserId })) };
  } catch (error) {
    if (error instanceof MigrationLedgerRejected || error instanceof MigrationSourceError ||
      (error instanceof Error && error.message === "MIGRATION_INVENTORY_REJECTED" && !("code" in error))) {
      throw new ApprovedMutationRejection("MIGRATION_REJECTED");
    }
    throw error;
  }
}

export function registerMigrationApplyAdminVerb(): void {
  registerApprovedMutationHandler("apply", createApprovedMutationCapability({ flags: {
    manifest: { kind: "file", required: true }, digest: { kind: "string", required: true, emitSafe: true },
    "batch-number": { kind: "integer", required: true, emitSafe: true },
  } }, runApplyMutation));
}
