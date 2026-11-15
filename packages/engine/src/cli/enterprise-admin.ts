// megaui-only (FS-80): enterprise admin CLI has no upstream counterpart.
// FS-80: enterprise admin CLI assembly.
//
// Common arguments are validated before any write handler runs. The process
// reads the approval public key only from its own environment, opens the
// target database read-only to apply the FS-44 scope guard, and never logs
// the bundle, key, or file bytes.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { readScopeExpectation, targetFingerprint, type EnterpriseScopeExpectation } from "@megaui/database";
import { Pool, type PoolClient } from "pg";
import { readEnterpriseMarker, assertEnterpriseScope, readSqlRolePrivileges, EnterpriseScopeError } from "@megaui/database";
import { parseDirectoryDepartmentIds } from "@megaui/core";

import {
  adminErrorExitCode,
  adminFilesystemErrorKey,
  adminSuccessJson,
  approvalRequestJson,
  approvalRequestSchema,
  type ApprovalRequest,
} from "./admin-output";

import {
  approvalPublicKey,
  checkApproval,
  dispatchPinnedVerb,
  pinRegisteredVerb,
  registeredApprovedMutationVerbs,
  registeredGuardedWriteVerbs,
  sealRegisteredWriteHandlers,
  parseApprovalBundle,
  readApprovalSignature,
  verifyApprovalSignature,
  type ApprovedFileSnapshot,
  type VerbSchema,
} from "./admin-approval";
import { canonicalizeJson, payloadDigest, type PayloadDigestInput } from "./admin-payload";
import { registerMaintenanceAdminVerb } from "../services/enterprise/maintenance";
import { registerActorReservationAdminVerb } from "../services/enterprise/actor-reservations";
import { registerProvisionAdminVerb } from "../services/enterprise/identity";
import { registerMigrationApplyAdminVerb } from "../services/enterprise/migration";
import { registerMigrationConvertAdminVerb } from "../services/enterprise/conversion";
import { registerActivationAdminVerb } from "../services/enterprise/cutover";
import { registerQuarantineAdminVerb, registerRepairAdminVerb } from "../services/enterprise/admin-repair";
import { ADMIN_REPAIR_MAX_BYTES, parseQuarantineManifest, parseRepairManifest, adminRepairDigest, boundedRepairConnectionString } from "../services/enterprise/admin-repair-input";
import { previewMigration, MigrationPreviewError } from "../services/enterprise/migration-preview";
import { MIGRATION_MAX_BYTES, MigrationInputError, validMigrationIdentifier, parseMigrationManifestInput } from "../services/enterprise/manifest";
import { scopeHashOf } from "../services/enterprise/feishu/directory";
import { ReadinessError, runReadinessCheck } from "../services/enterprise/readiness";

/** The only read-only verbs permitted by the enterprise admin protocol. */
const READ_ONLY_ADMIN_VERBS = new Set(["preview", "ready-check"]);

export type EnterpriseAdminDispatchEntry =
  | { readonly verb: string; readonly kind: "read-only" }
  | { readonly verb: string; readonly kind: "write"; readonly register: () => void };

/**
 * The production admin command's dispatch inventory.
 *
 * A new write verb must be added here and install itself through
 * registerGuardedWriteHandler. The FS-79 guard compares this table with the
 * live guarded-write registry, so a bare handler or a write mislabeled as
 * read-only cannot silently become executable.
 */
export const ENTERPRISE_ADMIN_DISPATCH: readonly EnterpriseAdminDispatchEntry[] = Object.freeze([
  { verb: "preview", kind: "read-only" },
  { verb: "ready-check", kind: "read-only" },
  { verb: "maintenance", kind: "write", register: registerMaintenanceAdminVerb },
  { verb: "reserve-actors", kind: "write", register: registerActorReservationAdminVerb },
  { verb: "provision", kind: "write", register: registerProvisionAdminVerb },
  { verb: "apply", kind: "write", register: registerMigrationApplyAdminVerb },
  { verb: "convert", kind: "write", register: registerMigrationConvertAdminVerb },
  { verb: "activate", kind: "write", register: registerActivationAdminVerb },
  { verb: "quarantine", kind: "write", register: registerQuarantineAdminVerb },
  { verb: "repair", kind: "write", register: registerRepairAdminVerb },
]);

/** Installs the complete production dispatch table, rejecting incomplete registrations. */
export function installEnterpriseAdminDispatch(
  entries: readonly EnterpriseAdminDispatchEntry[] = ENTERPRISE_ADMIN_DISPATCH,
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.verb.trim() === "" || seen.has(entry.verb)) {
      throw new Error("[@megaui/engine] enterprise admin dispatch has an invalid or duplicate verb.");
    }
    seen.add(entry.verb);
    if (entry.kind === "read-only") {
      if (!READ_ONLY_ADMIN_VERBS.has(entry.verb)) {
        throw new Error("[@megaui/engine] only preview and ready-check may be read-only admin verbs.");
      }
      continue;
    }
    entry.register();
  }
  assertEnterpriseAdminWriteDispatch(entries);
  sealRegisteredWriteHandlers();
}

/**
 * Confirms that the concrete guarded-write registry exactly matches dispatch.
 * Exported for the repository guard; callers cannot supply a handler here.
 */
export function assertEnterpriseAdminWriteDispatch(
  entries: readonly EnterpriseAdminDispatchEntry[] = ENTERPRISE_ADMIN_DISPATCH,
): void {
  const expected = new Set<string>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.verb.trim() === "" || seen.has(entry.verb)) {
      throw new Error("[@megaui/engine] enterprise admin dispatch has an invalid or duplicate verb.");
    }
    seen.add(entry.verb);
    if (entry.kind === "read-only") {
      if (!READ_ONLY_ADMIN_VERBS.has(entry.verb)) {
        throw new Error("[@megaui/engine] only preview and ready-check may be read-only admin verbs.");
      }
      continue;
    }
    expected.add(entry.verb);
  }
  const registered = registeredGuardedWriteVerbs();
  if (registered.length !== expected.size || registered.some((verb) => !expected.has(verb))) {
    throw new Error("[@megaui/engine] every admin write verb must be registered through the complete mutation guard.");
  }
  const approved = registeredApprovedMutationVerbs();
  if (approved.length !== expected.size || approved.some((verb) => !expected.has(verb))) {
    throw new Error("[@megaui/engine] every admin write verb requires an approved mutation capability.");
  }
}

const COMMON_FLAGS = new Set([
  "target",
  "approval",
  "approved-payload",
  "operation-id",
  "expect-policy-epoch",
  "emit-approval-request",
  // Only --emit-approval-request accepts this destination; it is never a
  // behavior argument in a signed payload.
  "out",
]);

export interface EnterpriseAdminIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface EnterpriseAdminOptions {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  io?: EnterpriseAdminIo;
  now?: () => Date;
  /** Runs after input bytes are snapshotted and before they are consumed. */
  observeApprovedBytes?: () => void;
  /** Optional SQL observer attached to the emit-only scope client. */
  onEmitQuery?: (sql: string) => void;
}

/** Runs one admin invocation and returns its process exit code. */
export async function runEnterpriseAdmin(options: EnterpriseAdminOptions): Promise<number> {
  const io = options.io ?? {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  const fail = (code: number, key: string): number => {
    io.stderr(`error: ${key}\n`);
    return adminErrorExitCode(key);
  };

  return runParsed(options, io, fail);
}

async function runParsed(
  options: EnterpriseAdminOptions,
  io: EnterpriseAdminIo,
  fail: (code: number, key: string) => number,
): Promise<number> {
  const verb = options.argv[0];
  if (verb === "preview") return runPreview(options, io);
  if (verb === "ready-check") return runReadyCheck(options, io);
  const pin = verb === undefined || verb.startsWith("-") ? undefined : pinRegisteredVerb(verb);
  if (!pin) return fail(2, "UNKNOWN_VERB");
  try {
    return await runPinned(options, io, fail, pin);
  } finally {
    pin.release();
  }
}

/** Ready-check is read-only and never enters the signed mutation registry. */
async function runReadyCheck(options: EnterpriseAdminOptions, io: EnterpriseAdminIo): Promise<number> {
  const fail = (key: string, code: 2 | 3 | 4): number => {
    io.stderr(`error: ${key}\n`);
    return code;
  };
  try {
    const flags = new Map<string, string>();
    for (let index = 1; index < options.argv.length; index += 1) {
      const token = options.argv[index]!;
      const match = /^--(target|manifest|digest|out)(?:=(.*))?$/.exec(token);
      if (!match || flags.has(match[1]!)) return fail("INVALID_ARGUMENT", 2);
      const value = match[2] ?? options.argv[++index];
      if (value === undefined || value === "" || value.startsWith("--")) return fail("MISSING_ARGUMENT", 2);
      flags.set(match[1]!, value);
    }
    const target = flags.get("target");
    const manifestPath = flags.get("manifest");
    const digest = flags.get("digest");
    const outputPath = flags.get("out");
    if (!target || !manifestPath || !digest || !outputPath || !/^[a-f0-9]{64}$/.test(digest) ||
      !isAbsolute(manifestPath) || !isAbsolute(outputPath) ||
      [manifestPath, outputPath].some(path => !isWellFormedUnicode(path) || path.includes("\0") || path.split(sep).includes(".."))) {
      return fail("INVALID_ARGUMENT", 2);
    }
    const expectation = readScopeExpectation(options.env);
    const tenantKey = options.env.FEISHU_TENANT_KEY;
    const appId = options.env.FEISHU_APP_ID;
    const databaseUrl = options.env.DATABASE_URL;
    if (!expectation || !["admin", "test"].includes(expectation.processRole) ||
      !["development", "test"].includes(expectation.environment) || target !== expectation.instanceId ||
      !validMigrationIdentifier(tenantKey) || !validMigrationIdentifier(appId) || !databaseUrl?.trim()) {
      return fail("INVALID_CONFIG", 2);
    }
    const departmentIds = parseDirectoryDepartmentIds(options.env.FEISHU_DIRECTORY_DEPARTMENT_IDS);
    const bytes = await readApprovedFileBytes(manifestPath, undefined, undefined, 10_000, undefined, MIGRATION_MAX_BYTES);
    if (typeof bytes === "string") return fail(bytes === "INVALID_ARGUMENT" ? "INVALID_ARGUMENT" : bytes, bytes === "INVALID_ARGUMENT" ? 2 : 4);
    if (createHash("sha256").update(bytes).digest("hex") !== digest) return fail("APPROVAL_MANIFEST_MISMATCH", 3);
    const epochs = (options.env.ENTERPRISE_COLLAB_POLICY_EPOCHS ?? "").split(",").filter(Boolean).map(value => {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new ReadinessError(2, "INVALID_CONFIG");
      const epoch = Number(value);
      if (!Number.isSafeInteger(epoch)) throw new ReadinessError(2, "INVALID_CONFIG");
      return epoch;
    });
    const report = await runReadinessCheck({
      bytes,
      databaseUrl,
      expectation,
      authority: { tenantKey, appId },
      directoryScopeHash: scopeHashOf({ tenantKey, appId, departmentIds }),
      workerReady: options.env.ENTERPRISE_WORKER_READY === "1",
      collabPolicyEpochs: epochs,
      now: options.now,
      onQuery: options.onEmitQuery,
    });
    const output = JSON.stringify(report) + "\n";
    try { writeFileSync(outputPath, output, { mode: 0o600, flag: "wx" }); }
    catch (error) {
      const key = adminFilesystemErrorKey(error);
      return fail(key, key === "INVALID_ARGUMENT" ? 2 : 4);
    }
    io.stdout(output);
    return report.status === "ready" ? 0 : 3;
  } catch (error) {
    if (error instanceof ReadinessError) return fail(error.message, error.exitCode);
    if (error instanceof MigrationInputError) return fail(error.message, 2);
    if (error instanceof Error && error.name === "EnterpriseConfigError") return fail("INVALID_CONFIG", 2);
    return fail("DEPENDENCY_FAILED", 4);
  }
}

/** Preview is deliberately outside the signed writer registry and has its own typed exit mapping. */
async function runPreview(options: EnterpriseAdminOptions, io: EnterpriseAdminIo): Promise<number> {
  const deadline = performance.now() + 30_000;
  try {
    const flags = new Map<string, string>();
    for (let index = 1; index < options.argv.length; index += 1) {
      const token = options.argv[index]!;
      const match = /^--(target|manifest|out)(?:=(.*))?$/.exec(token);
      if (!match || flags.has(match[1]!)) throw new MigrationInputError();
      const value = match[2] ?? options.argv[++index];
      if (value === undefined || value === "" || value.startsWith("--")) throw new MigrationInputError();
      flags.set(match[1]!, value);
    }
    const target = flags.get("target"), manifestPath = flags.get("manifest"), outputPath = flags.get("out");
    if (!target || !manifestPath || !outputPath || [manifestPath, outputPath].some(path =>
      !isAbsolute(path) || !isWellFormedUnicode(path) || path.includes("\0") || path.split(sep).includes(".."))) {
      throw new MigrationInputError();
    }
    const env = { ...options.env }, expectation = readScopeExpectation(env);
    const tenantKey = env.FEISHU_TENANT_KEY, appId = env.FEISHU_APP_ID, databaseUrl = env.DATABASE_URL;
    if (!expectation || !["admin", "test"].includes(expectation.processRole) ||
      !["development", "test", "production", "canary"].includes(expectation.environment) ||
      !validMigrationIdentifier(expectation.instanceId) || !validMigrationIdentifier(expectation.ownerFingerprint) ||
      !validMigrationIdentifier(tenantKey) || !validMigrationIdentifier(appId) || !databaseUrl?.trim()) {
      throw new MigrationPreviewError(2, "INVALID_CONFIG");
    }
    if (target !== expectation.instanceId) throw new MigrationPreviewError(3, "SCOPE_REJECTED");
    const bytes = await readApprovedFileBytes(manifestPath, undefined, undefined,
      Math.min(10_000, Math.max(1, deadline - performance.now())), undefined, MIGRATION_MAX_BYTES);
    if (typeof bytes === "string") throw new MigrationPreviewError(bytes === "INVALID_ARGUMENT" ? 2 : 4, bytes);
    const report = await previewMigration({ bytes, databaseUrl, expectation, authority: { tenantKey, appId },
      deadline, now: options.now });
    if (performance.now() >= deadline) throw new MigrationPreviewError(4, "DEPENDENCY_FAILED");
    const output = JSON.stringify(report) + "\n";
    try { writeFileSync(outputPath, output, { mode: 0o600, flag: "wx" }); }
    catch (error) {
      const key = adminFilesystemErrorKey(error);
      throw new MigrationPreviewError(key === "INVALID_ARGUMENT" ? 2 : 4, key);
    }
    io.stdout(output);
    return report.status === "ready" ? 0 : 3;
  } catch (error) {
    const key = error instanceof MigrationPreviewError || error instanceof MigrationInputError ? error.message : "DEPENDENCY_FAILED";
    io.stderr(`error: ${key}\n`);
    return error instanceof MigrationPreviewError ? error.exitCode : error instanceof MigrationInputError ? 2 : 4;
  }
}

async function runPinned(
  options: EnterpriseAdminOptions,
  io: EnterpriseAdminIo,
  fail: (code: number, key: string) => number,
  pin: Exclude<ReturnType<typeof pinRegisteredVerb>, undefined>,
): Promise<number> {
  const parsed = parseArgv(options.argv, pin?.schema);
  if (typeof parsed === "string") return fail(2, parsed);

  const publicKeyPem = options.env.ENTERPRISE_APPROVAL_PUBLIC_KEY;
  if (publicKeyPem === undefined || publicKeyPem.trim() === "") return fail(2, "MISSING_CONFIG");
  const expectation = readScopeExpectation(options.env);
  if (!expectation || (expectation.processRole !== "admin" && expectation.processRole !== "test")) {
    return fail(2, "MISSING_CONFIG");
  }
  if (parsed.target !== expectation.instanceId) return fail(3, "APPROVAL_TARGET_MISMATCH");
  if (parsed.emitApprovalRequest) {
    return emitRequest(parsed, options, expectation, pin.schema);
  }

  if (parsed.approvedPayloadPath === undefined || parsed.approvalPath === undefined) {
    return fail(2, "MISSING_ARGUMENT");
  }
  if (!isWellFormedUnicode(parsed.approvalPath) || parsed.approvalPath.includes("\0")) {
    return fail(2, "INVALID_ARGUMENT");
  }

  let approvalText: string;
  try {
    approvalText = readFileSync(parsed.approvalPath, "utf8");
  } catch (error) {
    return fail(2, adminFilesystemErrorKey(error));
  }
  let approvalJson: unknown;
  try {
    approvalJson = JSON.parse(approvalText);
  } catch {
    return fail(2, "APPROVAL_MALFORMED");
  }
  const bundle = parseApprovalBundle(approvalJson);
  if (typeof bundle === "string") return fail(2, bundle);
  if (typeof readApprovalSignature(bundle.signature) === "string") {
    return fail(3, "APPROVAL_SIGNATURE_INVALID");
  }

  let publicKey;
  try {
    publicKey = approvalPublicKey(publicKeyPem);
  } catch {
    return fail(2, "INVALID_CONFIG");
  }
  if (typeof publicKey === "string") return fail(2, publicKey);
  try {
    if (!verifyApprovalSignature(bundle, publicKey)) return fail(3, "APPROVAL_SIGNATURE_INVALID");
  } catch {
    return fail(2, "APPROVAL_MALFORMED");
  }

  const approved = readApprovedPayload(parsed.approvedPayloadPath);
  if (typeof approved === "string") return fail(2, approved);
  const fingerprint = targetFingerprint(expectation);
  let approvedDigest: string;
  try {
    approvedDigest = payloadDigest(approved);
  } catch {
    return fail(2, "APPROVAL_MALFORMED");
  }
  const decision = checkApproval(bundle, {
    verb: parsed.verb,
    targetFingerprint: fingerprint,
    deploymentRole: expectation.environment,
    operationId: parsed.operationId,
    expectedPolicyEpoch: parsed.expectedPolicyEpoch,
    manifestDigest: parsed.manifestDigest,
    payloadDigest: approvedDigest,
    now: (options.now ?? (() => new Date()))(),
  });
  if (typeof decision === "string") return fail(3, decision);
  const storedFiles = new Map<string, Uint8Array>();
  const args = Object.create(null) as Record<string, string | number>;
  for (const [key, value] of Object.entries(parsed.args)) defineOwn(args, key, value);
  defineOwn(args, "target", parsed.target);
  defineOwn(args, "operation-id", parsed.operationId);
  defineOwn(args, "expect-policy-epoch", parsed.expectedPolicyEpoch);
  try {
    for (const [flag, filePath] of parsed.files) {
      const absolute = resolve(filePath);
      const approvedPath = approved.args[flag];
      if (typeof approvedPath !== "string" || !isAbsolute(approvedPath) || absolute !== approvedPath) {
        return fail(3, "APPROVAL_DIGEST_MISMATCH");
      }
      if (absolute.split(sep).includes("..")) return fail(3, "APPROVAL_DIGEST_MISMATCH");
      const bytes = await readApprovedFileBytes(approvedPath, undefined, undefined, undefined, undefined,
        flag === "manifest" ? (parsed.verb === "provision" ? 1024 * 1024 : ["apply", "convert", "activate"].includes(parsed.verb) ? MIGRATION_MAX_BYTES :
          ["quarantine", "repair"].includes(parsed.verb) ? ADMIN_REPAIR_MAX_BYTES : undefined) : undefined);
      if (bytes === "DEPENDENCY_FAILED") return fail(4, "DEPENDENCY_FAILED");
      if (typeof bytes === "string") return fail(2, "INVALID_ARGUMENT");
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (approved.inputFiles[flag] !== actual) return fail(3, "APPROVAL_DIGEST_MISMATCH");
      storedFiles.set(flag, bytes);
      defineOwn(args, flag, absolute);
    }
    canonicalizeJson(args);
  } catch {
    return fail(2, "INVALID_ARGUMENT");
  }

  const digestInput: PayloadDigestInput = {
    verb: parsed.verb,
    targetFingerprint: fingerprint,
    deploymentRole: expectation.environment,
    operationId: parsed.operationId,
    expectedPolicyEpoch: parsed.expectedPolicyEpoch,
    args,
    inputFiles: approved.inputFiles,
  };
  if (payloadDigest(digestInput) !== approvedDigest) return fail(3, "APPROVAL_DIGEST_MISMATCH");
  options.observeApprovedBytes?.();
  if (!pin) return fail(2, "UNKNOWN_VERB");
  const rejected = await dispatchPinnedVerb({
    pin,
    env: options.env,
    bundle,
    operationId: parsed.operationId,
    expectedPolicyEpoch: parsed.expectedPolicyEpoch,
    manifestDigest: parsed.manifestDigest,
    args,
    files: snapshotOf(storedFiles),
    now: options.now ?? (() => new Date()),
  });
  if (typeof rejected === "string") return fail(adminErrorExitCode(rejected), rejected);
  io.stdout(adminSuccessJson({
    ...(rejected.applied ? { schemaVersion: 3 as const, applied: rejected.applied } :
      rejected.provisioned ? { schemaVersion: 2 as const, provisioned: rejected.provisioned } : { schemaVersion: 1 as const }),
    operationId: parsed.operationId,
    policyEpoch: rejected.policyEpoch,
    resultCounts: rejected.resultCounts,
    replayed: rejected.replayed,
  }));
  return 0;
}

interface ParsedCommand {
  verb: string;
  target: string;
  approvalPath: string;
  operationId: string;
  expectedPolicyEpoch: number;
  manifestDigest: string | null;
  approvedPayloadPath: string | undefined;
  emitApprovalRequest: boolean;
  outputPath: string | undefined;
  args: Record<string, string | number>;
  files: Map<string, string>;
}

function parseArgv(argv: readonly string[], schema: VerbSchema | undefined): ParsedCommand | string {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb.startsWith("-") || verb.trim() === "") return "MISSING_ARGUMENT";
  const values = new Map<string, string>();
  const emitRequested = rest.some(
    (token) => token === "--emit-approval-request" || token.startsWith("--emit-approval-request="),
  );
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined || !token.startsWith("--") || token === "--") return "UNKNOWN_FLAG";
    const body = token.slice(2);
    const equals = body.indexOf("=");
    const name = equals === -1 ? body : body.slice(0, equals);
    if (name === "emit-approval-request") {
      if (equals !== -1) return "INVALID_ARGUMENT";
      if (values.has(name)) return "DUPLICATE_FLAG";
      values.set(name, "true");
      continue;
    }
    const flag = schema !== undefined && Object.hasOwn(schema.flags, name) ? schema.flags[name] : undefined;
    if (name === "out" && emitRequested) {
      if (values.has(name)) return "DUPLICATE_FLAG";
      const inline = equals === -1 ? undefined : body.slice(equals + 1);
      const value = inline ?? rest[index + 1];
      if (value === undefined || value.startsWith("--")) return "MISSING_ARGUMENT";
      if (inline === undefined) index += 1;
      values.set(name, value);
      continue;
    }
    if ((!COMMON_FLAGS.has(name) || name === "out") && flag === undefined) return "UNKNOWN_FLAG";
    if (values.has(name)) return "DUPLICATE_FLAG";
    const inline = equals === -1 ? undefined : body.slice(equals + 1);
    const value = inline ?? rest[index + 1];
    if (value === undefined || value.startsWith("--")) return "MISSING_ARGUMENT";
    if (inline === undefined) index += 1;
    values.set(name, value);
  }

  const target = values.get("target");
  const approvalPath = values.get("approval");
  const approvedPayloadPath = values.get("approved-payload");
  const operationId = values.get("operation-id");
  const epochText = values.get("expect-policy-epoch");
  const outputPath = values.get("out");
  const emitApprovalRequest = values.has("emit-approval-request");
  if (emitApprovalRequest ? (!outputPath || approvalPath || approvedPayloadPath) : (!approvalPath || !approvedPayloadPath)) {
    return "MISSING_ARGUMENT";
  }
  if (!target || !operationId || !epochText || (!emitApprovalRequest && !approvalPath)) {
    return "MISSING_ARGUMENT";
  }
  if (emitApprovalRequest && (!isAbsolute(outputPath as string) ||
    !isWellFormedUnicode(outputPath as string) || (outputPath as string).includes("\0") ||
    (outputPath as string).split(sep).includes(".."))) {
    return "INVALID_ARGUMENT";
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) {
    return "INVALID_ARGUMENT";
  }
  if (!/^(0|[1-9][0-9]*)$/.test(epochText)) return "INVALID_ARGUMENT";
  const expectedPolicyEpoch = Number(epochText);
  if (!Number.isSafeInteger(expectedPolicyEpoch)) return "INVALID_ARGUMENT";

  const args: Record<string, string | number> = {};
  const files = new Map<string, string>();
  let manifestDigest: string | null = null;
  for (const [name, flag] of Object.entries(schema?.flags ?? {})) {
    const supplied = values.get(name);
    if (supplied === undefined) {
      if (flag.required && !(name === "digest" && schema?.emitDigest === "canonical-manifest" && emitApprovalRequest)) {
        return "MISSING_ARGUMENT";
      }
      if (name === "digest" && schema?.emitDigest === "canonical-manifest" && emitApprovalRequest) continue;
      if (flag.kind === "integer") {
        if (typeof flag.default !== "number" || !Number.isSafeInteger(flag.default)) {
          return "INVALID_ARGUMENT";
        }
        args[name] = flag.default;
      } else if (flag.kind === "string") {
        if (typeof flag.default !== "string") return "INVALID_ARGUMENT";
        args[name] = flag.default;
      }
      if (name === "digest" && typeof args[name] === "string") manifestDigest = args[name];
      continue;
    }
    if (flag.kind === "file") {
      if (!isAbsolute(supplied) || !isWellFormedUnicode(supplied) || supplied.includes("\0") ||
        supplied.split(sep).includes("..")) return "INVALID_ARGUMENT";
      files.set(name, supplied);
      continue;
    }
    if (flag.kind === "integer") {
      if (!/^(0|[1-9][0-9]*)$/.test(supplied)) return "INVALID_ARGUMENT";
      const integer = Number(supplied);
      if (!Number.isSafeInteger(integer)) return "INVALID_ARGUMENT";
      args[name] = integer;
    } else {
      args[name] = supplied;
    }
    if (name === "digest") manifestDigest = supplied;
  }
  if (manifestDigest !== null && !/^[a-f0-9]{64}$/.test(manifestDigest)) {
    return "INVALID_ARGUMENT";
  }
  return {
    verb,
    target,
    approvalPath: approvalPath as string,
    operationId,
    expectedPolicyEpoch,
    approvedPayloadPath,
    emitApprovalRequest,
    outputPath,
    manifestDigest,
    args,
    files,
  };
}

/**
 * Reads a regular file by walking from `/` with `O_NOFOLLOW` on every component.
 * A symlink in a parent directory or the final path is rejected before its bytes
 * are returned. FIFOs are opened nonblocking and rejected before a read.
 */
const FILE_OPEN_HELPER = [
  "import errno, os, stat, sys",
  "path, output, maximum_bytes = sys.argv[1:4]",
  "parts = [part for part in path.split('/') if part]",
  "if not path.startswith('/') or any(part in ('.', '..') for part in parts):",
  "    raise SystemExit(2)",
  "invalid_errnos = {errno.ENOENT, errno.ENOTDIR, errno.ELOOP, errno.EINVAL, errno.ENAMETOOLONG, errno.EISDIR}",
  "try:",
  "    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)",
  "    try:",
  "        for index, part in enumerate(parts):",
  "            last = index == len(parts) - 1",
  "            flags = os.O_RDONLY | os.O_NOFOLLOW | (os.O_NONBLOCK if last else os.O_DIRECTORY)",
  "            nxt = os.open(part, flags, dir_fd=fd)",
  "            os.close(fd)",
  "            fd = nxt",
  "        info = os.fstat(fd)",
  "        if not stat.S_ISREG(info.st_mode) or info.st_size > int(maximum_bytes):",
  "            raise SystemExit(2)",
  "        sys.stdout.write('ready\\n')",
  "        sys.stdout.flush()",
  "        sys.stdin.readline()",
  "        remaining = info.st_size",
  "        with open(output, 'wb') as out:",
  "            while remaining:",
  "                chunk = os.read(fd, min(remaining, 1024 * 1024))",
  "                if not chunk:",
  "                    break",
  "                out.write(chunk)",
  "                remaining -= len(chunk)",
  "    finally:",
  "        os.close(fd)",
  "except OSError as error:",
  "    raise SystemExit(2 if error.errno in invalid_errnos else 4)",
].join("\n");

/** Walks from `/` without following links, then reads only the previously observed inode. */
export async function readApprovedFileBytes(
  absolutePath: string,
  beforeOpen?: () => void,
  helper = "python3",
  handshakeMs = 10_000,
  temporaryRoot = tmpdir(),
  maximumBytes = Number.MAX_SAFE_INTEGER,
): Promise<Buffer | "INVALID_ARGUMENT" | "DEPENDENCY_FAILED"> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
    !isAbsolute(absolutePath) || !isWellFormedUnicode(absolutePath) || absolutePath.includes("\0") ||
    absolutePath.split(sep).includes("..")) {
    return "INVALID_ARGUMENT";
  }
  let directory: string;
  try {
    directory = mkdtempSync(join(temporaryRoot, "megaui-approved-"));
  } catch {
    return "DEPENDENCY_FAILED";
  }
  const cleanup = (): boolean => {
    try {
      rmSync(directory, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };
  const output = join(directory, "bytes");
  const child = spawn(helper, ["-c", FILE_OPEN_HELPER, absolutePath, output, String(maximumBytes)], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  let helperMissing = false;
  child.on("error", () => {
    helperMissing = true;
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let handshakeTimedOut = false;
  const timer = setTimeout(() => {
    handshakeTimedOut = true;
    child.kill();
  }, handshakeMs);
  let identity: string;
  try {
    identity = await Promise.race([
      new Promise<string>((resolve) => {
        let buffered = "";
        const onData = (chunk: Buffer) => {
          buffered += chunk.toString("utf8");
          if (buffered.includes("\n")) {
            child.stdout?.off("data", onData);
            resolve(buffered);
          }
        };
        child.stdout?.on("data", onData);
      }),
      closed.then(() => ""),
    ]);
  } catch {
    clearTimeout(timer);
    cleanup();
    return "DEPENDENCY_FAILED";
  }
  if (helperMissing) {
    clearTimeout(timer);
    cleanup();
    return "DEPENDENCY_FAILED";
  }
  child.stdin?.on("error", () => {});
  let outcome: Buffer | "INVALID_ARGUMENT" | "DEPENDENCY_FAILED";
  let cleanupFailed: boolean;
  try {
    if (!identity.includes("ready")) {
      const status = await closed;
      outcome = helperMissing || handshakeTimedOut || status === 4 ? "DEPENDENCY_FAILED" : "INVALID_ARGUMENT";
    } else {
      beforeOpen?.();
      try {
        child.stdin?.write("go\n");
        child.stdin?.end();
      } catch {
        // The helper can exit after ready and before this write.
      }
      const status = await closed;
      if (handshakeTimedOut || status === 4) outcome = "DEPENDENCY_FAILED";
      else if (status !== 0) outcome = "INVALID_ARGUMENT";
      else {
        try {
          outcome = readFileSync(output);
        } catch (error) {
          outcome = adminFilesystemErrorKey(error);
        }
      }
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    cleanupFailed = !cleanup();
  }
  return cleanupFailed ? "DEPENDENCY_FAILED" : outcome;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function readApprovedPayload(
  path: string,
): PayloadDigestInput | "APPROVAL_MALFORMED" | "INVALID_ARGUMENT" | "DEPENDENCY_FAILED" {
  if (!isWellFormedUnicode(path) || path.includes("\0")) return "INVALID_ARGUMENT";
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return adminFilesystemErrorKey(error);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "APPROVAL_MALFORMED";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "APPROVAL_MALFORMED";
  const record = value as Record<string, unknown>;
  const request = approvalRequestSchema.safeParse(record);
  if (request.success) {
    const approved: PayloadDigestInput = {
      verb: request.data.verb,
      targetFingerprint: request.data.targetFingerprint,
      deploymentRole: request.data.deploymentRole,
      operationId: request.data.operationId,
      expectedPolicyEpoch: request.data.expectedPolicyEpoch,
      args: request.data.args,
      inputFiles: request.data.inputFiles,
    };
    try {
      if (payloadDigest(approved) !== request.data.payloadDigest) return "APPROVAL_MALFORMED";
    } catch {
      return "APPROVAL_MALFORMED";
    }
    return approved;
  }
  if (
    record.schemaVersion !== 1 ||
    typeof record.verb !== "string" ||
    typeof record.targetFingerprint !== "string" ||
    typeof record.deploymentRole !== "string" ||
    typeof record.operationId !== "string" ||
    typeof record.expectedPolicyEpoch !== "number" ||
    typeof record.args !== "object" ||
    record.args === null ||
    Array.isArray(record.args) ||
    typeof record.inputFiles !== "object" ||
    record.inputFiles === null ||
    Array.isArray(record.inputFiles) ||
    Object.keys(record).length !== 8
  ) {
    return "APPROVAL_MALFORMED";
  }
  return {
    verb: record.verb,
    targetFingerprint: record.targetFingerprint,
    deploymentRole: record.deploymentRole,
    operationId: record.operationId,
    expectedPolicyEpoch: record.expectedPolicyEpoch,
    args: record.args as PayloadDigestInput["args"],
    inputFiles: record.inputFiles as PayloadDigestInput["inputFiles"],
  };
}

function defineOwn(
  record: Record<string, string | number>,
  key: string,
  value: string | number,
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function snapshotOf(files: ReadonlyMap<string, Uint8Array>): ApprovedFileSnapshot {
  return {
    names: () => [...files.keys()],
    bytes(name: string): Uint8Array | undefined {
      const found = files.get(name);
      return found === undefined ? undefined : Uint8Array.from(found);
    },
  };
}

async function emitRequest(
  parsed: ParsedCommand,
  options: EnterpriseAdminOptions,
  expectation: EnterpriseScopeExpectation,
  schema: VerbSchema,
): Promise<number> {
  if (parsed.outputPath === undefined) return 2;
  if (Object.values(schema.flags).some((flag) => flag.kind !== "file" && flag.emitSafe !== true)) {
    return failOutput(options, "INVALID_ARGUMENT");
  }
  const fingerprint = targetFingerprint(expectation);
  const args = Object.create(null) as Record<string, string | number>;
  for (const [key, value] of Object.entries(parsed.args)) defineOwn(args, key, value);
  defineOwn(args, "target", parsed.target);
  defineOwn(args, "operation-id", parsed.operationId);
  defineOwn(args, "expect-policy-epoch", parsed.expectedPolicyEpoch);
  const inputFiles = Object.create(null) as Record<string, string>;
  const inputBytes = new Map<string, Buffer>();
  for (const [flag, filePath] of parsed.files) {
    const absolute = resolve(filePath);
    if (!isAbsolute(absolute) || absolute.split(sep).includes("..")) {
      return failOutput(options, "INVALID_ARGUMENT");
    }
    const bytes = await readApprovedFileBytes(absolute, undefined, undefined, undefined, undefined,
      flag === "manifest" ? (parsed.verb === "provision" ? 1024 * 1024 : ["apply", "convert", "activate"].includes(parsed.verb) ? MIGRATION_MAX_BYTES :
          ["quarantine", "repair"].includes(parsed.verb) ? ADMIN_REPAIR_MAX_BYTES : undefined) : undefined);
    if (bytes === "DEPENDENCY_FAILED") return failOutput(options, "DEPENDENCY_FAILED");
    if (typeof bytes === "string") return failOutput(options, "INVALID_ARGUMENT");
    defineOwn(args, flag, absolute);
    inputBytes.set(flag, bytes);
    inputFiles[flag] = createHash("sha256").update(bytes).digest("hex");
  }
  options.observeApprovedBytes?.();
  if (args.target !== parsed.target ||
    args["operation-id"] !== parsed.operationId ||
    args["expect-policy-epoch"] !== parsed.expectedPolicyEpoch) {
    return failOutput(options, "APPROVAL_DIGEST_MISMATCH");
  }
  let manifestDigest = parsed.manifestDigest;
  if (["apply", "convert", "activate"].includes(parsed.verb)) {
    try {
      const members = parseMigrationManifestInput(inputBytes.get("manifest"));
      if ((parsed.verb === "apply" || parsed.verb === "convert") &&
        (!Number.isSafeInteger(args["batch-number"]) || Number(args["batch-number"]) < 0 ||
          Number(args["batch-number"]) >= Math.ceil(members.length / 100))) return failOutput(options, "INVALID_ARGUMENT");
    } catch { return failOutput(options, "INVALID_ARGUMENT"); }
  }
  if (parsed.verb === "quarantine" || parsed.verb === "repair") {
    try {
      const members = parsed.verb === "quarantine" ? parseQuarantineManifest(inputBytes.get("manifest")) : parseRepairManifest(inputBytes.get("manifest"));
      const digest = adminRepairDigest(members);
      if (manifestDigest !== null && manifestDigest !== digest) return failOutput(options, "APPROVAL_MANIFEST_MISMATCH");
      manifestDigest = digest;
    } catch { return failOutput(options, "INVALID_ARGUMENT"); }
  }
  if (parsed.verb === "seed-canary") {
    const manifestPath = parsed.files.get("manifest");
    if (manifestPath === undefined) return failOutput(options, "MISSING_ARGUMENT");
    const manifestBytes = inputBytes.get("manifest");
    if (manifestBytes === undefined) return failOutput(options, "MISSING_ARGUMENT");
    let document: unknown;
    try {
      document = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      return failOutput(options, "INVALID_ARGUMENT");
    }
    let canonical: string;
    try {
      canonical = canonicalCanaryManifest(document);
    } catch {
      return failOutput(options, "INVALID_ARGUMENT");
    }
    const manifest = createHash("sha256").update(canonical, "utf8").digest("hex");
    if (manifest === undefined) return failOutput(options, "MISSING_ARGUMENT");
    if (manifestDigest !== null && manifestDigest !== manifest) {
      return failOutput(options, "APPROVAL_MANIFEST_MISMATCH");
    }
    manifestDigest = manifest;
  }
  if (manifestDigest !== null) defineOwn(args, "digest", manifestDigest);
  let requestPayloadDigest: string;
  try {
    requestPayloadDigest = payloadDigest({
      verb: parsed.verb,
      targetFingerprint: fingerprint,
      deploymentRole: expectation.environment,
      operationId: parsed.operationId,
      expectedPolicyEpoch: parsed.expectedPolicyEpoch,
      args,
      inputFiles,
    });
  } catch {
    return failOutput(options, "INVALID_ARGUMENT");
  }
  const request: ApprovalRequest = {
    schemaVersion: 1,
    verb: parsed.verb,
    targetFingerprint: fingerprint,
    deploymentRole: expectation.environment,
    operationId: parsed.operationId,
    expectedPolicyEpoch: parsed.expectedPolicyEpoch,
    payloadDigest: requestPayloadDigest,
    manifestDigest,
    args,
    inputFiles,
  };
  const scoped = await readScopeForEmit(options.env.DATABASE_URL, expectation, options.onEmitQuery,
    parsed.verb === "quarantine" || parsed.verb === "repair");
  if (scoped !== undefined) return failOutput(options, scoped);
  try {
    writeFileSync(parsed.outputPath, approvalRequestJson(request), { flag: "wx" });
  } catch (error) {
    return failOutput(options, adminFilesystemErrorKey(error));
  }
  return 0;
}

function canonicalCanaryManifest(value: unknown): string {
  if (!Array.isArray(value)) throw new Error("canary manifest must be an array");
  const members = value.map((member) => {
    if (!member || typeof member !== "object" || Array.isArray(member)) throw new Error("invalid member");
    const row = member as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "local_user_id,observed_at") {
      throw new Error("unexpected canary fields");
    }
    if (typeof row.local_user_id !== "string" || row.local_user_id.trim() === "" ||
      typeof row.observed_at !== "string" || row.observed_at.trim() === "") {
      throw new Error("invalid canary member");
    }
    return { local_user_id: row.local_user_id, observed_at: row.observed_at };
  });
  return canonicalizeJson(members);
}

function failOutput(options: EnterpriseAdminOptions, key: string): number {
  const io = options.io ?? { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) };
  io.stderr(`error: ${key}\n`);
  return adminErrorExitCode(key);
}

async function readScopeForEmit(
  databaseUrl: string | undefined,
  expectation: EnterpriseScopeExpectation,
  onQuery?: (sql: string) => void,
  bounded = false,
): Promise<string | undefined> {
  if (!databaseUrl) return "DEPENDENCY_FAILED";
  let connectionString = databaseUrl;
  try { if (bounded) connectionString = boundedRepairConnectionString(databaseUrl); }
  catch { return "INVALID_CONFIG"; }
  const pool = new Pool({ connectionString, ...(bounded ? { max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000 } : {}) });
  pool.on("error", () => {});
  let client: PoolClient | undefined;
  let queryable: Pool | undefined;
  try {
    client = await pool.connect();
    queryable = traceReadOnlyQueries(client, onQuery);
    await queryable.query("begin");
    await queryable.query("set transaction read only");
    if (bounded) await queryable.query("select set_config(name,least(coalesce(nullif(setting::int,0),5000),5000)::text,true) " +
      "from pg_settings where name in ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout')");
    const marker = await readEnterpriseMarker(queryable);
    const privileges = await readSqlRolePrivileges(queryable);
    assertEnterpriseScope({ marker, expectation, privileges });
    await queryable.query("rollback");
    return undefined;
  } catch (error) {
    try {
      await queryable?.query("rollback");
    } catch {
      // read-only rollback failure is still a dependency failure.
    }
    return error instanceof EnterpriseScopeError ? "SCOPE_REJECTED" : "DEPENDENCY_FAILED";
  } finally {
    client?.release();
    await pool.end();
  }
}

function traceReadOnlyQueries(
  client: PoolClient,
  onQuery: ((sql: string) => void) | undefined,
): Pool {
  if (onQuery === undefined) return client as unknown as Pool;
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "query") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const statement = args[0];
        if (typeof statement === "string") onQuery(statement);
        else if (statement !== null && typeof statement === "object" &&
          "text" in statement && typeof statement.text === "string") onQuery(statement.text);
        return Reflect.apply(target.query as unknown as (...input: unknown[]) => unknown, target, args);
      };
    },
  }) as unknown as Pool;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  try {
    installEnterpriseAdminDispatch();
  } catch {
    process.stderr.write("error: DEPENDENCY_FAILED\n");
    process.exitCode = 4;
  }
  if (process.exitCode === undefined) runEnterpriseAdmin({ argv: process.argv.slice(2), env: process.env })
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write("error: DEPENDENCY_FAILED\n");
      process.exitCode = 4;
    });
}
