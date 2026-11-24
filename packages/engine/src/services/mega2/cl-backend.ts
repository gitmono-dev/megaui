import { z } from "zod";
import {
  MegaBadRequestError,
  MegaConflictError,
  MegaError,
  MegaForbiddenError,
  MegaInternalError,
  MegaNotFoundError,
  MegaUnauthorizedError,
} from "../../errors";
import {
  DEFAULT_MEGA2_TIMEOUT_MS,
  resolveMega2BaseUrl,
  type Mega2RequestOptions,
} from "./client";
import { commonResultWireSchema } from "./types";

export const MAX_MEGA2_CL_PER_PAGE = 50;

export const mega2MergeStatusSchema = z.enum([
  "Open",
  "Merged",
  "Closed",
  "Draft",
]);
export type Mega2MergeStatus = z.output<typeof mega2MergeStatusSchema>;

export const mega2ConvTypeSchema = z.enum([
  "Comment",
  "Deploy",
  "Commit",
  "ForcePush",
  "Edit",
  "Review",
  "Approve",
  "MergeQueue",
  "Merged",
  "Closed",
  "Reopen",
  "Label",
  "Assignee",
  "Mention",
  "Draft",
]);
export type Mega2ConvType = z.output<typeof mega2ConvTypeSchema>;

export const mega2CheckTypeSchema = z.enum([
  "GpgSignature",
  "BranchProtection",
  "CommitMessage",
  "ClSync",
  "MergeConflict",
  "CiStatus",
]);
export type Mega2CheckType = z.output<typeof mega2CheckTypeSchema>;

export const mega2ClFileActionSchema = z.enum([
  "new",
  "deleted",
  "modified",
  "renamed",
]);
export type Mega2ClFileAction = z.output<typeof mega2ClFileActionSchema>;

export function mega2CommonPageSchema<Schema extends z.ZodTypeAny>(
  itemSchema: Schema,
) {
  return z
    .object({
      total: z.number().int().nonnegative(),
      items: z.array(itemSchema),
    })
    .strict();
}

export const mega2ClItemResSchema = z
  .object({
    id: z.number().int(),
    link: z.string().min(1),
    title: z.string(),
    status: mega2MergeStatusSchema,
    author: z.string(),
    open_timestamp: z.number().int(),
    closed_at: z.number().int().nullable(),
    merge_timestamp: z.number().int().nullable(),
    updated_at: z.number().int(),
    comment_num: z.number().int().nonnegative(),
    path: z.string(),
    from_hash: z.string(),
    to_hash: z.string(),
    head_revision: z.number().int().min(1),
    base_branch: z.string(),
  })
  .strict();
export type Mega2ClItemRes = z.output<typeof mega2ClItemResSchema>;

export const mega2ClListPageSchema = mega2CommonPageSchema(mega2ClItemResSchema);
export type Mega2ClListPage = z.output<typeof mega2ClListPageSchema>;

export const mega2ConversationItemSchema = z
  .object({
    id: z.number().int(),
    username: z.string(),
    conv_type: mega2ConvTypeSchema,
    comment: z.string().nullable(),
    resolved: z.boolean().nullable(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict();
export type Mega2ConversationItem = z.output<typeof mega2ConversationItemSchema>;

export const mega2ClDetailResSchema = z
  .object({
    id: z.number().int(),
    link: z.string().min(1),
    title: z.string(),
    status: mega2MergeStatusSchema,
    open_timestamp: z.number().int(),
    merge_timestamp: z.number().int().nullable(),
    conversations: z.array(mega2ConversationItemSchema),
    path: z.string(),
    from_hash: z.string(),
    to_hash: z.string(),
    head_revision: z.number().int().min(1),
    base_branch: z.string(),
    author: z.string(),
  })
  .strict();
export type Mega2ClDetailRes = z.output<typeof mega2ClDetailResSchema>;

export const mega2ClFileResSchema = z
  .object({
    path: z.string(),
    sha: z.string(),
    action: mega2ClFileActionSchema,
    old_path: z.string().optional(),
    similarity: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type Mega2ClFileRes = z.output<typeof mega2ClFileResSchema>;
export const mega2ClFilesListSchema = z.array(mega2ClFileResSchema);

export const mega2ClFilesChangedItemSchema = z
  .object({
    path: z.string(),
    data: z.string(),
    old_path: z.string().optional(),
  })
  .strict();
export type Mega2ClFilesChangedItem = z.output<
  typeof mega2ClFilesChangedItemSchema
>;

export const mega2FilesChangedPageSchema = z
  .object({
    page: mega2CommonPageSchema(mega2ClFilesChangedItemSchema),
  })
  .strict();
export type Mega2FilesChangedPage = z.output<typeof mega2FilesChangedPageSchema>;

export const mega2ConditionResultSchema = z.enum([
  "PASSED",
  "FAILED",
  "PENDING",
]);
export type Mega2ConditionResult = z.output<typeof mega2ConditionResultSchema>;

export const mega2ConditionSchema = z
  .object({
    type: mega2CheckTypeSchema,
    display_name: z.string(),
    description: z.string(),
    message: z.string(),
    result: mega2ConditionResultSchema,
    commit_id: z.string().optional(),
    head_revision: z.number().int().min(1).optional(),
    ci_task_id: z.string().optional(),
    ci_attempt_id: z.string().optional(),
    ci_generation: z.number().int().min(0).optional(),
    details_url: z.string().optional(),
    raw_status: z.string().optional(),
  })
  .strict();
export type Mega2Condition = z.output<typeof mega2ConditionSchema>;

export const mega2MergeRequirementsSchema = z
  .object({
    conditions: z.array(mega2ConditionSchema),
    state: z.enum(["MERGEABLE", "UNMERGEABLE"]),
  })
  .strict();
export type Mega2MergeRequirements = z.output<
  typeof mega2MergeRequirementsSchema
>;

export const mega2MergeBoxResSchema = z
  .object({
    merge_requirements: mega2MergeRequirementsSchema.nullable(),
  })
  .strict();
export type Mega2MergeBoxRes = z.output<typeof mega2MergeBoxResSchema>;

export const mega2CiAuthzActionSchema = z.enum(["read", "write"]);
export type Mega2CiAuthzAction = z.output<typeof mega2CiAuthzActionSchema>;

export const mega2CiAuthzResSchema = z
  .object({
    allowed: z.literal(true),
    action: mega2CiAuthzActionSchema,
    cl_link: z.string().min(1),
    principal: z.string().min(1),
  })
  .strict();
export type Mega2CiAuthzRes = z.output<typeof mega2CiAuthzResSchema>;

export const mega2CiAuthzErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

const CI_AUTHZ_DENIED_CODES = new Set([
  "ci_authz_policy_not_enforced",
  "ci_authz_denied",
]);
const CI_AUTHZ_NOT_FOUND_CODES = new Set(["cl_not_found"]);
const CI_AUTHZ_UNAVAILABLE_CODES = new Set(["ci_authz_unavailable"]);

export type Mega2CiAuthzDecision =
  | {
      readonly kind: "allowed";
      readonly status: 200;
      readonly action: Mega2CiAuthzAction;
      readonly clLink: string;
      readonly principal: string;
    }
  | {
      readonly kind: "unauthenticated";
      readonly status: 401;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "denied";
      readonly status: 403;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "not_found";
      readonly status: 404;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "unavailable";
      readonly status: 503;
      readonly code: string;
      readonly message: string;
    };

export type Mega2ClRequestOptions = Omit<
  Mega2RequestOptions,
  "retry" | "searchParams"
>;

export interface FetchMega2ClListParams {
  readonly status?: string;
  readonly author?: string;
  readonly sortBy?: string;
  readonly asc?: boolean;
  readonly page?: number;
  readonly perPage?: number;
}

export interface FetchMega2ClFilesChangedParams {
  readonly selector?: string;
  readonly page?: number;
  readonly perPage?: number;
}

const CL_LINK_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function requireValidClLink(link: string): string {
  if (!CL_LINK_REGEX.test(link) || link.includes("..")) {
    throw new MegaBadRequestError("Invalid mega2 CL link");
  }
  return encodeURIComponent(link);
}

/** Strictly forward only the `cookie` header so no unrelated secrets leak. */
function pickCookieOnlyHeaders(
  headers?: HeadersInit,
  hasJsonBody = false,
): Headers {
  const outgoing = new Headers();
  if (headers) {
    const incoming = new Headers(headers);
    const cookie = incoming.get("cookie");
    if (cookie) {
      outgoing.set("cookie", cookie);
    }
  }
  outgoing.set("Accept", "application/json");
  if (hasJsonBody) {
    outgoing.set("Content-Type", "application/json");
  }
  return outgoing;
}

function buildMega2Url(
  baseUrl: string,
  path: string,
  searchParams?: Record<string, string | undefined>,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(normalizedPath, `${baseUrl}/`);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
  }
  return url.toString();
}

function mapMega2HttpError(
  status: number,
  rawBody: string,
  path: string,
): MegaError {
  const detail =
    rawBody.trim() || `mega2 request to ${path} failed with status ${status}`;
  if (status === 401) return new MegaUnauthorizedError(detail);
  if (status === 403) return new MegaForbiddenError(detail);
  if (status === 404) return new MegaNotFoundError("mega2 CL resource", path);
  if (status === 409) return new MegaConflictError(detail);
  if (status === 400 || status === 422) return new MegaBadRequestError(detail);
  return new MegaInternalError(detail);
}

function mapMega2CommonResultFailure(errMessage: string, path: string): MegaError {
  const message = errMessage.trim() || `mega2 request to ${path} failed`;
  const lower = message.toLowerCase();
  if (lower.includes("not found")) {
    return new MegaNotFoundError("mega2 CL resource", path);
  }
  if (
    lower.includes("conflict") ||
    lower.includes("not ready") ||
    lower.includes("cannot merge") ||
    lower.includes("check") ||
    lower.includes("unmergeable")
  ) {
    return new MegaConflictError(message);
  }
  return new MegaBadRequestError(message);
}

async function fetchMega2Raw(params: {
  method: "GET" | "POST";
  path: string;
  searchParams?: Record<string, string | undefined>;
  body?: unknown;
  options: Mega2ClRequestOptions;
  env: NodeJS.ProcessEnv;
}): Promise<{ status: number; ok: boolean; text: string }> {
  const baseUrl = resolveMega2BaseUrl(params.env);
  const timeoutMs = params.options.timeoutMs ?? DEFAULT_MEGA2_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = params.options.signal
    ? AbortSignal.any([params.options.signal, controller.signal])
    : controller.signal;

  try {
    const response = await fetch(
      buildMega2Url(baseUrl, params.path, params.searchParams),
      {
        method: params.method,
        headers: pickCookieOnlyHeaders(
          params.options.headers,
          params.body !== undefined,
        ),
        body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
        redirect: "error",
        signal,
      },
    );
    const text = await response.text();
    return { status: response.status, ok: response.ok, text };
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      throw new MegaInternalError(
        `mega2 request to ${params.path} timed out after ${timeoutMs}ms`,
      );
    }
    throw new MegaInternalError(
      error instanceof Error
        ? error.message
        : `mega2 request to ${params.path} failed`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function requestMega2CommonResult<Schema extends z.ZodTypeAny>(params: {
  method: "GET" | "POST";
  path: string;
  schema: Schema;
  allowNullData?: boolean;
  body?: unknown;
  options: Mega2ClRequestOptions;
  env: NodeJS.ProcessEnv;
}): Promise<z.output<Schema>> {
  const { status, ok, text } = await fetchMega2Raw({
    method: params.method,
    path: params.path,
    body: params.body,
    options: params.options,
    env: params.env,
  });

  if (!ok) {
    throw mapMega2HttpError(status, text, params.path);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MegaInternalError(
      `mega2 response for ${params.path} is not valid JSON`,
    );
  }

  const envelope = commonResultWireSchema(z.unknown()).safeParse(json);
  if (!envelope.success) {
    throw new MegaInternalError(
      `mega2 response envelope for ${params.path} does not match CommonResult`,
    );
  }
  if (!envelope.data.req_result) {
    throw mapMega2CommonResultFailure(envelope.data.err_message, params.path);
  }

  const dataValue = envelope.data.data;
  if (!params.allowNullData && (dataValue === null || dataValue === undefined)) {
    throw new MegaInternalError(`mega2 response for ${params.path} is missing data`);
  }

  const parsed = params.schema.safeParse(dataValue);
  if (!parsed.success) {
    throw new MegaInternalError(
      `mega2 response data for ${params.path} does not match pinned contract: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data as z.output<Schema>;
}

/** 1. List CLs from mega2 (`POST /api/v1/cl/list`, per_page capped at 50). */
export async function fetchMega2ClList(
  params: FetchMega2ClListParams = {},
  options: Mega2ClRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Mega2ClListPage> {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const perPage = Math.min(
    MAX_MEGA2_CL_PER_PAGE,
    Math.max(1, Math.floor(params.perPage ?? 20)),
  );
  return requestMega2CommonResult({
    method: "POST",
    path: "/api/v1/cl/list",
    schema: mega2ClListPageSchema,
    body: {
      pagination: { page, per_page: perPage },
      additional: {
        status: params.status ?? "open",
        author: params.author ?? null,
        sort_by: params.sortBy ?? null,
        asc: params.asc ?? false,
      },
    },
    options,
    env,
  });
}

/** 2. Fetch CL detail including `head_revision` (`GET /api/v1/cl/{link}/detail`). */
export async function fetchMega2ClDetail(
  link: string,
  options: Mega2ClRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Mega2ClDetailRes> {
  const encoded = requireValidClLink(link);
  return requestMega2CommonResult({
    method: "GET",
    path: `/api/v1/cl/${encoded}/detail`,
    schema: mega2ClDetailResSchema,
    options,
    env,
  });
}

/** 3. Fetch CL changed file metadata list (`GET /api/v1/cl/{link}/files-list`). */
export async function fetchMega2ClFilesList(
  link: string,
  options: Mega2ClRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly Mega2ClFileRes[]> {
  const encoded = requireValidClLink(link);
  return requestMega2CommonResult({
    method: "GET",
    path: `/api/v1/cl/${encoded}/files-list`,
    schema: mega2ClFilesListSchema,
    options,
    env,
  });
}

/** 4. Fetch paginated CL diffs (`POST /api/v1/cl/{link}/files-changed`). */
export async function fetchMega2ClFilesChanged(
  link: string,
  params: FetchMega2ClFilesChangedParams = {},
  options: Mega2ClRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Mega2FilesChangedPage> {
  const encoded = requireValidClLink(link);
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const perPage = Math.min(
    MAX_MEGA2_CL_PER_PAGE,
    Math.max(1, Math.floor(params.perPage ?? 20)),
  );
  return requestMega2CommonResult({
    method: "POST",
    path: `/api/v1/cl/${encoded}/files-changed`,
    schema: mega2FilesChangedPageSchema,
    body: {
      pagination: { page, per_page: perPage },
      additional: params.selector ?? "",
    },
    options,
    env,
  });
}

/** 5. Fetch CL Merge Box conditions including CI status (`GET /api/v1/cl/{link}/merge-box`). */
export async function fetchMega2ClMergeBox(
  link: string,
  options: Mega2ClRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Mega2MergeBoxRes> {
  const encoded = requireValidClLink(link);
  return requestMega2CommonResult({
    method: "GET",
    path: `/api/v1/cl/${encoded}/merge-box`,
    schema: mega2MergeBoxResSchema,
    options,
    env,
  });
}

/** 6. Merge a CL (`POST /api/v1/cl/{link}/merge`). */
export async function mergeMega2Cl(
  link: string,
  options: Mega2ClRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const encoded = requireValidClLink(link);
  return requestMega2CommonResult({
    method: "POST",
    path: `/api/v1/cl/${encoded}/merge`,
    schema: z.string().nullable(),
    allowNullData: true,
    options,
    env,
  });
}

/** 7. Close a CL (`POST /api/v1/cl/{link}/close`). */
export async function closeMega2Cl(
  link: string,
  options: Mega2ClRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const encoded = requireValidClLink(link);
  return requestMega2CommonResult({
    method: "POST",
    path: `/api/v1/cl/${encoded}/close`,
    schema: z.string().nullable(),
    allowNullData: true,
    options,
    env,
  });
}

/** 8. Reopen a closed CL (`POST /api/v1/cl/{link}/reopen`). */
export async function reopenMega2Cl(
  link: string,
  options: Mega2ClRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const encoded = requireValidClLink(link);
  return requestMega2CommonResult({
    method: "POST",
    path: `/api/v1/cl/${encoded}/reopen`,
    schema: z.string().nullable(),
    allowNullData: true,
    options,
    env,
  });
}

/** 9. Update a CL branch against base (`POST /api/v1/cl/{link}/update-branch`). */
export async function updateMega2ClBranch(
  link: string,
  options: Mega2ClRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const encoded = requireValidClLink(link);
  return requestMega2CommonResult({
    method: "POST",
    path: `/api/v1/cl/${encoded}/update-branch`,
    schema: z.string().nullable(),
    allowNullData: true,
    options,
    env,
  });
}

/** 10. Add a comment to a CL (`POST /api/v1/cl/{link}/comment`). */
export async function addMega2ClComment(
  link: string,
  content: string,
  options: Mega2ClRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const encoded = requireValidClLink(link);
  if (content.trim().length === 0) {
    throw new MegaBadRequestError("Comment content must not be empty");
  }
  await requestMega2CommonResult({
    method: "POST",
    path: `/api/v1/cl/${encoded}/comment`,
    schema: z.null(),
    allowNullData: true,
    body: { content },
    options,
    env,
  });
}

function parseStrictCiAuthzErrorBody(
  text: string,
  allowedCodes: ReadonlySet<string>,
): { code: string; message: string } | undefined {
  if (text.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = mega2CiAuthzErrorSchema.safeParse(JSON.parse(text));
    if (parsed.success && allowedCodes.has(parsed.data.code)) {
      return parsed.data;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Enforced Cedar CI authorization probe (`GET /api/v1/cl/{link}/ci-authz?action=read|write`,
 * `CLB-14` / `ADR-CLB-05`). Strictly forwards only `cookie` and fails closed on
 * any non-200 response, unexpected error code, unknown fields, or transport/config error.
 */
export async function checkMega2ClCiAuthz(
  link: string,
  action: Mega2CiAuthzAction,
  options: Mega2ClRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Mega2CiAuthzDecision> {
  const encoded = requireValidClLink(link);
  const parsedAction = mega2CiAuthzActionSchema.safeParse(action);
  if (!parsedAction.success) {
    throw new MegaBadRequestError("CI authz action must be 'read' or 'write'");
  }

  let raw: { status: number; ok: boolean; text: string };
  try {
    raw = await fetchMega2Raw({
      method: "GET",
      path: `/api/v1/cl/${encoded}/ci-authz`,
      searchParams: { action: parsedAction.data },
      options,
      env,
    });
  } catch (error) {
    return {
      kind: "unavailable",
      status: 503,
      code: "ci_authz_unavailable",
      message:
        error instanceof Error
          ? error.message
          : "mega2 ci-authz service unavailable",
    };
  }

  if (raw.status === 200) {
    try {
      const parsed = mega2CiAuthzResSchema.safeParse(JSON.parse(raw.text));
      if (
        parsed.success &&
        parsed.data.action === parsedAction.data &&
        parsed.data.cl_link === link
      ) {
        return {
          kind: "allowed",
          status: 200,
          action: parsed.data.action,
          clLink: parsed.data.cl_link,
          principal: parsed.data.principal,
        };
      }
    } catch {
      // Malformed 200 payload fails closed below.
    }
    return {
      kind: "unavailable",
      status: 503,
      code: "ci_authz_unavailable",
      message: "mega2 ci-authz returned malformed authorization payload",
    };
  }

  if (raw.status === 401) {
    return {
      kind: "unauthenticated",
      status: 401,
      code: "unauthenticated",
      message: "mega2 session authentication required",
    };
  }

  if (raw.status === 403) {
    const err = parseStrictCiAuthzErrorBody(raw.text, CI_AUTHZ_DENIED_CODES);
    if (!err) {
      return {
        kind: "unavailable",
        status: 503,
        code: "ci_authz_unavailable",
        message: "mega2 ci-authz returned unexpected 403 error payload",
      };
    }
    return { kind: "denied", status: 403, ...err };
  }

  if (raw.status === 404) {
    const err = parseStrictCiAuthzErrorBody(raw.text, CI_AUTHZ_NOT_FOUND_CODES);
    if (!err) {
      return {
        kind: "unavailable",
        status: 503,
        code: "ci_authz_unavailable",
        message: "mega2 ci-authz returned unexpected 404 error payload",
      };
    }
    return { kind: "not_found", status: 404, ...err };
  }

  if (raw.status === 503) {
    const err = parseStrictCiAuthzErrorBody(
      raw.text,
      CI_AUTHZ_UNAVAILABLE_CODES,
    );
    if (err) {
      return { kind: "unavailable", status: 503, ...err };
    }
  }

  return {
    kind: "unavailable",
    status: 503,
    code: "ci_authz_unavailable",
    message: `mega2 ci-authz failed with unexpected HTTP ${raw.status}`,
  };
}
