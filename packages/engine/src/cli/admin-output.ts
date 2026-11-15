// megaui-only (FS-82): stable machine output and approval request schema.
import { z } from "zod";
import { validAppliedRows } from "@megaui/database";
import { approvalRequestSchema, type ApprovalRequest } from "./admin-request";
export { approvalRequestSchema, adminFilesystemErrorKey, type ApprovalRequest } from "./admin-request";

const resultCounts = z.record(z.string(), z.number().int().nonnegative());
const mutationOutputV1 = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().uuid(),
  policyEpoch: z.number().int().nonnegative(),
  resultCounts,
  replayed: z.boolean(),
}).strict();

const mutationOutputV2 = mutationOutputV1.extend({
  schemaVersion: z.literal(2),
  provisioned: z.array(z.object({ row: z.number().int(),
    localUserId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  }).strict()).min(1).max(100),
}).strict().refine(value => Object.keys(value.resultCounts).length === 1 &&
  value.resultCounts.created === value.provisioned.length &&
  value.provisioned.every((row, index) => row.row === index + 1) &&
  new Set(value.provisioned.map(row => row.localUserId.toLowerCase())).size === value.provisioned.length);
const mutationOutputV3 = mutationOutputV1.extend({
  schemaVersion: z.literal(3),
  applied: z.array(z.object({ row: z.number().int(), localUserId: z.string() }).strict()).min(1).max(100),
}).strict().refine(value => validAppliedRows(value.applied, value.resultCounts));
export const adminMutationOutputSchema = z.union([mutationOutputV1, mutationOutputV2, mutationOutputV3]);

export type AdminMutationOutput = z.infer<typeof adminMutationOutputSchema>;

export const adminErrorExitCodes = {
  UNKNOWN_VERB: 2,
  MISSING_ARGUMENT: 2,
  UNKNOWN_FLAG: 2,
  DUPLICATE_FLAG: 2,
  INVALID_ARGUMENT: 2,
  MISSING_CONFIG: 2,
  INVALID_CONFIG: 2,
  APPROVAL_MALFORMED: 2,
  APPROVAL_SIGNATURE_INVALID: 3,
  APPROVAL_VERB_MISMATCH: 3,
  APPROVAL_TARGET_MISMATCH: 3,
  APPROVAL_OPERATION_MISMATCH: 3,
  APPROVAL_MANIFEST_MISMATCH: 3,
  APPROVAL_EXPIRED: 3,
  APPROVAL_DIGEST_MISMATCH: 3,
  APPROVAL_ROLE_MISMATCH: 3,
  SCOPE_REJECTED: 3,
  EPOCH_CAS_MISMATCH: 3,
  OPERATION_PAYLOAD_MISMATCH: 3,
  ACTOR_SOURCE_REJECTED: 3,
  PROVISION_REJECTED: 3,
  MIGRATION_REJECTED: 3,
  QUARANTINE_REJECTED: 3,
  REPAIR_REJECTED: 3,
  DEPENDENCY_FAILED: 4,
} as const;

export function adminErrorExitCode(key: string): number {
  return adminErrorExitCodes[key as keyof typeof adminErrorExitCodes] ?? 4;
}

export function adminSuccessJson(output: AdminMutationOutput): string {
  return `${JSON.stringify(adminMutationOutputSchema.parse(output))}\n`;
}

export function approvalRequestJson(request: ApprovalRequest): string {
  return `${JSON.stringify(approvalRequestSchema.parse(request))}\n`;
}
