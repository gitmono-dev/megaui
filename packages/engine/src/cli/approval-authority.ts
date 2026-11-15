// megaui-only (FS-85): offline authority signs verified approval requests.
// This module intentionally has no database, environment, or admin-dispatch imports.
import { createPrivateKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

import {
  canonicalSignedDocument,
  parseApprovalBundle,
  type ApprovalBundle,
} from "./admin-approval-verifier";
import { adminFilesystemErrorKey, approvalRequestSchema } from "./admin-request";
import { payloadDigest } from "./admin-payload";

type AuthorityError =
  | "AUTHORITY_ARGUMENTS"
  | "AUTHORITY_REQUEST_INVALID"
  | "AUTHORITY_KEY_INVALID"
  | "AUTHORITY_APPROVER_INVALID"
  | "AUTHORITY_EXPIRY_INVALID"
  | "AUTHORITY_IO_FAILED";

export interface ApprovalAuthorityOptions {
  readonly argv: readonly string[];
  readonly now?: () => Date;
  readonly newApprovalId?: () => string;
  readonly io?: {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
  };
}

interface AuthorityArguments {
  readonly requestPath: string;
  readonly keyPath: string;
  readonly approvedBy: string;
  readonly expiresAt: number;
  readonly outputPath: string;
}

const allowedFlags = new Set(["request", "key-file", "approved-by", "expires-at", "out"]);

/** Signs exactly one independently validated FS-82 request, without loading application configuration. */
export function runApprovalAuthority(options: ApprovalAuthorityOptions): number {
  const io = options.io ?? { stdout: (text: string) => process.stdout.write(text), stderr: (text: string) => process.stderr.write(text) };
  const now = options.now ?? (() => new Date());
  const parsed = parseArguments(options.argv, now());
  if (typeof parsed === "string") return fail(io, parsed);

  const requestText = readText(parsed.requestPath);
  if (!requestText.ok) return fail(io, requestText.error);
  let rawRequest: unknown;
  try {
    rawRequest = JSON.parse(requestText.text);
  } catch {
    return fail(io, "AUTHORITY_REQUEST_INVALID");
  }
  const request = approvalRequestSchema.safeParse(rawRequest);
  if (!request.success) return fail(io, "AUTHORITY_REQUEST_INVALID");
  try {
    const digest = payloadDigest({
      verb: request.data.verb,
      targetFingerprint: request.data.targetFingerprint,
      deploymentRole: request.data.deploymentRole,
      operationId: request.data.operationId,
      expectedPolicyEpoch: request.data.expectedPolicyEpoch,
      args: request.data.args,
      inputFiles: request.data.inputFiles,
    });
    if (digest !== request.data.payloadDigest) return fail(io, "AUTHORITY_REQUEST_INVALID");
  } catch {
    return fail(io, "AUTHORITY_REQUEST_INVALID");
  }

  const privatePem = readText(parsed.keyPath);
  if (!privatePem.ok) return fail(io, privatePem.error);
  const privateKey = ed25519PrivateKey(privatePem.text);
  if (typeof privateKey === "string") return fail(io, privateKey);

  const issuedAt = Math.floor(now().getTime() / 1_000);
  if (!Number.isSafeInteger(issuedAt) || parsed.expiresAt <= issuedAt) return fail(io, "AUTHORITY_EXPIRY_INVALID");
  const unsigned: ApprovalBundle = {
    schemaVersion: 1,
    approvalId: options.newApprovalId?.() ?? randomUUID(),
    approvedBy: parsed.approvedBy,
    issuedAt,
    expiresAt: parsed.expiresAt,
    operations: [{
      verb: request.data.verb,
      targetFingerprint: request.data.targetFingerprint,
      deploymentRole: request.data.deploymentRole,
      operationId: request.data.operationId,
      payloadDigest: request.data.payloadDigest,
      manifestDigest: request.data.manifestDigest,
      expectedPolicyEpoch: request.data.expectedPolicyEpoch,
    }],
    signature: "",
  };
  const parsedBundle = parseApprovalBundle(unsigned);
  if (typeof parsedBundle === "string") return fail(io, "AUTHORITY_REQUEST_INVALID");
  let bundle: ApprovalBundle;
  try {
    bundle = {
      ...parsedBundle,
      signature: sign(null, Buffer.from(canonicalSignedDocument(parsedBundle), "utf8"), privateKey).toString("base64"),
    };
  } catch {
    return fail(io, "AUTHORITY_IO_FAILED");
  }
  const output = JSON.stringify(bundle);
  try {
    writeFileSync(parsed.outputPath, output, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    return fail(io, adminFilesystemErrorKey(error) === "INVALID_ARGUMENT" ? "AUTHORITY_ARGUMENTS" : "AUTHORITY_IO_FAILED");
  }
  io.stdout(`${JSON.stringify({
    schemaVersion: 1,
    approvalId: bundle.approvalId,
    operationId: request.data.operationId,
    expiresAt: bundle.expiresAt,
  })}\n`);
  return 0;
}

function parseArguments(argv: readonly string[], now: Date): AuthorityArguments | AuthorityError {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--") || flag === "--") return "AUTHORITY_ARGUMENTS";
    const name = flag.slice(2);
    if (!allowedFlags.has(name) || values.has(name)) return "AUTHORITY_ARGUMENTS";
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return "AUTHORITY_ARGUMENTS";
    values.set(name, value);
    index += 1;
  }
  if (values.size !== allowedFlags.size) return "AUTHORITY_ARGUMENTS";
  const requestPath = values.get("request");
  const keyPath = values.get("key-file");
  const approvedBy = values.get("approved-by");
  const expiresAtText = values.get("expires-at");
  const outputPath = values.get("out");
  if (!requestPath || !keyPath || !approvedBy || !expiresAtText || !outputPath) return "AUTHORITY_ARGUMENTS";
  if (!isSafePath(requestPath) || !isSafePath(keyPath) || !isSafePath(outputPath)) return "AUTHORITY_ARGUMENTS";
  if (approvedBy.trim() !== approvedBy || approvedBy.trim() === "" || /[\r\n\0]/.test(approvedBy)) {
    return "AUTHORITY_APPROVER_INVALID";
  }
  const expiresAt = parseFutureUtcSeconds(expiresAtText, now);
  if (expiresAt === undefined) return "AUTHORITY_EXPIRY_INVALID";
  return { requestPath, keyPath, approvedBy, expiresAt, outputPath };
}

function isSafePath(value: string): boolean {
  return isAbsolute(value) && isWellFormedUnicode(value) && !value.includes("\0") && !value.split(sep).includes("..");
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function parseFutureUtcSeconds(value: string, now: Date): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().replace(".000Z", "Z") !== value) return undefined;
  const seconds = Math.floor(date.getTime() / 1_000);
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  return Number.isSafeInteger(seconds) && Number.isSafeInteger(nowSeconds) && seconds > nowSeconds ? seconds : undefined;
}

function readText(path: string): { ok: true; text: string } | { ok: false; error: AuthorityError } {
  try {
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (error) {
    return {
      ok: false,
      error: adminFilesystemErrorKey(error) === "INVALID_ARGUMENT" ? "AUTHORITY_ARGUMENTS" : "AUTHORITY_IO_FAILED",
    };
  }
}

function ed25519PrivateKey(pem: string): KeyObject | "AUTHORITY_KEY_INVALID" {
  try {
    const key = createPrivateKey(pem);
    return key.type === "private" && key.asymmetricKeyType === "ed25519" ? key : "AUTHORITY_KEY_INVALID";
  } catch {
    return "AUTHORITY_KEY_INVALID";
  }
}

function fail(io: NonNullable<ApprovalAuthorityOptions["io"]>, key: AuthorityError): number {
  io.stderr(`error: ${key}\n`);
  return key === "AUTHORITY_IO_FAILED" ? 4 : 2;
}

if (process.argv[1]?.endsWith("approval-authority.ts")) {
  process.exitCode = runApprovalAuthority({ argv: process.argv.slice(2) });
}
