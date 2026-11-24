import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  resolveOrion2Config,
  type Orion2Config,
} from "./config";
import { signOrionServiceJwt } from "./jwt";
import {
  errorEnvelopeSchema,
  isValidOrionId,
  ORION_V1_NAMESPACE,
  ORION_V1_SCHEMA_VERSION,
  OrionClientError,
  retryResponseSchema,
  targetStatusListResponseSchema,
  taskCancelResponseSchema,
  taskCreateRequestSchema,
  taskCreateResponseSchema,
  taskGetResponseSchema,
  taskListResponseSchema,
  workerSessionListResponseSchema,
  type OrionHttpScope,
  type OrionTaskStatus,
  type OrionWorkerStatus,
  type RetryResponse,
  type TargetStatusListResponse,
  type TaskCancelResponse,
  type TaskCreateResponse,
  type TaskGetResponse,
  type TaskListResponse,
  type TaskSourceRef,
  type WorkerSessionListResponse,
} from "./types";

export interface OrionRequestOptions {
  readonly requestId?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly config?: Orion2Config;
}

export interface ListTasksParams {
  readonly clLink?: string;
  readonly commitSha?: string;
  readonly repoPath?: string;
  readonly status?: OrionTaskStatus;
  readonly attemptId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CreateTaskInput {
  readonly targets?: readonly string[];
  readonly source?: TaskSourceRef;
  readonly idempotencyKey: string;
}

export interface RetryTaskOptions extends OrionRequestOptions {
  readonly idempotencyKey?: string;
}

export interface ListAttemptTargetsParams {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListWorkersParams {
  readonly status?: OrionWorkerStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface OpenAttemptLogStreamOptions extends OrionRequestOptions {
  readonly after?: string;
  readonly lastEventId?: string;
}

function getConfig(
  options: OrionRequestOptions,
  env: NodeJS.ProcessEnv,
): Orion2Config {
  return options.config ?? resolveOrion2Config(env);
}

function resolveRequestId(provided?: string): string {
  if (provided !== undefined) {
    if (!isValidOrionId(provided)) {
      throw new OrionClientError({
        status: 400,
        code: "invalid_request",
        message: "X-Request-Id must be a valid Orion identifier",
        isRetryable: false,
      });
    }
    return provided;
  }
  return `req-${randomUUID()}`;
}

function requireValidPathId(name: string, value: string): string {
  if (!isValidOrionId(value)) {
    throw new OrionClientError({
      status: 400,
      code: "invalid_request",
      message: `Invalid ${name}`,
      isRetryable: false,
    });
  }
  return encodeURIComponent(value);
}

function buildUrl(
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

function buildHeaders(
  config: Orion2Config,
  scope: OrionHttpScope,
  requestId: string,
  extra?: Record<string, string | undefined>,
): Headers {
  const token = signOrionServiceJwt(config, scope);
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-Request-Id", requestId);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) {
        headers.set(key, value);
      }
    }
  }
  return headers;
}

function isAbortOrTimeoutError(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted) {
    return true;
  }
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

async function parseErrorResponse(
  response: Response,
  fallbackRequestId: string,
  path: string,
  requestSignal?: AbortSignal,
  callerSignal?: AbortSignal,
): Promise<OrionClientError> {
  const status = response.status;
  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    if (isAbortOrTimeoutError(error, requestSignal)) {
      throw new OrionClientError({
        status: 504,
        code: "unavailable",
        message: `Orion2 error response body read for ${path} timed out or was aborted`,
        requestId: fallbackRequestId,
        isRetryable: !callerSignal?.aborted,
      });
    }
  }
  if (text.trim().length > 0) {
    try {
      const json: unknown = JSON.parse(text);
      const parsed = errorEnvelopeSchema.safeParse(json);
      if (parsed.success) {
        return new OrionClientError({
          status,
          code: parsed.data.error.code,
          message: parsed.data.error.message,
          requestId: parsed.data.error.request_id ?? fallbackRequestId,
        });
      }
    } catch {
      // Fall through to generic status-based classification.
    }
  }
  return new OrionClientError({
    status,
    code:
      status === 401
        ? "invalid_jwt"
        : status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : status === 503
              ? "unavailable"
              : status >= 500
                ? "unavailable"
                : "invalid_request",
    message: `Orion2 request failed with HTTP ${status}`,
    requestId: fallbackRequestId,
  });
}

async function executeJsonRequest<T>(params: {
  method: "GET" | "POST";
  path: string;
  scope: OrionHttpScope;
  schema: z.ZodType<T>;
  searchParams?: Record<string, string | undefined>;
  extraHeaders?: Record<string, string | undefined>;
  body?: unknown;
  options: OrionRequestOptions;
  env: NodeJS.ProcessEnv;
}): Promise<T> {
  const config = getConfig(params.options, params.env);
  const requestId = resolveRequestId(params.options.requestId);
  const timeoutMs = params.options.timeoutMs ?? config.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = params.options.signal
    ? AbortSignal.any([params.options.signal, controller.signal])
    : controller.signal;

  const extraHeaders: Record<string, string | undefined> = {
    Accept: "application/json",
    ...(params.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...params.extraHeaders,
  };

  try {
    let response: Response;
    try {
      response = await fetch(
        buildUrl(config.baseUrl, params.path, params.searchParams),
        {
          method: params.method,
          headers: buildHeaders(config, params.scope, requestId, extraHeaders),
          body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
          redirect: "error",
          signal,
        },
      );
    } catch (error) {
      if (isAbortOrTimeoutError(error, signal)) {
        throw new OrionClientError({
          status: 504,
          code: "unavailable",
          message: `Orion2 request to ${params.path} timed out or was aborted`,
          requestId,
          isRetryable: !params.options.signal?.aborted,
        });
      }
      throw new OrionClientError({
        status: 503,
        code: "unavailable",
        message: `Orion2 request to ${params.path} failed at transport layer`,
        requestId,
        isRetryable: true,
      });
    }

    if (!response.ok) {
      throw await parseErrorResponse(
        response,
        requestId,
        params.path,
        signal,
        params.options.signal,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      if (isAbortOrTimeoutError(error, signal)) {
        throw new OrionClientError({
          status: 504,
          code: "unavailable",
          message: `Orion2 response body read for ${params.path} timed out or was aborted`,
          requestId,
          isRetryable: !params.options.signal?.aborted,
        });
      }
      throw new OrionClientError({
        status: 502,
        code: "malformed",
        message: `Orion2 returned non-JSON response for ${params.path}`,
        requestId,
        isRetryable: false,
      });
    }

    const parsed = params.schema.safeParse(json);
    if (!parsed.success) {
      throw new OrionClientError({
        status: 502,
        code: "malformed",
        message: `Orion2 response contract mismatch for ${params.path}`,
        requestId,
        isRetryable: false,
      });
    }

    return parsed.data;
  } finally {
    clearTimeout(timer);
  }
}

export async function listTasks(
  params: ListTasksParams = {},
  options: OrionRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<TaskListResponse> {
  return executeJsonRequest({
    method: "GET",
    path: "/v1/tasks",
    scope: "task.read",
    schema: taskListResponseSchema,
    searchParams: {
      cl_link: params.clLink,
      commit_sha: params.commitSha,
      repo_path: params.repoPath,
      status: params.status,
      attempt_id: params.attemptId,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
      cursor: params.cursor,
    },
    options,
    env,
  });
}

export async function getTask(
  taskId: string,
  options: OrionRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<TaskGetResponse> {
  const encodedId = requireValidPathId("task_id", taskId);
  return executeJsonRequest({
    method: "GET",
    path: `/v1/tasks/${encodedId}`,
    scope: "task.read",
    schema: taskGetResponseSchema,
    options,
    env,
  });
}

export async function createTask(
  input: CreateTaskInput,
  options: OrionRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<TaskCreateResponse> {
  if (!isValidOrionId(input.idempotencyKey)) {
    throw new OrionClientError({
      status: 400,
      code: "invalid_request",
      message: "Idempotency-Key must be a valid Orion identifier",
      isRetryable: false,
    });
  }
  const config = getConfig(options, env);
  const rawBody = {
    namespace: ORION_V1_NAMESPACE,
    version: ORION_V1_SCHEMA_VERSION,
    environment_id: config.environmentId,
    targets:
      input.targets && input.targets.length > 0
        ? [...input.targets]
        : [...config.defaultTargets],
    ...(input.source !== undefined ? { source: input.source } : {}),
  };
  const validated = taskCreateRequestSchema.safeParse(rawBody);
  if (!validated.success) {
    throw new OrionClientError({
      status: 400,
      code: "invalid_request",
      message: validated.error.issues[0]?.message ?? "Invalid task create request",
      isRetryable: false,
    });
  }

  return executeJsonRequest({
    method: "POST",
    path: "/v1/tasks",
    scope: "task.write",
    schema: taskCreateResponseSchema,
    extraHeaders: { "Idempotency-Key": input.idempotencyKey },
    body: validated.data,
    options: { ...options, config },
    env,
  });
}

export async function retryTask(
  taskId: string,
  options: RetryTaskOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<RetryResponse> {
  const encodedId = requireValidPathId("task_id", taskId);
  if (
    options.idempotencyKey !== undefined &&
    !isValidOrionId(options.idempotencyKey)
  ) {
    throw new OrionClientError({
      status: 400,
      code: "invalid_request",
      message: "Idempotency-Key must be a valid Orion identifier",
      isRetryable: false,
    });
  }
  return executeJsonRequest({
    method: "POST",
    path: `/v1/tasks/${encodedId}/retry`,
    scope: "task.write",
    schema: retryResponseSchema,
    extraHeaders: options.idempotencyKey
      ? { "Idempotency-Key": options.idempotencyKey }
      : undefined,
    body: {
      namespace: ORION_V1_NAMESPACE,
      version: ORION_V1_SCHEMA_VERSION,
    },
    options,
    env,
  });
}

export async function cancelTask(
  taskId: string,
  options: OrionRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<TaskCancelResponse> {
  const encodedId = requireValidPathId("task_id", taskId);
  return executeJsonRequest({
    method: "POST",
    path: `/v1/tasks/${encodedId}/cancel`,
    scope: "task.write",
    schema: taskCancelResponseSchema,
    options,
    env,
  });
}

export async function listAttemptTargets(
  attemptId: string,
  params: ListAttemptTargetsParams = {},
  options: OrionRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<TargetStatusListResponse> {
  const encodedId = requireValidPathId("attempt_id", attemptId);
  return executeJsonRequest({
    method: "GET",
    path: `/v1/attempts/${encodedId}/targets`,
    scope: "task.read",
    schema: targetStatusListResponseSchema,
    searchParams: {
      limit: params.limit !== undefined ? String(params.limit) : undefined,
      cursor: params.cursor,
    },
    options,
    env,
  });
}

export async function listWorkers(
  params: ListWorkersParams = {},
  options: OrionRequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerSessionListResponse> {
  return executeJsonRequest({
    method: "GET",
    path: "/v1/workers/status",
    scope: "task.read",
    schema: workerSessionListResponseSchema,
    searchParams: {
      status: params.status,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
      cursor: params.cursor,
    },
    options,
    env,
  });
}

/**
 * Opens an authenticated `text/event-stream` response from Orion2 with
 * `redirect: "error"` so the short-lived `log.read` Bearer JWT is never
 * forwarded across HTTP redirects. The connection-setup timeout is cleared
 * once response headers arrive so streaming remains governed by caller `signal`.
 */
export async function openAttemptLogStream(
  attemptId: string,
  options: OpenAttemptLogStreamOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const encodedId = requireValidPathId("attempt_id", attemptId);
  const config = getConfig(options, env);
  const requestId = resolveRequestId(options.requestId);
  const connectTimeoutMs = options.timeoutMs ?? config.timeoutMs;
  const connectController = new AbortController();
  const timer = setTimeout(() => connectController.abort(), connectTimeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, connectController.signal])
    : connectController.signal;

  const path = `/v1/attempts/${encodedId}/logs`;
  let response: Response;
  try {
    response = await fetch(
      buildUrl(config.baseUrl, path, { after: options.after }),
      {
        method: "GET",
        headers: buildHeaders(config, "log.read", requestId, {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "Last-Event-ID": options.lastEventId,
        }),
        redirect: "error",
        signal,
      },
    );
  } catch (error) {
    clearTimeout(timer);
    if (isAbortOrTimeoutError(error, signal)) {
      throw new OrionClientError({
        status: 504,
        code: "unavailable",
        message: `Orion2 log stream connection to ${path} timed out or was aborted`,
        requestId,
        isRetryable: !options.signal?.aborted,
      });
    }
    throw new OrionClientError({
      status: 503,
      code: "unavailable",
      message: `Orion2 log stream connection to ${path} failed`,
      requestId,
      isRetryable: true,
    });
  }
  if (!response.ok) {
    try {
      throw await parseErrorResponse(
        response,
        requestId,
        path,
        signal,
        options.signal,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  clearTimeout(timer);
  return response;
}
