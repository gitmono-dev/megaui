// megaui-only (FS-38): approved isolation and repair preserve historical subjects.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { lockEnterpriseRepairSources, readCurrentQuarantines, lockRepairDirectorySnapshot,
  quarantineEnterpriseUser, repairEnterpriseUser, EnterpriseRepairStoreRejected, recordMigrationCheckpoint } from "@megaui/database";
import { createApprovedMutationCapability, registerApprovedMutationHandler, type GuardedWriteContext } from "../../cli/admin-approval";
import { ApprovedMutationRejection, type PrivateAuditMutationResult } from "../../cli/admin-mutation";
import { parseQuarantineManifest, parseRepairManifest, adminRepairDigest, type QuarantineMember, type RepairMember } from "./admin-repair-input";
import { readMigrationUserSources, readMigrationSources } from "./migration-preview";
import { migrationUserVersion, migrationProfileDigest, MigrationSourceError } from "./manifest";
import { trustedAdminProviderConfiguration } from "./admin-provider";
import { createActorClaimService } from "./actor-claim";
import { inspectActorReservationCoverage } from "./actor-reservations";
import { createEnterpriseEligibilityService, createPostgresAuthenticationEligibilityReader } from "./eligibility";
import { DIRECTORY_FRESHNESS_LIMIT_MS } from "./directory-sync";
import { FeishuTransport } from "./feishu/http";
import { FeishuTokenManager } from "./feishu/token";
import { SingleMemberDirectoryReader, scopeHashOf } from "./feishu/directory";

function audit(members: readonly QuarantineMember[] | readonly RepairMember[]): PrivateAuditMutationResult["affected"] {
  return members.map((member, index) => ({ row: index + 1, localUserId: member.local_user_id,
    expectedUserVersion: member.expected_user_version,
    expectedIdentityVersion: "expected_identity_version" in member ? member.expected_identity_version : null,
    expectedProfileDigest: "expected_profile_digest" in member ? member.expected_profile_digest : null,
    quarantineOperationId: "expected_quarantine_operation_id" in member ? member.expected_quarantine_operation_id : null }));
}

function requireFreshSnapshot(snapshot: Awaited<ReturnType<typeof lockRepairDirectorySnapshot>>): void {
  const observed = snapshot?.observedAt instanceof Date ? snapshot.observedAt.getTime() : NaN, age = Date.now() - observed;
  if (!snapshot || !snapshot.complete || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1 ||
    !Number.isFinite(observed) || age < 0 || age > DIRECTORY_FRESHNESS_LIMIT_MS) throw new ApprovedMutationRejection("REPAIR_REJECTED");
}

async function repair(client: PoolClient, context: GuardedWriteContext, members: readonly RepairMember[]): Promise<() => void> {
  const config = trustedAdminProviderConfiguration();
  if (context.args.target !== config.scope || members.some(row => row.tenant_key !== config.tenantKey || row.app_id !== config.appId)) {
    throw new ApprovedMutationRejection("REPAIR_REJECTED");
  }
  const transport = new FeishuTransport({ target: config.target }), tokens = new FeishuTokenManager({ transport });
  const directoryReader = new SingleMemberDirectoryReader({ transport,
    credentials: { tenantKey: config.tenantKey, appId: config.appId, appSecret: config.appSecret },
    getToken: credentials => tokens.getToken(credentials) });
  const options = { policyScope: config.scope, authMode: config.mode,
    directoryScope: { tenantKey: config.tenantKey, appId: config.appId, departmentIds: config.departmentIds },
    directoryReader, databaseReader: createPostgresAuthenticationEligibilityReader(client) };
  const eligibility = createEnterpriseEligibilityService(options);
  for (const member of members) if (!await eligibility.directoryAdmission(member.open_id)) throw new ApprovedMutationRejection("REPAIR_REJECTED");
  await lockEnterpriseRepairSources(client, config.scope, true);
  const snapshot = await lockRepairDirectorySnapshot(client, scopeHashOf(options.directoryScope));
  requireFreshSnapshot(snapshot);
  const claims = createActorClaimService({ eligibility: options, async createSubject() { throw new Error("repair cannot create a subject"); } });
  const owners = await claims.existingOwners(client, members.map(row => row.local_user_id));
  if (!owners) throw new ApprovedMutationRejection("REPAIR_REJECTED");
  const sources = await readMigrationSources(client, members, config.scope, { tenantKey: config.tenantKey, appId: config.appId });
  const quarantines = await readCurrentQuarantines(client, members.map(row => row.local_user_id));
  // Validate the entire batch before the first write. Occupied bindings cannot be swapped within a batch.
  const writes = members.map((member, index) => {
    const user = sources.users.find(row => row.id === member.local_user_id), owner = owners[index];
    const identities = sources.identities.filter(row => row.local_user_id === member.local_user_id), identity = identities[0];
    const profile = sources.profiles.find(row => row.user_id === member.local_user_id);
    const quarantine = quarantines.find(row => row.user_id === member.local_user_id);
    if (!user || !owner || owner.localUserId !== member.local_user_id || !owner.quarantined ||
      migrationUserVersion(user) !== member.expected_user_version || migrationProfileDigest(profile ?? null) !== member.expected_profile_digest ||
      quarantine?.state !== "quarantined" || quarantine.operation_id !== member.expected_quarantine_operation_id ||
      identities.length > 1 || (identity?.identity_version ?? 0) !== member.expected_identity_version ||
      (identity && (identity.tenant_key !== config.tenantKey || identity.app_id !== config.appId || identity.identity_version >= 2147483647)) ||
      (profile && (profile.tenant_key !== config.tenantKey || profile.backend_username !== owner.backendUsername)) ||
      sources.identities.some(row => row.tenant_key === config.tenantKey && row.app_id === config.appId &&
        row.open_id === member.open_id && row.local_user_id !== member.local_user_id) ||
      sources.profiles.some(row => row.tenant_key === config.tenantKey && row.login_name === member.login_name && row.user_id !== member.local_user_id)) {
      throw new ApprovedMutationRejection("REPAIR_REJECTED");
    }
    return { localUserId: member.local_user_id, identityId: identity?.id ?? randomUUID(), identityExists: identity !== undefined,
      expectedIdentityVersion: member.expected_identity_version, tenantKey: config.tenantKey, appId: config.appId,
      openId: member.open_id, loginName: member.login_name, backendUsername: owner.backendUsername,
      profileExists: profile !== undefined, displayName: user.name, quarantineOperationId: member.expected_quarantine_operation_id };
  });
  for (const input of writes) await repairEnterpriseUser(client, input);
  // The protected pre-write inventory is still the source of authority for this
  // approved local delta. Recheck its age without resealing or rereading it.
  return () => {
    requireFreshSnapshot(snapshot);
    if (!inspectActorReservationCoverage(sources.actorState, { now: new Date() }).complete) throw new ApprovedMutationRejection("REPAIR_REJECTED");
  };
}

async function runRepairMutation(context: GuardedWriteContext, client: PoolClient): Promise<PrivateAuditMutationResult> {
  if (context.verb !== "quarantine" && context.verb !== "repair") throw new ApprovedMutationRejection("INVALID_ARGUMENT");
  const rejected = context.verb === "quarantine" ? "QUARANTINE_REJECTED" : "REPAIR_REJECTED";
  const members = context.verb === "quarantine" ? parseQuarantineManifest(context.files.bytes("manifest")) : parseRepairManifest(context.files.bytes("manifest"));
  const digest = adminRepairDigest(members);
  if (digest !== context.args.digest) throw new ApprovedMutationRejection("APPROVAL_MANIFEST_MISMATCH");
  try {
    let recheckFreshness: (() => void) | undefined;
    if (context.verb === "quarantine") {
      await lockEnterpriseRepairSources(client, String(context.args.target), false);
      const users = await readMigrationUserSources(client, members.map(row => row.local_user_id));
      for (const member of members) {
        const user = users.find(row => row.id === member.local_user_id);
        if (!user || migrationUserVersion(user) !== member.expected_user_version) throw new ApprovedMutationRejection(rejected);
      }
      for (const member of members as readonly QuarantineMember[]) await quarantineEnterpriseUser(client, {
        localUserId: member.local_user_id, reason: member.reason, operationId: context.operationId, manifestDigest: digest });
    } else recheckFreshness = await repair(client, context, members as readonly RepairMember[]);
    await recordMigrationCheckpoint(client, { operationId: context.operationId, manifestDigest: digest, batchNumber: 0, processed: members.length });
    recheckFreshness?.();
    return { resultCounts: { [context.verb === "quarantine" ? "quarantined" : "repaired"]: members.length }, affected: audit(members),
      ...(recheckFreshness ? { validateBeforeCommit: recheckFreshness } : {}) };
  } catch (error) {
    if (error instanceof EnterpriseRepairStoreRejected || error instanceof MigrationSourceError ||
      (typeof error === "object" && error !== null && "code" in error && error.code === "23505" && "constraint" in error &&
        ["enterprise_identity_tenant_app_open_uidx", "enterprise_profile_tenant_login_name_uidx", "enterprise_profile_backend_username_uidx"].includes(String(error.constraint)))) {
      throw new ApprovedMutationRejection(rejected);
    }
    throw error;
  }
}

export function registerQuarantineAdminVerb(): void {
  registerApprovedMutationHandler("quarantine", createApprovedMutationCapability({ emitDigest: "canonical-manifest", flags: {
    manifest: { kind: "file", required: true }, digest: { kind: "string", required: true, emitSafe: true },
  } }, runRepairMutation));
}
export function registerRepairAdminVerb(): void {
  registerApprovedMutationHandler("repair", createApprovedMutationCapability({ flags: {
    manifest: { kind: "file", required: true }, digest: { kind: "string", required: true, emitSafe: true },
  } }, runRepairMutation));
}
