// megaui-only (FS-80): approval verification has no upstream counterpart.
// FS-80: approval bundle verification and the guarded write-handler registry.
//
// The admin process holds only the deployment public key. A bundle cannot
// supply a replacement key, and a write handler cannot be registered unless
// execution is forced through this verifier first.

import { createHash } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import {
  assertEnterpriseScope,
  EnterpriseScopeError,
  readEnterpriseMarker,
  readScopeExpectation,
  readSqlRolePrivileges,
  targetFingerprint,
  type EnterpriseScopeExpectation,
} from "@megaui/database";

import { payloadDigest } from "./admin-payload";
import { runApprovedMutation } from "./admin-mutation";
import {
  approvalPublicKey,
  checkApproval,
  verifyApprovalSignature,
  type ApprovalBundle,
  type ApprovalRejection,
} from "./admin-approval-verifier";

// Preserve the FS-80 public module surface for the CLI and signer fixture.
export {
  approvalPublicKey,
  canonicalSignedDocument,
  checkApproval,
  parseApprovalBundle,
  readApprovalSignature,
  verifyApprovalSignature,
  type ApprovalBundle,
  type ApprovalCheck,
  type ApprovalOperation,
  type ApprovalRejection,
} from "./admin-approval-verifier";

import { trustedAdminEnv } from "./admin-env";
import type { ApprovedMutationSuccess, ApprovedMutationHandler } from "./admin-mutation";

export type GuardDispatchSuccess = ApprovedMutationSuccess;
export interface VerbFlagSchema {
  readonly kind: "string" | "integer" | "file";
  readonly required?: boolean;
  readonly default?: string | number;
  /** Explicit opt-in required before a scalar value may enter an unsigned request. */
  readonly emitSafe?: true;
}

/** Every flag the verb accepts, including defaults. Common write flags are separate. */
export interface VerbSchema {
  readonly flags: Readonly<Record<string, VerbFlagSchema>>;
  /** Only quarantine/seed-canary can use canonical-manifest self-digest. */
  readonly emitDigest?: "canonical-manifest";
}

/** Bytes captured at digest time. Each read returns a fresh copy. */
export interface ApprovedFileSnapshot {
  names(): readonly string[];
  bytes(name: string): Uint8Array | undefined;
}

export interface GuardedWriteContext {
  readonly verb: string;
  readonly operationId: string;
  readonly args: Readonly<Record<string, string | number>>;
  readonly files: ApprovedFileSnapshot;
}

export type GuardedWriteHandler = ApprovedMutationHandler;

const COMPLETE_GUARD = Symbol("fs80-complete-write-guard");

interface RegisteredVerb {
  readonly schema: VerbSchema;
  readonly handler: GuardedWriteHandler;
  readonly guard: typeof COMPLETE_GUARD;
  /** True only for a capability minted for dispatchPinnedVerb/runApprovedMutation. */
  readonly approvedMutationCapability: boolean;
}

const writeHandlers = new Map<string, RegisteredVerb>();
let writeRegistrySealed = false;

/** A handler may register only when approval and scope will both run before it. */
export interface CompleteWriteGuard {
  readonly approval: true;
  readonly scope: true;
}

const APPROVED_MUTATION_CAPABILITY: unique symbol = Symbol("fs79-approved-mutation-capability");

/** An opaque write capability whose only execution route is dispatchPinnedVerb. */
export interface ApprovedMutationCapability {
  readonly schema: VerbSchema;
  readonly handler: GuardedWriteHandler;
  readonly [APPROVED_MUTATION_CAPABILITY]: typeof APPROVED_MUTATION_CAPABILITY;
}

/** Mints the capability accepted by the production admin dispatch registrar. */
export function createApprovedMutationCapability(
  schema: VerbSchema,
  handler: GuardedWriteHandler,
): ApprovedMutationCapability {
  const capability: ApprovedMutationCapability = {
    schema,
    handler,
    [APPROVED_MUTATION_CAPABILITY]: APPROVED_MUTATION_CAPABILITY,
  };
  return Object.freeze(capability);
}

/** The only way a write handler enters dispatch. An incomplete guard is refused. */
export function registerGuardedWriteHandler(
  verb: string,
  schema: VerbSchema,
  handler: GuardedWriteHandler,
  guard?: Partial<CompleteWriteGuard>,
): void {
  if (writeRegistrySealed) {
    throw new Error("[@megaui/engine] the production write registry is sealed after dispatch installation");
  }
  if (guard?.approval !== true || guard.scope !== true) {
    throw new Error("[@megaui/engine] a write handler requires the complete approval guard");
  }
  if (pinnedVerbs > 0) {
    throw new Error("[@megaui/engine] the write registry is frozen for an in-flight invocation");
  }
  if (verb.trim() === "" || verb.startsWith("-") || writeHandlers.has(verb)) {
    throw new Error("[@megaui/engine] a write handler verb must be unique and non-blank");
  }
  if (schema.emitDigest !== undefined && schema.emitDigest !== "canonical-manifest") {
    throw new Error("[@megaui/engine] unknown emit digest resolver");
  }
  if (schema.emitDigest === "canonical-manifest" && verb !== "quarantine" && verb !== "seed-canary") {
    throw new Error("[@megaui/engine] canonical-manifest digest is limited to quarantine and seed-canary");
  }
  for (const [name, flag] of Object.entries(schema.flags)) {
    if (name.trim() === "" || UNSAFE_FLAG_NAMES.has(name) || COMMON_FLAG_NAMES.has(name)) {
      throw new Error("[@megaui/engine] a verb flag collides with a common write flag");
    }
    if (flag.kind === "file") {
      if (flag.default !== undefined) {
        throw new Error("[@megaui/engine] a file flag cannot have a default");
      }
    } else if (!flag.required && flag.default === undefined) {
      throw new Error("[@megaui/engine] an optional flag must declare its default");
    } else if (flag.kind === "integer" && flag.default !== undefined && typeof flag.default !== "number") {
      throw new Error("[@megaui/engine] an integer flag default must be an integer");
    } else if (flag.kind === "string" && flag.default !== undefined && typeof flag.default !== "string") {
      throw new Error("[@megaui/engine] a string flag default must be a string");
    }
  }
  writeHandlers.set(verb, {
    schema,
    handler,
    guard: COMPLETE_GUARD,
    approvedMutationCapability: false,
  });
}

/**
 * Registers a capability minted above. Production dispatch uses this path;
 * its execution remains pinned to dispatchPinnedVerb → runApprovedMutation.
 */
export function registerApprovedMutationHandler(
  verb: string,
  capability: ApprovedMutationCapability,
): void {
  if (capability[APPROVED_MUTATION_CAPABILITY] !== APPROVED_MUTATION_CAPABILITY) {
    throw new Error("[@megaui/engine] admin dispatch requires an approved mutation capability.");
  }
  registerGuardedWriteHandler(verb, capability.schema, capability.handler, { approval: true, scope: true });
  const registered = writeHandlers.get(verb);
  if (!registered) {
    throw new Error("[@megaui/engine] approved mutation capability did not register a verb.");
  }
  writeHandlers.set(verb, { ...registered, approvedMutationCapability: true });
}

/** Removes registered handlers. It cannot insert one, and it cannot run during a pin. */
export function clearRegisteredWriteHandlers(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("[@megaui/engine] the write registry may be reset only by tests");
  }
  if (pinnedVerbs > 0) {
    throw new Error("[@megaui/engine] the write registry is frozen for an in-flight invocation");
  }
  writeHandlers.clear();
  writeRegistrySealed = false;
}

/** The actual guarded-write registry, exposed only for the FS-79 dispatch guard. */
export function registeredGuardedWriteVerbs(): readonly string[] {
  return Object.freeze([...writeHandlers.keys()].sort());
}

/** The subset installed through an opaque capability for runApprovedMutation. */
export function registeredApprovedMutationVerbs(): readonly string[] {
  return Object.freeze(
    [...writeHandlers.entries()]
      .filter(([, registered]) => registered.approvedMutationCapability)
      .map(([verb]) => verb)
      .sort(),
  );
}

/** Locks the verified production dispatch against later table-external writes. */
export function sealRegisteredWriteHandlers(): void {
  if (pinnedVerbs > 0) {
    throw new Error("[@megaui/engine] the write registry is frozen for an in-flight invocation");
  }
  writeRegistrySealed = true;
}

/** Pins the handler and schema together. The handler is not readable from the pin. */
export function pinRegisteredVerb(verb: string): VerbPin | undefined {
  const registered = writeHandlers.get(verb);
  if (!registered || registered.guard !== COMPLETE_GUARD) return undefined;
  const id = Symbol(verb);
  const pin: VerbPin = {
    schema: registered.schema,
    release(): void {
      if (!pins.delete(id)) return;
      pinnedVerbs -= 1;
    },
  };
  pins.set(id, { verb, handler: registered.handler, schema: registered.schema });
  pinTokens.set(pin, id);
  pinnedVerbs += 1;
  return pin;
}

export interface VerbPin {
  readonly schema: VerbSchema;
  release(): void;
}

/**
 * Dispatch reads the deployment public key, database, and scope from `env`.
 * Fingerprint and role come from that same expectation. Arguments and file
 * bytes are copied before the scope check.
 */
export async function dispatchPinnedVerb(input: {
  pin: VerbPin;
  env: Record<string, string | undefined>;
  bundle: ApprovalBundle;
  operationId: string;
  expectedPolicyEpoch: number;
  manifestDigest: string | null;
  args: Readonly<Record<string, string | number>>;
  files: ApprovedFileSnapshot;
  now: () => Date;
}): Promise<GuardDispatchFailure | GuardDispatchSuccess> {
  const id = pinTokens.get(input.pin);
  const pinned = id === undefined ? undefined : pins.get(id);
  if (!pinned) return "UNKNOWN_VERB";
  const publicKey = approvalPublicKey(input.env.ENTERPRISE_APPROVAL_PUBLIC_KEY ?? "");
  if (typeof publicKey === "string") return "DEPENDENCY_FAILED";
  const expectation = readScopeExpectation(input.env);
  if (!expectation || (expectation.processRole !== "admin" && expectation.processRole !== "test")) {
    return "DEPENDENCY_FAILED";
  }
  const copiedArgs = copyRecord(input.args);
  const copiedFiles = new Map<string, Uint8Array>();
  for (const name of input.files.names()) {
    const bytes = input.files.bytes(name);
    if (bytes === undefined) return "APPROVAL_DIGEST_MISMATCH";
    copiedFiles.set(name, Uint8Array.from(bytes));
  }
  const fingerprint = targetFingerprint(expectation);
  const inputFiles = Object.create(null) as Record<string, string>;
  for (const [name, bytes] of copiedFiles) {
    defineOwn(inputFiles, name, createHash("sha256").update(bytes).digest("hex"));
  }
  if (!verifyApprovalSignature(input.bundle, publicKey)) return "APPROVAL_SIGNATURE_INVALID";
  const approvedDigest = payloadDigest({
    verb: pinned.verb,
    targetFingerprint: fingerprint,
    deploymentRole: expectation.environment,
    operationId: input.operationId,
    expectedPolicyEpoch: input.expectedPolicyEpoch,
    args: copiedArgs,
    inputFiles,
  });
  const decision = checkApproval(input.bundle, {
    verb: pinned.verb,
    targetFingerprint: fingerprint,
    deploymentRole: expectation.environment,
    operationId: input.operationId,
    expectedPolicyEpoch: input.expectedPolicyEpoch,
    manifestDigest: input.manifestDigest,
    payloadDigest: approvedDigest,
    now: input.now(),
  });
  if (typeof decision === "string") return decision;
  try {
    // FS-38 validates its pure manifest before opening any connection, then
    // applies the full scope guard in the same bounded FS-81 transaction.
    if (pinned.verb !== "quarantine" && pinned.verb !== "repair") {
      const scope = await readDispatchScope(trustedAdminEnv().DATABASE_URL, expectation);
      if (scope !== undefined) return scope;
    }
    const current = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(current) || input.bundle.expiresAt <= current) return "APPROVAL_EXPIRED";
    const written = await runApprovedMutation({
      bundle: input.bundle,
      operationId: input.operationId,
      manifestDigest: input.manifestDigest,
      expectedPolicyEpoch: input.expectedPolicyEpoch,
      context: {
        verb: pinned.verb,
        operationId: input.operationId,
        args: copiedArgs,
        files: snapshotOf(copiedFiles),
      },
      handler: pinned.handler,
    });
    return written;
  } catch {
    return "DEPENDENCY_FAILED";
  }
}

const pins = new Map<symbol, { verb: string; handler: GuardedWriteHandler; schema: VerbSchema }>();
const pinTokens = new WeakMap<VerbPin, symbol>();

let pinnedVerbs = 0;

const COMMON_FLAG_NAMES = new Set([
  "target",
  "approval",
  "approved-payload",
  "operation-id",
  "expect-policy-epoch",
  "emit-approval-request",
  "out",
]);
const UNSAFE_FLAG_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export type GuardDispatchFailure =
  | ApprovalRejection
  | "INVALID_ARGUMENT"
  | "ACTOR_SOURCE_REJECTED"
  | "PROVISION_REJECTED"
  | "MIGRATION_REJECTED"
  | "QUARANTINE_REJECTED"
  | "REPAIR_REJECTED"
  | "UNKNOWN_VERB"
  | "SCOPE_REJECTED"
  | "EPOCH_CAS_MISMATCH"
  | "OPERATION_PAYLOAD_MISMATCH"
  | "INVALID_CONFIG"
  | "DEPENDENCY_FAILED";

function copyRecord(
  source: Readonly<Record<string, string | number>>,
): Readonly<Record<string, string | number>> {
  const copy = Object.create(null) as Record<string, string | number>;
  for (const key of Object.keys(source)) defineOwn(copy, key, source[key] as string | number);
  return Object.freeze(copy);
}

function defineOwn(record: Record<string, string | number>, key: string, value: string | number): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: false, configurable: false });
}

function snapshotOf(files: ReadonlyMap<string, Uint8Array>): ApprovedFileSnapshot {
  return {
    names: () => Object.freeze([...files.keys()]),
    bytes(name: string): Uint8Array | undefined {
      const found = files.get(name);
      return found === undefined ? undefined : Uint8Array.from(found);
    },
  };
}

async function readDispatchScope(
  databaseUrl: string | undefined,
  expectation: EnterpriseScopeExpectation,
): Promise<"DEPENDENCY_FAILED" | "SCOPE_REJECTED" | undefined> {
  if (databaseUrl === undefined || databaseUrl.trim() === "") return "DEPENDENCY_FAILED";
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on("error", () => {});
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("begin");
    await client.query("set transaction read only");
    const queryable = client as unknown as Pool;
    const marker = await readEnterpriseMarker(queryable);
    const privileges = await readSqlRolePrivileges(queryable);
    assertEnterpriseScope({ marker, expectation, privileges });
    await client.query("rollback");
    return undefined;
  } catch (error) {
    try {
      await client?.query("rollback");
    } catch {
      // The read-only transaction is already unusable.
    }
    if (error instanceof EnterpriseScopeError) return "SCOPE_REJECTED";
    return "DEPENDENCY_FAILED";
  } finally {
    client?.release();
    await pool.end();
  }
}

