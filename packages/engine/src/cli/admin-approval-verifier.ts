// megaui-only (FS-81): shared verification of signed admin approvals.
// These pure checks are used by both CLI admission and the transaction boundary.
import { createPrivateKey, createPublicKey, verify, type KeyObject } from "node:crypto";

import { canonicalizeJson, PAYLOAD_DIGEST_SCHEMA_VERSION } from "./admin-payload";

export type ApprovalRejection =
  | "APPROVAL_MALFORMED"
  | "APPROVAL_SIGNATURE_INVALID"
  | "APPROVAL_VERB_MISMATCH"
  | "APPROVAL_TARGET_MISMATCH"
  | "APPROVAL_OPERATION_MISMATCH"
  | "APPROVAL_MANIFEST_MISMATCH"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_DIGEST_MISMATCH"
  | "APPROVAL_ROLE_MISMATCH";

export interface ApprovalOperation {
  verb: string;
  targetFingerprint: string;
  deploymentRole: string;
  operationId: string;
  payloadDigest: string;
  manifestDigest: string | null;
  expectedPolicyEpoch: number;
}

export interface ApprovalBundle {
  schemaVersion: number;
  approvalId: string;
  approvedBy: string;
  issuedAt: number;
  expiresAt: number;
  operations: ApprovalOperation[];
  signature: string;
}

export interface ApprovalCheck {
  verb: string;
  targetFingerprint: string;
  deploymentRole: string;
  operationId: string;
  expectedPolicyEpoch: number;
  manifestDigest: string | null;
  payloadDigest: string;
  now: Date;
}

const APPROVAL_KEYS = [
  "approvalId", "approvedBy", "expiresAt", "issuedAt", "operations", "schemaVersion", "signature",
] as const;
const OPERATION_KEYS = [
  "deploymentRole", "expectedPolicyEpoch", "manifestDigest", "operationId", "payloadDigest",
  "targetFingerprint", "verb",
] as const;

/** Parse and copy the entire untrusted bundle. Unknown fields fail closed. */
export function parseApprovalBundle(value: unknown): ApprovalBundle | ApprovalRejection {
  if (!isRecord(value) || !sameKeys(value, APPROVAL_KEYS)) return "APPROVAL_MALFORMED";
  if (
    value.schemaVersion !== PAYLOAD_DIGEST_SCHEMA_VERSION ||
    !isNonBlank(value.approvalId) ||
    !isNonBlank(value.approvedBy) ||
    !isUnixSeconds(value.issuedAt) ||
    !isUnixSeconds(value.expiresAt) ||
    value.expiresAt < value.issuedAt ||
    !Array.isArray(value.operations) ||
    value.operations.length === 0 ||
    typeof value.signature !== "string"
  ) return "APPROVAL_MALFORMED";

  const operations: ApprovalOperation[] = [];
  for (const operation of value.operations) {
    const parsed = parseOperation(operation);
    if (typeof parsed === "string") return parsed;
    operations.push(parsed);
  }
  return {
    schemaVersion: value.schemaVersion,
    approvalId: value.approvalId,
    approvedBy: value.approvedBy,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    operations,
    signature: value.signature,
  };
}

export function readApprovalSignature(signature: string): Buffer | "APPROVAL_SIGNATURE_INVALID" {
  if (!isStandardBase64(signature, 64)) return "APPROVAL_SIGNATURE_INVALID";
  return Buffer.from(signature, "base64");
}

export function verifyApprovalSignature(bundle: ApprovalBundle, publicKey: KeyObject): boolean {
  if (publicKey.asymmetricKeyType !== "ed25519") return false;
  const signature = readApprovalSignature(bundle.signature);
  if (typeof signature === "string") return false;
  return verify(null, Buffer.from(canonicalSignedDocument(bundle), "utf8"), publicKey, signature);
}

export function canonicalSignedDocument(bundle: ApprovalBundle): string {
  return canonicalizeJson({
    schemaVersion: bundle.schemaVersion,
    approvalId: bundle.approvalId,
    approvedBy: bundle.approvedBy,
    issuedAt: bundle.issuedAt,
    expiresAt: bundle.expiresAt,
    operations: bundle.operations.map((operation) => ({
      verb: operation.verb,
      targetFingerprint: operation.targetFingerprint,
      deploymentRole: operation.deploymentRole,
      operationId: operation.operationId,
      payloadDigest: operation.payloadDigest,
      manifestDigest: operation.manifestDigest,
      expectedPolicyEpoch: operation.expectedPolicyEpoch,
    })),
  });
}

/** Accept only explicit Ed25519 public-key material. */
export function approvalPublicKey(pem: string): KeyObject | "INVALID_CONFIG" {
  try {
    createPrivateKey(pem);
    return "INVALID_CONFIG";
  } catch {
    // A public key does not parse as a private key.
  }
  try {
    const key = createPublicKey(pem);
    return key.type === "public" && key.asymmetricKeyType === "ed25519" ? key : "INVALID_CONFIG";
  } catch {
    return "INVALID_CONFIG";
  }
}

/** Check invocation fields after signature verification. */
export function checkApproval(bundle: ApprovalBundle, check: ApprovalCheck): ApprovalOperation | ApprovalRejection {
  const now = Math.floor(check.now.getTime() / 1000);
  if (!Number.isSafeInteger(now) || bundle.expiresAt <= now) return "APPROVAL_EXPIRED";
  const sameVerb = bundle.operations.filter((operation) => operation.verb === check.verb);
  const matched = bundle.operations.filter(
    (operation) => operation.verb === check.verb && operation.operationId === check.operationId,
  );
  if (matched.length !== 1) {
    return sameVerb.length > 0 ? "APPROVAL_OPERATION_MISMATCH" : "APPROVAL_VERB_MISMATCH";
  }
  const operation = matched[0];
  if (!operation) return "APPROVAL_VERB_MISMATCH";
  if (operation.targetFingerprint !== check.targetFingerprint) return "APPROVAL_TARGET_MISMATCH";
  if (operation.deploymentRole !== check.deploymentRole) return "APPROVAL_ROLE_MISMATCH";
  if (operation.manifestDigest !== check.manifestDigest) return "APPROVAL_MANIFEST_MISMATCH";
  if (
    operation.payloadDigest !== check.payloadDigest ||
    operation.expectedPolicyEpoch !== check.expectedPolicyEpoch
  ) return "APPROVAL_DIGEST_MISMATCH";
  return operation;
}

function parseOperation(value: unknown): ApprovalOperation | ApprovalRejection {
  if (!isRecord(value) || !sameKeys(value, OPERATION_KEYS)) return "APPROVAL_MALFORMED";
  if (
    !isNonBlank(value.verb) || !isNonBlank(value.targetFingerprint) ||
    !isNonBlank(value.deploymentRole) || !isUuid(value.operationId) ||
    !isSha256(value.payloadDigest) ||
    !(value.manifestDigest === null || isSha256(value.manifestDigest)) ||
    !isUnixSeconds(value.expectedPolicyEpoch)
  ) return "APPROVAL_MALFORMED";
  return {
    verb: value.verb,
    targetFingerprint: value.targetFingerprint,
    deploymentRole: value.deploymentRole,
    operationId: value.operationId,
    payloadDigest: value.payloadDigest,
    manifestDigest: value.manifestDigest,
    expectedPolicyEpoch: value.expectedPolicyEpoch,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}
function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
function isUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function isStandardBase64(value: unknown, decodedLength: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return false;
  }
  return Buffer.from(value, "base64").length === decodedLength;
}
