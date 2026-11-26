import { NextResponse } from "next/server";
import { getDb } from "@megaui/database";
import { isCLReference } from "@megaui/core";
import { fetchMega2ClDetail, resolveCLNumber } from "@megaui/engine";
import {
  OrionClientError,
  OrionConfigError,
  createTask,
  isOrion2Configured,
  isValidOrionId,
  orionTargetSchema,
  resolveOrion2Config,
} from "@megaui/engine/services/orion2";
import { z } from "zod";

import { requireSameOriginCsrf } from "@/lib/adapter/csrf";
import { megaFailureResponse, type MegaHttpFailureBody } from "@/lib/adapter/envelope";
import { mapMegaErrorToHttpResponse, unauthorizedMegaResponse } from "@/lib/adapter/errors";
import { resolveMegaClLinkByNumber } from "@/lib/adapter/mega2/cl-projection";
import { authorizeClWrite } from "@/lib/adapter/orion-authz";
import { resolveWebActor } from "@/lib/enterprise-session";

const IDEMPOTENCY_KEY_REQUIRED_CODE = "IDEMPOTENCY_KEY_REQUIRED" as const;
const CL_NOT_OPEN_CODE = "CL_NOT_OPEN" as const;
const ORION2_UNCONFIGURED_CODE = "ORION2_UNCONFIGURED" as const;
const PAYLOAD_TOO_LARGE_CODE = "PAYLOAD_TOO_LARGE" as const;
const MAX_TRIGGER_BODY_BYTES = 32 * 1024;
const ALLOWED_ORION_409_CODES = new Set([
  "stale_head_revision",
  "idempotency_conflict",
  "conflict",
]);

const triggerBodySchema = z
  .object({
    targets: z.array(orionTargetSchema).min(1).max(64).optional(),
  })
  .strict();

interface TriggerRouteContext {
  readonly params: Promise<{ readonly n: string }>;
}

function failureJson(
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

function parseMandatoryIdempotencyKey(headers: Headers): string | null {
  const raw = headers.get("idempotency-key");
  if (!raw) return null;
  const trimmed = raw.trim();
  // Reject multi-header comma-joined values or invalid Orion IDs.
  if (!trimmed || trimmed.includes(",") || !isValidOrionId(trimmed)) {
    return null;
  }
  return trimmed;
}

async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false };
    }
  }
  if (!request.body) {
    return { ok: true, text: "" };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

async function parseOptionalTargets(request: Request): Promise<
  | { readonly ok: true; readonly targets?: readonly string[] }
  | { readonly ok: false; readonly status: 400 | 413; readonly code: string; readonly message: string }
> {
  const rawResult = await readBoundedText(request, MAX_TRIGGER_BODY_BYTES);
  if (!rawResult.ok) {
    return {
      ok: false,
      status: 413,
      code: PAYLOAD_TOO_LARGE_CODE,
      message: "Trigger request payload exceeds maximum allowed size",
    };
  }
  if (rawResult.text.trim().length === 0) {
    return { ok: true };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawResult.text);
  } catch {
    return {
      ok: false,
      status: 400,
      code: "BAD_REQUEST",
      message: "Request body must be valid JSON",
    };
  }
  const validated = triggerBodySchema.safeParse(parsedJson);
  if (!validated.success) {
    return {
      ok: false,
      status: 400,
      code: "BAD_REQUEST",
      message: "Invalid trigger request payload",
    };
  }
  return { ok: true, targets: validated.data.targets };
}

/**
 * `POST /api/mega/cls/[n]/checks/trigger` (`CLB-25`):
 * 1. Canonical-origin CSRF guard (`403 CSRF_ORIGIN_REJECTED`)
 * 2. Authenticated Web actor (`401`)
 * 3. Valid CL reference & mandatory client `Idempotency-Key` (`400 IDEMPOTENCY_KEY_REQUIRED`)
 * 4. Configured Orion2 integration (`503 ORION2_UNCONFIGURED`)
 * 5. Enforced Cedar write authorization (`authorizeClWrite`, `403`/`503`)
 * 6. Live `mega2` `Open` CL `(link, path, to_hash, head_revision)` check (`409 CL_NOT_OPEN`)
 * 7. 60s `task.write` JWT `POST /v1/tasks` with `head_revision` + `refs/cl/<link>` (`409` passthrough)
 */
export async function POST(
  request: Request,
  context: TriggerRouteContext,
): Promise<NextResponse> {
  const csrfFailure = requireSameOriginCsrf(request);
  if (csrfFailure) {
    csrfFailure.headers.set("cache-control", "no-store");
    return csrfFailure;
  }

  const actor = await resolveWebActor(request.headers);
  if (!actor) {
    const unauthorized = unauthorizedMegaResponse(request);
    const res = megaFailureResponse(unauthorized.body, unauthorized.status);
    res.headers.set("cache-control", "no-store");
    return res;
  }

  const { n } = await context.params;
  if (!isCLReference(n)) {
    return failureJson(
      400,
      "BAD_REQUEST",
      "errors.mega.badRequest",
      "Invalid Change List identifier",
    );
  }

  const idempotencyKey = parseMandatoryIdempotencyKey(request.headers);
  if (!idempotencyKey) {
    return failureJson(
      400,
      IDEMPOTENCY_KEY_REQUIRED_CODE,
      "errors.mega.badRequest",
      "A valid client Idempotency-Key header is required",
    );
  }

  const bodyResult = await parseOptionalTargets(request);
  if (!bodyResult.ok) {
    return failureJson(
      bodyResult.status,
      bodyResult.code,
      "errors.mega.badRequest",
      bodyResult.message,
    );
  }

  if (!isOrion2Configured()) {
    return failureJson(
      503,
      ORION2_UNCONFIGURED_CODE,
      "errors.mega.internal",
      "Orion2 integration is not configured",
    );
  }

  let orionConfig: ReturnType<typeof resolveOrion2Config>;
  try {
    orionConfig = resolveOrion2Config();
  } catch (error) {
    if (error instanceof OrionConfigError) {
      return failureJson(
        503,
        ORION2_UNCONFIGURED_CODE,
        "errors.mega.internal",
        "Orion2 integration is not properly configured",
      );
    }
    throw error;
  }

  try {
    const db = getDb();
    const clNumber = await resolveCLNumber(db, n);
    const link = await resolveMegaClLinkByNumber(db, clNumber);

    // Enforced Cedar `editMergeRequest` authorization BEFORE touching Orion2.
    const authz = await authorizeClWrite(actor, link, request.headers, { db });

    const detail = await fetchMega2ClDetail(authz.clLink, { headers: request.headers });
    if (detail.link !== authz.clLink) {
      return failureJson(
        503,
        "MEGA2_UPSTREAM_MISMATCH",
        "errors.mega.internal",
        "Change List detail response did not match authorized CL link",
      );
    }
    if (detail.status !== "Open") {
      return failureJson(
        409,
        CL_NOT_OPEN_CODE,
        "errors.mega.conflict",
        "Checks can only be triggered for Open Change Lists",
      );
    }

    const created = await createTask(
      {
        idempotencyKey,
        ...(bodyResult.targets ? { targets: bodyResult.targets } : {}),
        source: {
          repo_path: detail.path,
          commit_sha: detail.to_hash,
          cl_link: authz.clLink,
          ref_name: `refs/cl/${authz.clLink}`,
          head_revision: detail.head_revision,
        },
      },
      { config: orionConfig },
    );

    return NextResponse.json(
      { data: created },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof OrionClientError) {
      if (error.status === 409) {
        const safeCode = ALLOWED_ORION_409_CODES.has(error.code)
          ? error.code
          : "ORION_TASK_CONFLICT";
        return failureJson(
          409,
          safeCode,
          "errors.mega.conflict",
          "Task trigger rejected due to Change List conflict or stale head revision",
        );
      }
      if (error.status === 400) {
        return failureJson(
          400,
          "ORION_INVALID_REQUEST",
          "errors.mega.badRequest",
          "Invalid Orion2 task request",
        );
      }
      return failureJson(
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
}
