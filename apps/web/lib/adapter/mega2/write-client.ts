// megaui:libs/mega/services/monoengine/client.ts@0ff3a9d (write helpers)
//
// Diff vs upstream (GC-03 / WA-05):
// - POST/PUT/DELETE CommonResult helpers for credentials + notification prefs.
// - Cookie forward only — mirrors `@megaui/engine` mega2 client (EG-11).

import {
  commonResultWireSchema,
  DEFAULT_MEGA2_TIMEOUT_MS,
  MegaBadRequestError,
  MegaError,
  MegaForbiddenError,
  MegaInternalError,
  MegaNotFoundError,
  MegaUnauthorizedError,
  resolveMega2BaseUrl,
  type Mega2RequestOptions,
} from "@megaui/engine";
import { z } from "zod";

interface Mega2WriteInit extends Mega2RequestOptions {
  method: "POST" | "PUT" | "DELETE";
  body?: unknown;
}

function pickForwardHeaders(headers?: HeadersInit, jsonBody?: boolean): Headers {
  const outgoing = new Headers();
  if (jsonBody) {
    outgoing.set("Content-Type", "application/json");
  }
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

function mapHttpError(status: number, message: string, path: string): MegaError {
  const detail = message.trim() || `mega2 request to ${path} failed with status ${status}`;
  if (status === 401) {
    return new MegaUnauthorizedError(detail);
  }
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

async function mega2WriteFetch(
  path: string,
  init: Mega2WriteInit,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const baseUrl = resolveMega2BaseUrl(env);
  const timeoutMs = init.timeoutMs ?? DEFAULT_MEGA2_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;

  try {
    return await fetch(buildUrl(baseUrl, path, init.searchParams), {
      method: init.method,
      headers: pickForwardHeaders(init.headers, init.body !== undefined),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new MegaInternalError(`mega2 request to ${path} timed out after ${timeoutMs}ms`);
    }
    throw new MegaInternalError(
      error instanceof Error ? error.message : `mega2 request to ${path} failed`,
    );
  } finally {
    clearTimeout(timeout);
  }
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

async function readCommonResult<T>(
  response: Response,
  path: string,
  allowNullData: boolean,
): Promise<T | null> {
  const json = await readJsonBody(response, path);
  const envelope = commonResultWireSchema(z.unknown()).safeParse(json);
  if (!envelope.success) {
    throw new MegaInternalError(
      `mega2 response envelope for ${path} does not match CommonResult`,
    );
  }
  if (!envelope.data.req_result) {
    throw mapCommonResultFailure(envelope.data.err_message, path);
  }
  if (!allowNullData && (envelope.data.data === null || envelope.data.data === undefined)) {
    throw new MegaInternalError(`mega2 response for ${path} is missing data`);
  }
  return envelope.data.data as T | null;
}

export async function postCommonResultVoid(
  path: string,
  body: unknown,
  options: Mega2RequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const response = await mega2WriteFetch(path, { ...options, method: "POST", body }, env);
  await readCommonResult<null>(response, path, true);
}

export async function deleteCommonResultVoid(
  path: string,
  options: Mega2RequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const response = await mega2WriteFetch(path, { ...options, method: "DELETE" }, env);
  await readCommonResult<null>(response, path, true);
}

export async function postCommonResultJson<Schema extends z.ZodTypeAny>(
  path: string,
  body: unknown,
  dataSchema: Schema,
  options: Mega2RequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<z.output<Schema>> {
  const response = await mega2WriteFetch(path, { ...options, method: "POST", body }, env);
  const data = await readCommonResult<unknown>(response, path, false);
  const parsed = dataSchema.safeParse(data);
  if (!parsed.success) {
    throw new MegaInternalError(
      `mega2 response data for ${path} does not match the pinned contract`,
    );
  }
  return parsed.data as z.output<Schema>;
}

export async function putCommonResultJson<Schema extends z.ZodTypeAny>(
  path: string,
  body: unknown,
  dataSchema: Schema,
  options: Mega2RequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<z.output<Schema>> {
  const response = await mega2WriteFetch(path, { ...options, method: "PUT", body }, env);
  const data = await readCommonResult<unknown>(response, path, false);
  const parsed = dataSchema.safeParse(data);
  if (!parsed.success) {
    throw new MegaInternalError(
      `mega2 response data for ${path} does not match the pinned contract`,
    );
  }
  return parsed.data as z.output<Schema>;
}

export async function getCommonResultJson<Schema extends z.ZodTypeAny>(
  path: string,
  dataSchema: Schema,
  options: Mega2RequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<z.output<Schema>> {
  const baseUrl = resolveMega2BaseUrl(env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEGA2_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  let response: Response;
  try {
    response = await fetch(buildUrl(baseUrl, path, options.searchParams), {
      method: "GET",
      headers: pickForwardHeaders(options.headers),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new MegaInternalError(`mega2 request to ${path} timed out after ${timeoutMs}ms`);
    }
    throw new MegaInternalError(
      error instanceof Error ? error.message : `mega2 request to ${path} failed`,
    );
  } finally {
    clearTimeout(timeout);
  }

  const data = await readCommonResult<unknown>(response, path, false);
  const parsed = dataSchema.safeParse(data);
  if (!parsed.success) {
    throw new MegaInternalError(
      `mega2 response data for ${path} does not match the pinned contract`,
    );
  }
  return parsed.data as z.output<Schema>;
}
