// megaui-only
import { z } from "zod";

export const ORION_V1_NAMESPACE = "orion.v1" as const;
export const ORION_V1_SCHEMA_VERSION = 1 as const;

export const ORION_HTTP_SCOPES = ["task.read", "task.write", "log.read"] as const;
export type OrionHttpScope = (typeof ORION_HTTP_SCOPES)[number];

export const ORION_TASK_STATUSES = [
  "pending",
  "leased",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type OrionTaskStatus = (typeof ORION_TASK_STATUSES)[number];

export const ORION_TARGET_STATUSES = [
  "pending",
  "running",
  "success",
  "failed",
] as const;
export type OrionTargetStatus = (typeof ORION_TARGET_STATUSES)[number];

export const ORION_WORKER_STATUSES = [
  "connected",
  "disconnected",
  "revoked",
] as const;
export type OrionWorkerStatus = (typeof ORION_WORKER_STATUSES)[number];

const ORION_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPO_PATH_REGEX = /^\/[A-Za-z0-9._/-]{0,511}$/;
const COMMIT_SHA_REGEX = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const REF_NAME_REGEX = /^[^-\s\\][^\s\\]{0,255}$/;

export function isValidOrionId(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    !value.includes("..") &&
    ORION_ID_REGEX.test(value)
  );
}

/** Matches `orion_contracts::ids::validate_target` verbatim. */
export function isValidOrionTarget(value: string): boolean {
  return (
    value.startsWith("//") &&
    !value.includes("..") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= 256
  );
}

export const orionIdSchema = z
  .string()
  .refine(isValidOrionId, "Invalid Orion identifier");

export const orionTargetSchema = z
  .string()
  .refine(isValidOrionTarget, "Invalid Buck2 target");

export const orionTaskStatusSchema = z.enum(ORION_TASK_STATUSES);
export const orionTargetStatusSchema = z.enum(ORION_TARGET_STATUSES);
export const orionWorkerStatusSchema = z.enum(ORION_WORKER_STATUSES);
export const orionTimestampSchema = z
  .string()
  .min(20)
  .refine((v) => v.includes("T"), "Expected RFC3339 timestamp");

const orionNamespaceSchema = z.literal(ORION_V1_NAMESPACE);
const orionVersionSchema = z.literal(ORION_V1_SCHEMA_VERSION);

function hasDisallowedRefControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0xfeff) {
      return true;
    }
  }
  return false;
}

export const taskSourceRefSchema = z
  .object({
    repo_path: z
      .string()
      .min(1)
      .max(512)
      .regex(REPO_PATH_REGEX)
      .refine((v) => !v.includes(".."), "repo_path must not contain '..'"),
    commit_sha: z.string().regex(COMMIT_SHA_REGEX),
    cl_link: orionIdSchema.optional(),
    ref_name: z
      .string()
      .min(1)
      .max(256)
      .regex(REF_NAME_REGEX)
      .refine(
        (v) =>
          Buffer.byteLength(v, "utf8") <= 256 &&
          !v.includes("..") &&
          !hasDisallowedRefControlChar(v),
        "Invalid ref_name",
      )
      .optional(),
    head_revision: z.number().int().min(1).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.head_revision !== undefined && val.cl_link === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "head_revision is only allowed when cl_link is set",
        path: ["head_revision"],
      });
    }
  });
export type TaskSourceRef = z.infer<typeof taskSourceRefSchema>;

export const taskCreateSourceRefSchema = taskSourceRefSchema.superRefine(
  (val, ctx) => {
    if (val.cl_link !== undefined && val.head_revision === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "head_revision is required when cl_link is set",
        path: ["head_revision"],
      });
    }
  },
);

export const taskSummaryItemSchema = z
  .object({
    namespace: orionNamespaceSchema,
    version: orionVersionSchema,
    task_id: orionIdSchema,
    attempt_id: orionIdSchema,
    matched_attempt_id: orionIdSchema.optional(),
    status: z.string().min(1),
    targets: z.array(orionTargetSchema).min(1),
    source: taskSourceRefSchema.optional(),
    created_at: orionTimestampSchema,
    updated_at: orionTimestampSchema,
  })
  .strict();
export type TaskSummaryItem = z.infer<typeof taskSummaryItemSchema>;

export const taskListResponseSchema = z
  .object({
    namespace: orionNamespaceSchema,
    version: orionVersionSchema,
    items: z.array(taskSummaryItemSchema),
    next_cursor: z.string().min(1).nullable(),
  })
  .strict();
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;

export const taskGetResponseSchema = z
  .object({
    namespace: orionNamespaceSchema,
    version: orionVersionSchema,
    task_id: orionIdSchema,
    attempt_id: orionIdSchema,
    status: z.string().min(1),
    targets: z.array(orionTargetSchema).min(1),
    source: taskSourceRefSchema.optional(),
    created_at: orionTimestampSchema,
    updated_at: orionTimestampSchema,
  })
  .strict();
export type TaskGetResponse = z.infer<typeof taskGetResponseSchema>;

export const taskCreateRequestSchema = z
  .object({
    namespace: orionNamespaceSchema,
    version: orionVersionSchema,
    environment_id: orionIdSchema,
    targets: z.array(orionTargetSchema).min(1),
    source: taskCreateSourceRefSchema.optional(),
  })
  .strict();
export type TaskCreateRequest = z.infer<typeof taskCreateRequestSchema>;

export const taskCreateResponseSchema = z
  .object({
    namespace: orionNamespaceSchema,
    version: orionVersionSchema,
    task_id: orionIdSchema,
    attempt_id: orionIdSchema,
    status: z.literal("accepted"),
  })
  .strict();
export type TaskCreateResponse = z.infer<typeof taskCreateResponseSchema>;

export const retryRequestSchema = z
  .object({
    namespace: orionNamespaceSchema,
    version: orionVersionSchema,
  })
  .strict();
export type RetryRequest = z.infer<typeof retryRequestSchema>;

export const retryResponseSchema = z
  .object({
    namespace: orionNamespaceSchema,
    version: orionVersionSchema,
    task_id: orionIdSchema,
    attempt_id: orionIdSchema,
    status: z.literal("accepted"),
  })
  .strict();
export type RetryResponse = z.infer<typeof retryResponseSchema>;

export const taskCancelResponseSchema = z
  .object({
    namespace: orionNamespaceSchema,
    version: orionVersionSchema,
    task_id: orionIdSchema,
    attempt_id: orionIdSchema.optional(),
    status: z.literal("cancelled"),
  })
  .strict();
export type TaskCancelResponse = z.infer<typeof taskCancelResponseSchema>;

export const targetStatusItemSchema = z
  .object({
    namespace: orionNamespaceSchema,
    version: orionVersionSchema,
    status_id: orionIdSchema,
    attempt_id: orionIdSchema,
    task_id: orionIdSchema,
    target_path: orionTargetSchema,
    target_package: z.string(),
    target_name: z.string(),
    target_configuration: z.string(),
    category: z.string(),
    identifier: z.string(),
    action: z.string(),
    status: orionTargetStatusSchema,
    created_at: orionTimestampSchema,
    updated_at: orionTimestampSchema,
  })
  .strict();
export type TargetStatusItem = z.infer<typeof targetStatusItemSchema>;

export const targetStatusListResponseSchema = z
  .object({
    namespace: orionNamespaceSchema,
    version: orionVersionSchema,
    items: z.array(targetStatusItemSchema),
    next_cursor: z.string().min(1).nullable(),
  })
  .strict();
export type TargetStatusListResponse = z.infer<
  typeof targetStatusListResponseSchema
>;

export const workerSessionItemSchema = z
  .object({
    namespace: orionNamespaceSchema,
    version: orionVersionSchema,
    session_id: orionIdSchema,
    worker_id: orionIdSchema,
    hostname: orionIdSchema,
    status: orionWorkerStatusSchema,
    connected: z.boolean(),
    last_seen_at: orionTimestampSchema,
    connected_at: orionTimestampSchema,
  })
  .strict();
export type WorkerSessionItem = z.infer<typeof workerSessionItemSchema>;

export const workerSessionListResponseSchema = z
  .object({
    namespace: orionNamespaceSchema,
    version: orionVersionSchema,
    items: z.array(workerSessionItemSchema),
    next_cursor: z.string().min(1).nullable(),
  })
  .strict();
export type WorkerSessionListResponse = z.infer<
  typeof workerSessionListResponseSchema
>;

export const errorBodySchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    request_id: orionIdSchema.optional(),
  })
  .strict();

export const errorEnvelopeSchema = z
  .object({
    namespace: orionNamespaceSchema,
    version: orionVersionSchema,
    error: errorBodySchema,
  })
  .strict();
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export class OrionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrionConfigError";
  }
}

export class OrionClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly isRetryable: boolean;

  constructor(params: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
    isRetryable?: boolean;
  }) {
    super(params.message);
    this.name = "OrionClientError";
    this.status = params.status;
    this.code = params.code;
    this.requestId = params.requestId;
    this.isRetryable =
      params.isRetryable ?? (params.status === 429 || params.status >= 500);
  }
}
