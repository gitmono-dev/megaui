// megaui-only (FS-80): canonical approval payload has no upstream counterpart.
// FS-80: canonical payload digest shared by approval requests and execution.
//
// The serializer is the native ECMAScript JSON subset of RFC 8785: object keys
// are sorted by UTF-16 code units and primitives use JSON.stringify. It rejects
// values JSON cannot represent without changing them. No third-party codec.

import { createHash } from "node:crypto";

export const PAYLOAD_DIGEST_SCHEMA_VERSION = 1;

export interface PayloadDigestInput {
  verb: string;
  targetFingerprint: string;
  deploymentRole: string;
  operationId: string;
  expectedPolicyEpoch: number;
  args: Readonly<Record<string, string | number | boolean | null>>;
  inputFiles: Readonly<Record<string, string>>;
}

/** Serializes a JSON value with RFC 8785 key ordering. */
export function canonicalizeJson(value: unknown): string {
  return serializeJson(value);
}

/** SHA-256 hex of the canonical payload, including every defaulted arg. */
export function payloadDigest(input: PayloadDigestInput): string {
  const canonical = canonicalizeJson({
    schemaVersion: PAYLOAD_DIGEST_SCHEMA_VERSION,
    verb: input.verb,
    targetFingerprint: input.targetFingerprint,
    deploymentRole: input.deploymentRole,
    operationId: input.operationId,
    expectedPolicyEpoch: input.expectedPolicyEpoch,
    args: input.args,
    inputFiles: input.inputFiles,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function serializeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertWellFormedUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("[@megaui/engine] canonical JSON rejects a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    assertDenseArray(value);
    return `[${value.map((item) => serializeJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("[@megaui/engine] canonical JSON rejects an unsupported object");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => {
        assertWellFormedUnicode(key);
        if (record[key] === undefined) {
          throw new Error("[@megaui/engine] canonical JSON rejects an undefined value");
        }
        return `${JSON.stringify(key)}:${serializeJson(record[key])}`;
      })
      .join(",")}}`;
  }
  throw new Error("[@megaui/engine] canonical JSON rejects an unsupported value");
}

function assertDenseArray(value: unknown[]): void {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new Error("[@megaui/engine] canonical JSON rejects a sparse array");
    }
  }
  for (const key of Object.keys(value)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      throw new Error("[@megaui/engine] canonical JSON rejects a sparse array");
    }
  }
}

/** RFC 8785 rejects unpaired UTF-16 surrogates instead of escaping them. */
function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new Error("[@megaui/engine] canonical JSON rejects an unpaired surrogate");
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("[@megaui/engine] canonical JSON rejects an unpaired surrogate");
    }
  }
}
