// megaui-only (FS-05): approved member provisioning; no legacy account merge.
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { createProvisionedIdentity, recordProvisionCheckpoint } from "@megaui/database";
import { createApprovedMutationCapability, registerApprovedMutationHandler, type GuardedWriteContext } from "../../cli/admin-approval";
import { ApprovedMutationRejection, type ProvisionMutationResult } from "../../cli/admin-mutation";
import { trustedAdminProviderConfiguration } from "./admin-provider";
import { parseProvisionManifest } from "./provision-input";
import { compatibilityEmail } from "./identity-key";
import { ActorClaimRejected, createActorClaimService } from "./actor-claim";
import { createPostgresAuthenticationEligibilityReader } from "./eligibility";
import { FeishuTransport } from "./feishu/http";
import { FeishuTokenManager } from "./feishu/token";
import { SingleMemberDirectoryReader } from "./feishu/directory";

async function runProvisionMutation(context: GuardedWriteContext, client: PoolClient): Promise<ProvisionMutationResult> {
  if (context.verb !== "provision") throw new ApprovedMutationRejection("INVALID_ARGUMENT");
  const bytes = context.files.bytes("manifest");
  const members = parseProvisionManifest(bytes);
  const digest = createHash("sha256").update(bytes!).digest("hex");
  if (digest !== context.args.digest) throw new ApprovedMutationRejection("APPROVAL_DIGEST_MISMATCH");
  const config = trustedAdminProviderConfiguration();
  if (context.args.target !== config.scope || config.mode !== "enterprise") {
    throw new ApprovedMutationRejection("PROVISION_REJECTED");
  }
  if (members.some(member => member.tenantKey !== config.tenantKey || member.appId !== config.appId)) {
    throw new ApprovedMutationRejection("INVALID_ARGUMENT");
  }
  const transport = new FeishuTransport({ target: config.target });
  const tokens = new FeishuTokenManager({ transport });
  const directoryReader = new SingleMemberDirectoryReader({
    transport, credentials: { tenantKey: config.tenantKey, appId: config.appId, appSecret: config.appSecret },
    getToken: credentials => tokens.getToken(credentials),
  });
  const requests = members.map(member => ({ localUserId: randomUUID(), openId: member.openId, loginName: member.loginName }));
  const details = new Map<string, (typeof members)[number]>(requests.map((request, index) => [request.localUserId, members[index]!]));
  const claims = createActorClaimService({
    eligibility: {
      policyScope: config.scope, authMode: config.mode,
      directoryScope: { tenantKey: config.tenantKey, appId: config.appId, departmentIds: config.departmentIds },
      directoryReader, databaseReader: createPostgresAuthenticationEligibilityReader(client),
    },
    async createSubject(transaction, input) {
      const member = details.get(input.localUserId);
      if (!member) throw new ApprovedMutationRejection("PROVISION_REJECTED");
      await createProvisionedIdentity(transaction, {
        ...input, identityId: randomUUID(), displayName: member.displayName,
        compatibilityEmail: compatibilityEmail(input.localUserId), notificationEmail: member.notificationEmail,
      });
    },
  });
  try {
    const results = await claims.provisionBatch(client, requests);
    // No provider I/O or creation callbacks after FS-71's one final barrier.
    await recordProvisionCheckpoint(client, { operationId: context.operationId, manifestDigest: digest, processed: results.length });
    return { resultCounts: { created: results.length },
      provisioned: results.map((result, index) => ({ row: index + 1, localUserId: result.localUserId })) };
  } catch (error) {
    if (error instanceof ActorClaimRejected || (typeof error === "object" && error !== null &&
      "code" in error && error.code === "23505" && "constraint" in error &&
      ["enterprise_identity_tenant_app_open_uidx", "enterprise_profile_tenant_login_name_uidx",
        "enterprise_profile_backend_username_uidx"].includes(String(error.constraint)))) {
      throw new ApprovedMutationRejection("PROVISION_REJECTED");
    }
    throw error;
  }
}

export function registerProvisionAdminVerb(): void {
  registerApprovedMutationHandler("provision", createApprovedMutationCapability({
    flags: { manifest: { kind: "file", required: true }, digest: { kind: "string", required: true, emitSafe: true } },
  }, runProvisionMutation));
}
