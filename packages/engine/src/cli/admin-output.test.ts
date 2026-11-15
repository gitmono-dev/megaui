// FS-82: output schema and exit-code unit coverage.
import { expect, it } from "vitest";
import { validProvisionedRows, validAppliedRows } from "@megaui/database";

import {
  adminErrorExitCode,
  adminFilesystemErrorKey,
  adminSuccessJson,
  approvalRequestJson,
} from "./admin-output";

const operationId = "00000000-0000-4000-8000-000000000082";
const digest = "a".repeat(64);

it("keeps quarantine and repair failures bounded and private audit out of public v1", () => {
  for (const key of ["QUARANTINE_REJECTED", "REPAIR_REJECTED"]) expect(adminErrorExitCode(key)).toBe(3);
  const counts: Record<string, number>[] = [{ quarantined: 0 }, { repaired: 1 }];
  for (const resultCounts of counts) {
    const output = { schemaVersion: 1 as const, operationId, policyEpoch: 3, replayed: false, resultCounts };
    expect(JSON.parse(adminSuccessJson(output))).toEqual(output);
    expect(() => adminSuccessJson({ ...output, affected: [] } as never)).toThrow();
  }
});

it("preserves text IDs and global fixed-batch rows in strict apply v3 results", () => {
  const applied = [{ row: 101, localUserId: "历史-A" }, { row: 102, localUserId: "历史-a" }];
  const valid = { schemaVersion: 3, operationId, policyEpoch: 3, replayed: false,
    resultCounts: { bound: 2 }, applied };
  expect(JSON.parse(adminSuccessJson(valid as never))).toEqual(valid);
  expect(validAppliedRows(applied, valid.resultCounts, applied)).toBe(true);
  expect(validAppliedRows(applied, valid.resultCounts, [{ ...applied[0]!, localUserId: "different" }, applied[1]!])).toBe(false);
  expect(validAppliedRows(new Array(2), valid.resultCounts)).toBe(false);
  for (const changed of [
    { applied: [] }, { applied: applied.slice(0, 1) }, { applied: [...applied].reverse() },
    { applied: [{ ...applied[0], row: 100 }, applied[1]] },
    { applied: [{ ...applied[0], row: 10001 }, { ...applied[1], row: 10002 }] },
    { applied: [applied[0], { ...applied[1], localUserId: applied[0]!.localUserId }] },
    { applied: applied.map(row => ({ ...row, openId: "private" })) },
    ...["", " \n", "\0", "\ud800", "😀".repeat(257)].map(localUserId => ({ applied: [{ ...applied[0], localUserId }, applied[1]] })),
    { applied: Array.from({ length: 101 }, (_, i) => ({ row: i + 1, localUserId: String(i) })), resultCounts: { bound: 101 } },
    { resultCounts: { bound: 1 } }, { resultCounts: { bound: 2, created: 2 } },
    { schemaVersion: 1 }, { schemaVersion: 2 }, { provisioned: applied },
  ]) expect(() => adminSuccessJson({ ...valid, ...changed } as never)).toThrow();
  expect(adminErrorExitCode("MIGRATION_REJECTED")).toBe(3);
});

it("returns bounded provision v2 row/id mappings while rejecting malformed mappings", () => {
  const valid = { schemaVersion: 2, operationId, policyEpoch: 3, resultCounts: { created: 2 }, replayed: false,
    provisioned: [{ row: 1, localUserId: operationId },
      { row: 2, localUserId: "00000000-0000-4000-8000-000000000083" }] };
  expect(JSON.parse(adminSuccessJson(valid as never))).toEqual(valid);
  for (const changed of [
    { provisioned: [] }, { provisioned: valid.provisioned.slice(0, 1) },
    { provisioned: [{ ...valid.provisioned[0], row: 2 }, valid.provisioned[1]] },
    { provisioned: [valid.provisioned[0], { ...valid.provisioned[0], row: 2 }] },
    { provisioned: [{ row: 1, localUserId: "not-a-uuid" }, valid.provisioned[1]] },
    { provisioned: valid.provisioned.map(row => ({ ...row, openId: "private" })) },
    { resultCounts: { created: 1 } }, { resultCounts: { created: 2, private: 1 } },
    { schemaVersion: 1 },
  ]) expect(() => adminSuccessJson({ ...valid, ...changed } as never)).toThrow();
  expect(adminErrorExitCode("PROVISION_REJECTED")).toBe(3);
  expect(validProvisionedRows(new Array(2), { created: 2 }, 2)).toBe(false);
});

it("serializes the exact success schema and never a secret-like result count", () => {
  const text = adminSuccessJson({
    schemaVersion: 1,
    operationId,
    policyEpoch: 7,
    resultCounts: { users: 2 },
    replayed: false,
  });
  expect(JSON.parse(text)).toEqual({
    schemaVersion: 1,
    operationId,
    policyEpoch: 7,
    resultCounts: { users: 2 },
    replayed: false,
  });
  expect(Object.keys(JSON.parse(text)).sort()).toEqual([
    "operationId", "policyEpoch", "replayed", "resultCounts", "schemaVersion",
  ].sort());
});

it("rejects an invalid success shape", () => {
  expect(() => adminSuccessJson({
    schemaVersion: 1,
    operationId,
    policyEpoch: 1,
    resultCounts: { secret: "value" } as never,
    replayed: false,
  })).toThrow();
});

it("maps every frozen error class", () => {
  for (const [key, code] of [
    ["UNKNOWN_VERB", 2],
    ["MISSING_ARGUMENT", 2],
    ["UNKNOWN_FLAG", 2],
    ["DUPLICATE_FLAG", 2],
    ["INVALID_ARGUMENT", 2],
    ["MISSING_CONFIG", 2],
    ["INVALID_CONFIG", 2],
    ["APPROVAL_MALFORMED", 2],
    ["APPROVAL_SIGNATURE_INVALID", 3],
    ["APPROVAL_TARGET_MISMATCH", 3],
    ["SCOPE_REJECTED", 3],
    ["EPOCH_CAS_MISMATCH", 3],
    ["OPERATION_PAYLOAD_MISMATCH", 3],
    ["DEPENDENCY_FAILED", 4],
  ] as const) {
    expect(adminErrorExitCode(key)).toBe(code);
  }
});

it("keeps filesystem resource failures retryable without exposing OS details", () => {
  for (const code of ["ENOSPC", "EIO", "EMFILE", "ENFILE", "EAGAIN"] as const) {
    expect(adminFilesystemErrorKey({ code })).toBe("DEPENDENCY_FAILED");
  }
  for (const code of ["EEXIST", "ENOENT", "ENOTDIR", "ELOOP", "ERR_INVALID_ARG_VALUE"] as const) {
    expect(adminFilesystemErrorKey({ code })).toBe("INVALID_ARGUMENT");
  }
  expect(adminFilesystemErrorKey(new Error("unclassified output error"))).toBe("DEPENDENCY_FAILED");
});

it("serializes the flat request with separate payload digest and manifest digest", () => {
  const request = JSON.parse(approvalRequestJson({
    schemaVersion: 1,
    verb: "fixture-write",
    targetFingerprint: "megaui:instance:test",
    deploymentRole: "test",
    operationId,
    payloadDigest: digest,
    manifestDigest: null,
    expectedPolicyEpoch: 0,
    args: { target: "instance", "operation-id": operationId, "expect-policy-epoch": 0 },
    inputFiles: {},
  }));
  expect(Object.keys(request)).toHaveLength(10);
  expect(request.payloadDigest).toBe(digest);
  expect(request.manifestDigest).toBeNull();
  expect(request.args.target).toBe("instance");
});

it("accepts a request containing a canonical manifest digest", () => {
  const request = JSON.parse(approvalRequestJson({
    schemaVersion: 1,
    verb: "quarantine",
    targetFingerprint: "megaui:instance:test",
    deploymentRole: "test",
    operationId,
    payloadDigest: digest,
    manifestDigest: digest,
    expectedPolicyEpoch: 3,
    args: {
      target: "instance",
      "operation-id": operationId,
      "expect-policy-epoch": 3,
      manifest: "/tmp/members.json",
      digest,
    },
    inputFiles: { manifest: digest },
  }));
  expect(request.args.digest).toBe(digest);
  expect(request.manifestDigest).toBe(digest);
});

it("rejects request relationship tampering and unsafe epochs", () => {
  const request = {
    schemaVersion: 1 as const,
    verb: "fixture-write",
    targetFingerprint: "megaui:instance:test",
    deploymentRole: "test",
    operationId,
    payloadDigest: digest,
    manifestDigest: null,
    expectedPolicyEpoch: 3,
    args: { target: "instance", "operation-id": operationId, "expect-policy-epoch": 3 },
    inputFiles: {},
  };
  expect(() => approvalRequestJson({ ...request, args: { ...request.args, "operation-id": "00000000-0000-4000-8000-000000000099" } })).toThrow();
  expect(() => approvalRequestJson({ ...request, args: { ...request.args, "expect-policy-epoch": 4 } })).toThrow();
  expect(() => approvalRequestJson({ ...request, expectedPolicyEpoch: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  expect(() => approvalRequestJson({ ...request, manifestDigest: digest, args: { ...request.args, digest: "b".repeat(64) } })).toThrow();
});
it("rejects unexpected request fields", () => {
  expect(() => approvalRequestJson({
    schemaVersion: 1,
    verb: "fixture-write",
    targetFingerprint: "megaui:instance:test",
    deploymentRole: "test",
    operationId,
    payloadDigest: digest,
    manifestDigest: null,
    expectedPolicyEpoch: 0,
    args: {},
    inputFiles: {},
    signature: "not-allowed",
  } as never)).toThrow();
});
