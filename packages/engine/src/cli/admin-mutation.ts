// megaui-only (FS-81): approved admin write transactions have no upstream counterpart.
/**
 * FS-81：所有写 verb 都经过这个事务。
 *
 * scope、role、epoch CAS、业务写入和 operation 账本在同一事务提交。
 * 任一拒绝都回滚，账本里不会留下半笔操作。
 */
import { createHash } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import {
  assertEnterpriseScope,
  beginApprovedOperation,
  completeApprovedOperation,
  EnterpriseScopeError,
  readEnterpriseMarker,
  readScopeExpectation,
  readSqlRolePrivileges,
  targetFingerprint,
  validProvisionedRows,
  validAppliedRows,
  validAffectedRows,
  type ProvisionedRow,
  type AppliedRow,
  type AffectedRow,
} from "@megaui/database";

import { parseProvisionManifest, ProvisionInputError } from "../services/enterprise/provision-input";
import { parseMigrationManifestInput, MigrationInputError } from "../services/enterprise/manifest";
import { parseQuarantineManifest, parseRepairManifest, adminRepairDigest, boundedRepairConnectionString,
  AdminRepairInputError } from "../services/enterprise/admin-repair-input";

import { payloadDigest } from "./admin-payload";
import { trustedAdminEnv } from "./admin-env";
import {
  approvalPublicKey,
  checkApproval,
  parseApprovalBundle,
  verifyApprovalSignature,
  type ApprovalBundle,
  type ApprovalRejection,
} from "./admin-approval-verifier";

export interface GuardedWriteContext {
  readonly verb: string;
  readonly operationId: string;
  readonly args: Readonly<Record<string, string | number>>;
  readonly files: ApprovedFileSnapshot;
}

export interface ApprovedFileSnapshot {
  names(): readonly string[];
  bytes(name: string): Uint8Array | undefined;
}

export type ApprovedMutationFailure =
  | ApprovalRejection
  | ApprovedMutationRejectionKey
  | "SCOPE_REJECTED"
  | "INVALID_CONFIG"
  | "EPOCH_CAS_MISMATCH"
  | "OPERATION_PAYLOAD_MISMATCH"
  | "DEPENDENCY_FAILED";

type ApprovedMutationRejectionKey = "INVALID_ARGUMENT" | "INVALID_CONFIG" | "APPROVAL_DIGEST_MISMATCH" |
  "APPROVAL_MANIFEST_MISMATCH" | "ACTOR_SOURCE_REJECTED" | "PROVISION_REJECTED" | "MIGRATION_REJECTED" |
  "QUARANTINE_REJECTED" | "REPAIR_REJECTED";

export interface ProvisionMutationResult {
  resultCounts: Record<string, number>;
  provisioned: ProvisionedRow[];
}
export interface ApplyMutationResult { resultCounts: Record<string, number>; applied: AppliedRow[] }
export interface PrivateAuditMutationResult {
  resultCounts: Record<string, number>;
  affected: AffectedRow[];
  /** Internal repair guard; neither persisted, exposed nor run during replay. */
  validateBeforeCommit?: () => void | Promise<void>;
}
export type ApprovedMutationHandler = (context: GuardedWriteContext, client: PoolClient) =>
  Promise<Record<string, number> | ProvisionMutationResult | ApplyMutationResult | PrivateAuditMutationResult | void> |
    Record<string, number> | ProvisionMutationResult | ApplyMutationResult | PrivateAuditMutationResult | void;

/** A bounded business rejection; no input bytes or underlying exception reach CLI output. */
export class ApprovedMutationRejection extends Error {
  constructor(readonly key: ApprovedMutationRejectionKey) {
    super(key);
    this.name = "ApprovedMutationRejection";
  }
}

export interface ApprovedMutationSuccess {
  operationId: string;
  policyEpoch: number;
  resultCounts: Record<string, number>;
  replayed: boolean;
  provisioned?: ProvisionedRow[];
  applied?: AppliedRow[];
}

export async function runApprovedMutation(input: {
  bundle: ApprovalBundle | unknown;
  operationId: string;
  manifestDigest: string | null;
  expectedPolicyEpoch: number;
  context: GuardedWriteContext;
  handler: ApprovedMutationHandler;
  beforeCommit?: () => Promise<void> | void;
}): Promise<ApprovedMutationSuccess | ApprovedMutationFailure> {
  const trustedEnv = trustedAdminEnv();
  const databaseUrl = trustedEnv.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === "") return "DEPENDENCY_FAILED";
  const expectation = readScopeExpectation(trustedEnv);
  if (!expectation || (expectation.processRole !== "admin" && expectation.processRole !== "test")) {
    return "INVALID_CONFIG";
  }
  const publicKey = approvalPublicKey(trustedEnv.ENTERPRISE_APPROVAL_PUBLIC_KEY ?? "");
  if (typeof publicKey === "string") return publicKey;
  const bundle = parseApprovalBundle(input.bundle);
  if (typeof bundle === "string") return bundle;
  const context = copyWriteContext(input.context);
  const inputFiles = Object.create(null) as Record<string, string>;
  for (const name of context.files.names()) {
    const bytes = context.files.bytes(name);
    if (bytes === undefined) return "APPROVAL_DIGEST_MISMATCH";
    inputFiles[name] = createHash("sha256").update(bytes).digest("hex");
  }
  if (input.operationId !== context.operationId || context.args.target !== expectation.instanceId ||
    context.args["operation-id"] !== context.operationId ||
    context.args["expect-policy-epoch"] !== input.expectedPolicyEpoch) return "APPROVAL_DIGEST_MISMATCH";
  const approvedDigest = payloadDigest({
    verb: context.verb,
    targetFingerprint: targetFingerprint(expectation),
    deploymentRole: expectation.environment,
    operationId: context.operationId,
    expectedPolicyEpoch: input.expectedPolicyEpoch,
    args: context.args,
    inputFiles,
  });
  const decision = checkApproval(bundle, {
    verb: context.verb,
    targetFingerprint: targetFingerprint(expectation),
    deploymentRole: expectation.environment,
    operationId: context.operationId,
    expectedPolicyEpoch: input.expectedPolicyEpoch,
    manifestDigest: input.manifestDigest,
    payloadDigest: approvedDigest,
    now: new Date(),
  });
  if (typeof decision === "string") return decision;
  if (!verifyApprovalSignature(bundle, publicKey)) return "APPROVAL_SIGNATURE_INVALID";
  const matched = bundle.operations.filter(
    (operation) => operation.verb === context.verb && operation.operationId === context.operationId,
  );
  if (matched.length !== 1) return "APPROVAL_OPERATION_MISMATCH";
  if (matched[0]?.manifestDigest !== input.manifestDigest) return "APPROVAL_MANIFEST_MISMATCH";
  let provisionCount: number | undefined;
  let expectedApplied: AppliedRow[] | undefined;
  let expectedAffected: AffectedRow[] | undefined;
  let connectionString = databaseUrl;
  const isRepair = context.verb === "quarantine" || context.verb === "repair";
  if (isRepair) {
    try {
      const members = context.verb === "quarantine" ? parseQuarantineManifest(context.files.bytes("manifest")) :
        parseRepairManifest(context.files.bytes("manifest"));
      const digest = adminRepairDigest(members);
      if (digest !== input.manifestDigest || context.args.digest !== digest) return "APPROVAL_MANIFEST_MISMATCH";
      expectedAffected = members.map((member, index) => ({ row: index + 1, localUserId: member.local_user_id,
        expectedUserVersion: member.expected_user_version,
        expectedIdentityVersion: "expected_identity_version" in member ? member.expected_identity_version : null,
        expectedProfileDigest: "expected_profile_digest" in member ? member.expected_profile_digest : null,
        quarantineOperationId: "expected_quarantine_operation_id" in member ? member.expected_quarantine_operation_id : null }));
      connectionString = boundedRepairConnectionString(databaseUrl);
    } catch (error) { return error instanceof AdminRepairInputError ? error.key : "INVALID_ARGUMENT"; }
  }
  if (context.verb === "provision") {
    try { provisionCount = parseProvisionManifest(context.files.bytes("manifest")).length; }
    catch { return "INVALID_ARGUMENT"; }
    if (inputFiles.manifest !== input.manifestDigest || context.args.digest !== input.manifestDigest) {
      return "APPROVAL_DIGEST_MISMATCH";
    }
  }
  if (context.verb === "apply") {
    try {
      const members = parseMigrationManifestInput(context.files.bytes("manifest"));
      const batch = context.args["batch-number"];
      if (!Number.isSafeInteger(batch) || Number(batch) < 0 || Number(batch) >= Math.ceil(members.length / 100)) return "INVALID_ARGUMENT";
      const start = Number(batch) * 100;
      expectedApplied = members.slice(start, start + 100).map((member, index) => ({ row: start + index + 1, localUserId: member.local_user_id }));
      if (input.manifestDigest === null || context.args.digest !== input.manifestDigest) return "APPROVAL_DIGEST_MISMATCH";
    } catch { return "INVALID_ARGUMENT"; }
  }
  const pool = new Pool({ connectionString, ...(isRepair ? { max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000 } : {}) });
  pool.on("error", () => {});
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query(isRepair || ["provision", "apply"].includes(context.verb) ? "begin isolation level read committed" : "begin");
    if (isRepair) await client.query("select set_config(name,least(coalesce(nullif(setting::int,0),5000),5000)::text,true) " +
      "from pg_settings where name in ('statement_timeout','lock_timeout')");
    const queryable = client as unknown as Pool;
    const marker = await readEnterpriseMarker(queryable);
    const privileges = await readSqlRolePrivileges(queryable);
    assertEnterpriseScope({ marker, expectation, privileges });
    const ledger = await beginApprovedOperation(client, {
      scope: expectation.instanceId,
      operationId: context.operationId,
      expectedPolicyEpoch: input.expectedPolicyEpoch,
      payloadDigest: approvedDigest,
      verb: decision.verb,
      manifestDigest: decision.manifestDigest,
    });
    if (ledger.kind === "replay") {
      await client.query("rollback");
      if (context.verb === "provision" &&
        !validProvisionedRows(ledger.result.provisioned, ledger.result.resultCounts, provisionCount)) {
        return "OPERATION_PAYLOAD_MISMATCH";
      }
      if (context.verb === "apply" && !validAppliedRows(ledger.result.applied, ledger.result.resultCounts, expectedApplied)) {
        return "OPERATION_PAYLOAD_MISMATCH";
      }
      if ((context.verb === "quarantine" || context.verb === "repair") &&
        !validAffectedRows(ledger.result.affected, ledger.result.resultCounts, context.verb, expectedAffected)) {
        return "OPERATION_PAYLOAD_MISMATCH";
      }
      return {
        operationId: context.operationId,
        policyEpoch: ledger.result.policyEpoch,
        resultCounts: ledger.result.resultCounts,
        replayed: true,
        ...(ledger.result.provisioned ? { provisioned: ledger.result.provisioned } : {}),
        ...(ledger.result.applied ? { applied: ledger.result.applied } : {}),
      };
    }
    if (ledger.kind === "payload-mismatch" || ledger.kind === "invalid-operation") {
      await client.query("rollback");
      return "OPERATION_PAYLOAD_MISMATCH";
    }
    if (ledger.kind !== "ready") {
      await client.query("rollback");
      return ledger.kind === "missing-policy" ? "SCOPE_REJECTED" : "EPOCH_CAS_MISMATCH";
    }
    const handled = await input.handler(context, client);
    const { resultCounts, provisioned, applied, affected, validateBeforeCommit } = normalizeResult(context.verb, handled, provisionCount, expectedApplied, expectedAffected);
    const currentPolicy = await client.query<{ auth_epoch: number }>(
      `select auth_epoch from "enterprise_policy" where scope = $1`,
      [expectation.instanceId],
    );
    const policyEpoch = currentPolicy.rows[0]?.auth_epoch;
    if (policyEpoch === undefined) throw new Error("the policy disappeared during the transaction");
    assertResultCounts(resultCounts);
    const result = {
      policyEpoch,
      resultCounts,
      payloadDigest: approvedDigest,
      ...(provisioned ? { provisioned } : {}),
      ...(applied ? { applied } : {}),
      ...(affected ? { affected } : {}),
    };
    await completeApprovedOperation(client, {
      operationId: context.operationId,
      verb: decision.verb,
      manifestDigest: decision.manifestDigest,
      result,
    });
    await input.beforeCommit?.();
    await validateBeforeCommit?.();
    await client.query("commit");
    return { operationId: context.operationId, policyEpoch, resultCounts, replayed: false,
      ...(provisioned ? { provisioned } : {}), ...(applied ? { applied } : {}) };
  } catch (error) {
    try {
      await client?.query("rollback");
    } catch {
      // The transaction is already unusable.
    }
    if (error instanceof EnterpriseScopeError) return "SCOPE_REJECTED";
    if (error instanceof ProvisionInputError || error instanceof MigrationInputError) return "INVALID_ARGUMENT";
    if (error instanceof AdminRepairInputError) return error.key;
    if (error instanceof ApprovedMutationRejection &&
      ["INVALID_ARGUMENT", "INVALID_CONFIG", "APPROVAL_DIGEST_MISMATCH", "APPROVAL_MANIFEST_MISMATCH", "ACTOR_SOURCE_REJECTED", "PROVISION_REJECTED", "MIGRATION_REJECTED",
        "QUARANTINE_REJECTED", "REPAIR_REJECTED"].includes(error.key)) return error.key;
    return "DEPENDENCY_FAILED";
  } finally {
    client?.release();
    await pool.end();
  }
}

function copyWriteContext(context: GuardedWriteContext): GuardedWriteContext {
  const args = Object.create(null) as Record<string, string | number>;
  for (const key of Object.keys(context.args)) {
    const value = context.args[key];
    if (typeof value !== "string" && typeof value !== "number") throw new Error("unsupported argument");
    Object.defineProperty(args, key, { value, enumerable: true, configurable: false, writable: false });
  }
  const files = new Map<string, Uint8Array>();
  for (const name of context.files.names()) {
    const bytes = context.files.bytes(name);
    if (bytes === undefined) throw new Error("a file is missing from the snapshot");
    files.set(name, Uint8Array.from(bytes));
  }
  return {
    verb: context.verb,
    operationId: context.operationId,
    args: Object.freeze(args),
    files: Object.freeze({
      names: () => Object.freeze([...files.keys()]),
      bytes: (name: string) => {
        const found = files.get(name);
        return found ? Uint8Array.from(found) : undefined;
      },
    }),
  };
}

function assertResultCounts(counts: Record<string, number>): void {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) throw new Error("invalid result counts");
  for (const count of Object.values(counts)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid result counts");
  }
}

function normalizeResult(verb: string, value: unknown, expectedCount?: number, expectedApplied?: readonly AppliedRow[], expectedAffected?: readonly AffectedRow[]): {
  resultCounts: Record<string, number>; provisioned?: ProvisionedRow[]; applied?: AppliedRow[]; affected?: AffectedRow[];
  validateBeforeCommit?: () => void | Promise<void>;
} {
  if (value && typeof value === "object" &&
    ((verb !== "apply" && Object.hasOwn(value, "applied")) || (verb !== "provision" && Object.hasOwn(value, "provisioned")) ||
      (verb !== "quarantine" && verb !== "repair" && Object.hasOwn(value, "affected")) ||
      (verb !== "repair" && Object.hasOwn(value, "validateBeforeCommit")))) {
    throw new Error("invalid mutation result channel");
  }
  if (verb === "quarantine" || verb === "repair") {
    if (!value || typeof value !== "object" || !("affected" in value) || !("resultCounts" in value) ||
      !validAffectedRows(value.affected, value.resultCounts, verb, expectedAffected)) throw new Error("invalid private audit result");
    const hasGuard = Object.hasOwn(value, "validateBeforeCommit");
    const guard = "validateBeforeCommit" in value ? value.validateBeforeCommit : undefined;
    if (Object.keys(value).length !== (hasGuard ? 3 : 2) || (hasGuard && typeof guard !== "function")) {
      throw new Error("invalid private audit guard");
    }
    return { resultCounts: { [verb === "quarantine" ? "quarantined" : "repaired"]: value.affected.length },
      affected: value.affected.map(row => ({ ...row })),
      ...(hasGuard ? { validateBeforeCommit: guard as () => void | Promise<void> } : {}) };
  }
  if (verb === "apply") {
    if (!value || typeof value !== "object" || !("applied" in value) || !("resultCounts" in value) ||
      !validAppliedRows(value.applied, value.resultCounts, expectedApplied)) throw new Error("invalid apply result");
    return { resultCounts: { bound: value.applied.length },
      applied: value.applied.map(row => ({ row: row.row, localUserId: row.localUserId })) };
  }
  if (verb === "provision") {
    if (!value || typeof value !== "object" || !("provisioned" in value) || !("resultCounts" in value) ||
      !validProvisionedRows(value.provisioned, value.resultCounts, expectedCount)) throw new Error("invalid provision result");
    return { resultCounts: { created: value.provisioned.length },
      provisioned: value.provisioned.map(row => ({ row: row.row, localUserId: row.localUserId })) };
  }
  const counts = (value ?? {}) as Record<string, number>;
  assertResultCounts(counts);
  return { resultCounts: Object.freeze({ ...counts }) };
}
