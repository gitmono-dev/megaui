// megaui-only (FS-53): maintenance-window compatibility-key conversion.
import type { PoolClient } from "pg";

import { readScopeExpectation } from "@megaui/database";

import {
  createApprovedMutationCapability,
  registerApprovedMutationHandler,
  type GuardedWriteContext,
} from "../../cli/admin-approval";
import { ApprovedMutationRejection } from "../../cli/admin-mutation";
import { trustedAdminEnv } from "../../cli/admin-env";
import { compatibilityEmail } from "./identity-key";
import { createMigrationLedger, MigrationLedgerRejected } from "./migration-ledger";
import { MigrationInputError, parseMigrationManifest, validMigrationIdentifier } from "./manifest";

function trustedConversionAuthority() {
  const env = trustedAdminEnv();
  const expectation = readScopeExpectation(env);
  const tenantKey = env.FEISHU_TENANT_KEY;
  const appId = env.FEISHU_APP_ID;
  if (!expectation || (expectation.processRole !== "admin" && expectation.processRole !== "test") ||
    typeof tenantKey !== "string" || typeof appId !== "string" ||
    ![expectation.instanceId, expectation.ownerFingerprint, expectation.environment, tenantKey, appId]
      .every(validMigrationIdentifier)) {
    throw new ApprovedMutationRejection("INVALID_CONFIG");
  }
  return { expectation, authority: { tenantKey, appId } };
}

/** Converts one approved migration batch; the ledger owns phase/epoch/source guards. */
export async function runConversionMutation(context: GuardedWriteContext, client: PoolClient): Promise<Record<string, number>> {
  if (context.verb !== "convert") throw new ApprovedMutationRejection("INVALID_ARGUMENT");
  const { expectation, authority } = trustedConversionAuthority();
  const bytes = context.files.bytes("manifest");
  const batch = context.args["batch-number"];
  if (!bytes || !Number.isSafeInteger(batch) || Number(batch) < 0) {
    throw new ApprovedMutationRejection("INVALID_ARGUMENT");
  }
  const members = parseMigrationManifest(bytes, authority);
  if (Number(batch) >= Math.ceil(members.length / 100)) throw new ApprovedMutationRejection("INVALID_ARGUMENT");
  const ledger = createMigrationLedger({ expectation, authority });
  try {
    const result = await ledger.executeBatch(context, client, async (transaction, selected) => {
      for (const member of selected) {
        await transaction.query(
          'update enterprise_profile p set notification_email=coalesce(p.notification_email,u.email),updated_at=now() ' +
            'from "user" u where p.user_id=$1 and u.id=$1 and u.email<>$2',
          [member.local_user_id, compatibilityEmail(member.local_user_id)],
        );
        await transaction.query(
          'update "user" set email=$2,email_verified=false,updated_at=now() where id=$1',
          [member.local_user_id, compatibilityEmail(member.local_user_id)],
        );
      }
    });
    return { processed: result.processed };
  } catch (error) {
    if (error instanceof MigrationLedgerRejected || error instanceof MigrationInputError) {
      throw new ApprovedMutationRejection("MIGRATION_REJECTED");
    }
    throw error;
  }
}

export function registerMigrationConvertAdminVerb(): void {
  registerApprovedMutationHandler("convert", createApprovedMutationCapability({ flags: {
    manifest: { kind: "file", required: true },
    digest: { kind: "string", required: true, emitSafe: true },
    "batch-number": { kind: "integer", required: true, emitSafe: true },
  } }, runConversionMutation));
}
