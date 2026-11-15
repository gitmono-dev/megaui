// megaui:libs/mega/services/monoengine/client.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-11 task card):
// - Card scope is read-only (the 5 `GET` endpoints on REF-02); `postJson` /
//   `putJson` / `deleteJson` / `postCommonResultJson` / `putCommonResultJson`
//   / `postCommonResultVoid` / `deleteCommonResultVoid` are not ported —
//   those back write endpoints (`create-entry`, `edit/*`, credentials,
//   notifications) outside this card's write set.
// - Error mapping throws the engine's own `Mega*` domain errors directly
//   (`MegaUnauthorizedError` / `MegaForbiddenError` / `MegaNotFoundError` /
//   `MegaBadRequestError` / `MegaInternalError`) instead of a standalone
//   `Mega2ApiError` — single domain-error exit (DEBT-03/GC-04); the
//   401/403/404/400/5xx classification is unchanged.
// - `getJson` / `getCommonResultJson` are now generic over a zod schema
//   (`getMega2Json` / `getMega2CommonResult`) and validate the
//   response body at the boundary instead of trusting a TypeScript cast —
//   the card's "zod wire→domain mapping" AC requires runtime validation,
//   not just compile-time types. A schema mismatch (contract drift or a
//   malformed response) is classified as `MegaInternalError` (upstream
//   fault, not caller input).
// - No mock-vs-mega2 data-backend selector branch and no in-memory
//   store fallback (DEBT-04) — a missing/unreachable mega2 always
//   fails closed via a thrown domain error, never silently degrades to a
//   canned in-memory response.
import { z } from "zod";
import {
  MegaBadRequestError,
  MegaError,
  MegaForbiddenError,
  MegaInternalError,
  MegaNotFoundError,
  MegaUnauthorizedError,
} from "../../errors";
import { commonResultWireSchema, Mega2ConfigError } from "./types";

export const DEFAULT_MEGA2_TIMEOUT_MS = 15_000;

/** ER-10 bounded retry — same shape/defaults contract as `../agent/llm.ts`'s `AgentLlmRetryConfig`. */
export interface Mega2RetryConfig {
  /** ER-10 default ceiling: bounded retry, ≤ 5 attempts. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** ER-10: total retry budget. */
  maxTotalDelayMs?: number;
}

export interface Mega2RequestOptions {
  headers?: HeadersInit;
  searchParams?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  retry?: Mega2RetryConfig;
}

const DEFAULT_MEGA2_MAX_ATTEMPTS = 5;
const DEFAULT_MEGA2_BASE_DELAY_MS = 200;
const DEFAULT_MEGA2_MAX_DELAY_MS = 3_000;
const DEFAULT_MEGA2_MAX_TOTAL_DELAY_MS = 30_000;

export function resolveMega2BaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const baseUrl = env.MEGA2_PUBLIC_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Mega2ConfigError(
      "MEGA2_PUBLIC_BASE_URL is required to reach the mega2 code backend",
    );
  }
  return baseUrl.replace(/\/$/, "");
}

/** Normalize mega relative paths (`project/foo`) to mega2 absolute paths (`/project/foo`). */
export function normalizeRepoPath(path?: string): string {
  if (!path || path === "/") {
    return "/";
  }
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `/${trimmed}` : "/";
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

/** Only the `cookie` header is forwarded — the BFF caller owns session propagation. */
function pickForwardHeaders(headers?: HeadersInit): Headers {
  const outgoing = new Headers();
  if (!headers) {
    return outgoing;
  }
  const incoming = new Headers(headers);
  const cookie = incoming.get("cookie");
  if (cookie) {
    outgoing.set("cookie", cookie);
  }
  return outgoing;
}

function mapHttpError(status: number, message: string, path: string): MegaError {
  const detail = message.trim() || `mega2 request to ${path} failed with status ${status}`;
  if (status === 401) {
    return new MegaUnauthorizedError(detail);
  }
  // DEP-01 ④ (upstream): Cedar deny answers 401/403 upstream — pass both through unchanged.
  if (status === 403) {
    return new MegaForbiddenError(detail);
  }
  if (status === 404) {
    return new MegaNotFoundError("mega2 resource", path);
  }
  if (status === 400 || status === 422) {
    return new MegaBadRequestError(detail);
  }
  return new MegaInternalError(detail);
}

function mapCommonResultFailure(errMessage: string, path: string): MegaError {
  const message = errMessage.trim() || `mega2 request to ${path} failed`;
  if (message.toLowerCase().includes("not found")) {
    return new MegaNotFoundError("mega2 resource", path);
  }
  return new MegaBadRequestError(message);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
}

/** ER-10: 429/5xx are transient (rate-limited/overloaded upstream); every other status is a deterministic caller/mega2-contract failure and must not be retried. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isAbortOrTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** `fetch` itself rejecting (DNS, connection refused/reset, TLS) surfaces as a `TypeError` in both Node's undici and the browser fetch spec — transient network failure, not a caller mistake. */
function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

function isTransientFetchError(error: unknown): boolean {
  return isAbortOrTimeoutError(error) || isNetworkError(error);
}

function toMega2FetchError(error: unknown, path: string, timeoutMs: number): MegaInternalError {
  if (isAbortOrTimeoutError(error)) {
    return new MegaInternalError(`mega2 request to ${path} timed out after ${timeoutMs}ms`);
  }
  return new MegaInternalError(
    error instanceof Error ? error.message : `mega2 request to ${path} failed`,
  );
}

async function mega2FetchOnce(
  baseUrl: string,
  path: string,
  options: Mega2RequestOptions,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  try {
    return await fetch(buildUrl(baseUrl, path, options.searchParams), {
      method: "GET",
      headers: pickForwardHeaders(options.headers),
      signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * ER-10 bounded retry — mirrors `../agent/llm.ts`'s `complete()` loop:
 * transient failures (timeout/abort, network errors, HTTP 429/5xx) get
 * capped exponential backoff up to `maxAttempts` (default 5) within a total
 * delay budget (`maxTotalDelayMs`); a deterministic 4xx (400/401/403/404/422
 * — anything but 429) is returned/thrown on the first attempt so a caller's
 * own bad request is never retried. The final failure — whether the last
 * attempt's non-ok `Response` or a thrown network/timeout error — is always
 * surfaced to `readJsonBody`/`mapHttpError` below, which is what maps it to
 * a `MegaInternalError` (or a more specific `Mega*Error` for a non-retryable
 * HTTP status).
 */
async function mega2Fetch(
  path: string,
  options: Mega2RequestOptions,
  env: NodeJS.ProcessEnv,
): Promise<Response> {
  const baseUrl = resolveMega2BaseUrl(env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEGA2_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? DEFAULT_MEGA2_MAX_ATTEMPTS);
  const baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_MEGA2_BASE_DELAY_MS;
  const maxDelayMs = options.retry?.maxDelayMs ?? DEFAULT_MEGA2_MAX_DELAY_MS;
  const maxTotalDelayMs = options.retry?.maxTotalDelayMs ?? DEFAULT_MEGA2_MAX_TOTAL_DELAY_MS;

  let elapsedDelayMs = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response | undefined;
    let thrown: unknown;
    try {
      response = await mega2FetchOnce(baseUrl, path, options, timeoutMs);
    } catch (error) {
      thrown = error;
    }

    const transient = response ? !response.ok && isRetryableStatus(response.status) : isTransientFetchError(thrown);
    const isLastAttempt = attempt >= maxAttempts;
    const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs);
    const withinBudget = elapsedDelayMs + delayMs <= maxTotalDelayMs;

    if (!transient || isLastAttempt || !withinBudget) {
      if (response) return response;
      throw toMega2FetchError(thrown, path, timeoutMs);
    }

    elapsedDelayMs += delayMs;
    await sleep(delayMs);
  }
  // Unreachable — the loop above always returns or throws on its last iteration.
  throw new MegaInternalError(`mega2 request to ${path} failed`);
}

async function readJsonBody(response: Response, path: string): Promise<unknown> {
  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    throw mapHttpError(response.status, raw || response.statusText, path);
  }
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new MegaInternalError(`mega2 response for ${path} is not valid JSON`);
  }
}

/** Fetch + zod-validate a plain (non-`CommonResult`) mega2 JSON response, e.g. `latest-commit`. */
export async function getMega2Json<Schema extends z.ZodTypeAny>(
  path: string,
  schema: Schema,
  options: Mega2RequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<z.output<Schema>> {
  const response = await mega2Fetch(path, options, env);
  const json = await readJsonBody(response, path);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new MegaInternalError(
      `mega2 response for ${path} does not match the pinned contract: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data as z.output<Schema>;
}

/** Fetch, unwrap `CommonResult<T>`, and zod-validate the `data` payload against `dataSchema`. */
export async function getMega2CommonResult<Schema extends z.ZodTypeAny>(
  path: string,
  dataSchema: Schema,
  options: Mega2RequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<z.output<Schema>> {
  const response = await mega2Fetch(path, options, env);
  const json = await readJsonBody(response, path);
  const envelope = commonResultWireSchema(z.unknown()).safeParse(json);
  if (!envelope.success) {
    throw new MegaInternalError(
      `mega2 response envelope for ${path} does not match CommonResult: ${z.prettifyError(envelope.error)}`,
    );
  }
  if (!envelope.data.req_result) {
    throw mapCommonResultFailure(envelope.data.err_message, path);
  }
  if (envelope.data.data === null || envelope.data.data === undefined) {
    throw new MegaInternalError(`mega2 response for ${path} is missing data`);
  }
  const parsed = dataSchema.safeParse(envelope.data.data);
  if (!parsed.success) {
    throw new MegaInternalError(
      `mega2 response data for ${path} does not match the pinned contract: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data as z.output<Schema>;
}
