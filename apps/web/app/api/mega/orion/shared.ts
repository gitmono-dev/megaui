import { NextResponse } from "next/server";
import {
  OrionClientError,
  OrionConfigError,
  isOrion2Configured,
  isValidOrionId,
  resolveOrion2Config,
  type Orion2Config,
} from "@megaui/engine/services/orion2";

import { megaFailureResponse, type MegaHttpFailureBody } from "@/lib/adapter/envelope";
import { mapMegaErrorToHttpResponse, unauthorizedMegaResponse } from "@/lib/adapter/errors";
import { OrionAuthzError } from "@/lib/adapter/orion-authz";
import { resolveWebActor, type WebActor } from "@/lib/enterprise-session";

export const ORION2_UNCONFIGURED_CODE = "ORION2_UNCONFIGURED" as const;
export const IDEMPOTENCY_KEY_REQUIRED_CODE = "IDEMPOTENCY_KEY_REQUIRED" as const;

const ALLOWED_ORION_409_CODES = new Set([
  "stale_head_revision",
  "idempotency_conflict",
  "conflict",
]);

const VALID_CL_LINK_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function orionFailureResponse(
  status: number,
  code: string,
  messageKey: string,
  message: string,
): NextResponse<MegaHttpFailureBody> {
  const res = megaFailureResponse(
    {
      error: {
        code,
        messageKey,
        message,
      },
    },
    status,
  );
  res.headers.set("cache-control", "no-store");
  return res;
}

export function orionSuccessResponse<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(
    { data },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export function requireConfiguredOrion2(
  env: NodeJS.ProcessEnv = process.env,
):
  | { readonly ok: true; readonly config: Orion2Config }
  | { readonly ok: false; readonly response: NextResponse<MegaHttpFailureBody> } {
  if (!isOrion2Configured(env)) {
    return {
      ok: false,
      response: orionFailureResponse(
        503,
        ORION2_UNCONFIGURED_CODE,
        "errors.mega.internal",
        "Orion2 integration is not configured",
      ),
    };
  }
  try {
    return { ok: true, config: resolveOrion2Config(env) };
  } catch (error) {
    if (error instanceof OrionConfigError) {
      return {
        ok: false,
        response: orionFailureResponse(
          503,
          ORION2_UNCONFIGURED_CODE,
          "errors.mega.internal",
          "Orion2 integration is not properly configured",
        ),
      };
    }
    throw error;
  }
}

export async function requireOrionActor(
  request: Request,
): Promise<
  | { readonly ok: true; readonly actor: WebActor }
  | { readonly ok: false; readonly response: NextResponse<MegaHttpFailureBody> }
> {
  const actor = await resolveWebActor(request.headers);
  if (!actor) {
    const unauthorized = unauthorizedMegaResponse(request);
    const res = megaFailureResponse(unauthorized.body, unauthorized.status);
    res.headers.set("cache-control", "no-store");
    return { ok: false, response: res };
  }
  return { ok: true, actor };
}

export function isValidClLinkParam(value: string | null): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed === value &&
    trimmed !== "." &&
    trimmed !== ".." &&
    VALID_CL_LINK_RE.test(trimmed)
  );
}

export function parseMandatoryIdempotencyKey(headers: Headers): string | null {
  const raw = headers.get("idempotency-key");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes(",") || !isValidOrionId(trimmed)) {
    return null;
  }
  return trimmed;
}

export function validateSingleQueryParams(
  searchParams: URLSearchParams,
  allowedKeys: ReadonlySet<string>,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  const seen = new Set<string>();
  for (const [key] of searchParams.entries()) {
    if (!allowedKeys.has(key)) {
      return { ok: false, message: `Unsupported query parameter: ${key}` };
    }
    if (seen.has(key)) {
      return { ok: false, message: `Duplicate query parameter: ${key}` };
    }
    seen.add(key);
  }
  return { ok: true };
}

export function parsePositiveIntQuery(
  raw: string | null,
  min: number,
  max: number,
): { readonly ok: true; readonly value?: number } | { readonly ok: false } {
  if (raw === null) return { ok: true };
  if (!/^[1-9]\d*$/.test(raw)) return { ok: false };
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < min || num > max) return { ok: false };
  return { ok: true, value: num };
}

export function mapOrionRouteError(error: unknown, request: Request): NextResponse<MegaHttpFailureBody> {
  if (error instanceof OrionAuthzError && (error.status === 403 || error.status === 404)) {
    const normalized = new OrionAuthzError(403, "ci_authz_denied", "Forbidden");
    const mapped = mapMegaErrorToHttpResponse(normalized, request);
    const res = megaFailureResponse(mapped.body, mapped.status);
    res.headers.set("cache-control", "no-store");
    return res;
  }
  if (error instanceof OrionClientError) {
    if (error.status === 409) {
      const safeCode = ALLOWED_ORION_409_CODES.has(error.code)
        ? error.code
        : "ORION_TASK_CONFLICT";
      return orionFailureResponse(
        409,
        safeCode,
        "errors.mega.conflict",
        "Orion2 task conflict",
      );
    }
    if (error.status === 400) {
      return orionFailureResponse(
        400,
        "ORION_INVALID_REQUEST",
        "errors.mega.badRequest",
        "Invalid Orion2 request",
      );
    }
    if (error.status === 404) {
      return orionFailureResponse(
        404,
        "ORION_NOT_FOUND",
        "errors.mega.notFound",
        "Orion2 resource not found",
      );
    }
    return orionFailureResponse(
      503,
      "ORION_UPSTREAM_UNAVAILABLE",
      "errors.mega.internal",
      "Orion2 service unavailable",
    );
  }
  const mapped = mapMegaErrorToHttpResponse(error, request);
  const res = megaFailureResponse(mapped.body, mapped.status);
  res.headers.set("cache-control", "no-store");
  return res;
}
