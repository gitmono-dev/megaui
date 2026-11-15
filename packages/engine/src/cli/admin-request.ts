// megaui-only (FS-06): pure approval requests shared with the offline authority.
import { z } from "zod";

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export interface ApprovalRequest {
  schemaVersion: 1;
  verb: string;
  targetFingerprint: string;
  deploymentRole: string;
  operationId: string;
  payloadDigest: string;
  manifestDigest: string | null;
  expectedPolicyEpoch: number;
  args: Readonly<Record<string, string | number>>;
  inputFiles: Readonly<Record<string, string>>;
}

export const approvalRequestSchema = z.object({
  schemaVersion: z.literal(1),
  verb: z.string().min(1),
  targetFingerprint: z.string().min(1),
  deploymentRole: z.string().min(1),
  operationId: z.string().uuid(),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  expectedPolicyEpoch: safeInteger,
  args: z.record(z.string(), z.union([z.string(), safeInteger])),
  inputFiles: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
}).strict().superRefine((request, context) => {
  if (typeof request.args.target !== "string" ||
    !request.targetFingerprint.endsWith(`:${request.args.target}:${request.deploymentRole}`)) {
    context.addIssue({ code: "custom", message: "args.target does not match the instance" });
  }
  if (request.args["operation-id"] !== request.operationId) {
    context.addIssue({ code: "custom", message: "operation id differs from its normalized argument" });
  }
  if (request.args["expect-policy-epoch"] !== request.expectedPolicyEpoch) {
    context.addIssue({ code: "custom", message: "epoch differs from its normalized argument" });
  }
  if (request.manifestDigest !== null && request.args.digest !== request.manifestDigest) {
    context.addIssue({ code: "custom", message: "manifest digest differs from its normalized argument" });
  }
});

/**
 * A missing or invalid operator path is input; every other filesystem failure
 * is an unavailable local dependency. Keep the
 * underlying errno out of the machine-facing error contract.
 */
export function adminFilesystemErrorKey(error: unknown): "INVALID_ARGUMENT" | "DEPENDENCY_FAILED" {
  const code = typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : undefined;
  if (["EEXIST", "ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "EINVAL", "ENAMETOOLONG", "ERR_INVALID_ARG_VALUE"].includes(code ?? "")) {
    return "INVALID_ARGUMENT";
  }
  return "DEPENDENCY_FAILED";
}
