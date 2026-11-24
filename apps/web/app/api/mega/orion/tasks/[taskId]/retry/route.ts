import { NextResponse } from "next/server";
import { isValidOrionId, retryTask } from "@megaui/engine/services/orion2";

import { requireSameOriginCsrf } from "@/lib/adapter/csrf";
import { authorizeTaskAccess } from "@/lib/adapter/orion-authz";
import {
  IDEMPOTENCY_KEY_REQUIRED_CODE,
  mapOrionRouteError,
  orionFailureResponse,
  orionSuccessResponse,
  parseMandatoryIdempotencyKey,
  requireConfiguredOrion2,
  requireOrionActor,
  validateSingleQueryParams,
} from "../../../shared";

const EMPTY_QUERY_KEYS: ReadonlySet<string> = new Set();

interface TaskRetryRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

/**
 * `POST /api/mega/orion/tasks/[taskId]/retry` (`CLB-29`):
 * Enforces canonical-origin CSRF (`403`), Orion2 configuration (`503`),
 * signed-in Web actor (`401`), valid `taskId` (`400`), mandatory single-value
 * client `Idempotency-Key` (`400 IDEMPOTENCY_KEY_REQUIRED`), and
 * `authorizeTaskAccess({ taskId }, "write")` (enforced Cedar `editMergeRequest`
 * + server-bound `ORION2_ENVIRONMENT_ID`) before forwarding `POST /v1/tasks/{taskId}/retry`
 * with a 60s `task.write` JWT and transparent `409 stale_head_revision` passthrough.
 */
export async function POST(
  request: Request,
  context: TaskRetryRouteContext,
): Promise<NextResponse> {
  const csrfRejected = requireSameOriginCsrf(request);
  if (csrfRejected) {
    csrfRejected.headers.set("cache-control", "no-store");
    return csrfRejected;
  }

  const configured = requireConfiguredOrion2();
  if (!configured.ok) return configured.response;

  const actorResult = await requireOrionActor(request);
  if (!actorResult.ok) return actorResult.response;

  const queryCheck = validateSingleQueryParams(
    new URL(request.url).searchParams,
    EMPTY_QUERY_KEYS,
  );
  if (!queryCheck.ok) {
    return orionFailureResponse(
      400,
      "BAD_REQUEST",
      "errors.mega.badRequest",
      queryCheck.message,
    );
  }

  const { taskId } = await context.params;
  if (!isValidOrionId(taskId)) {
    return orionFailureResponse(
      400,
      "INVALID_ORION_ID",
      "errors.mega.badRequest",
      "Invalid Orion task identifier",
    );
  }

  const idempotencyKey = parseMandatoryIdempotencyKey(request.headers);
  if (!idempotencyKey) {
    return orionFailureResponse(
      400,
      IDEMPOTENCY_KEY_REQUIRED_CODE,
      "errors.mega.badRequest",
      "A valid Idempotency-Key header is required",
    );
  }

  try {
    await authorizeTaskAccess(
      actorResult.actor,
      { taskId },
      "write",
      request.headers,
    );
    const data = await retryTask(taskId, {
      idempotencyKey,
      config: configured.config,
    });
    return orionSuccessResponse(data);
  } catch (error) {
    return mapOrionRouteError(error, request);
  }
}
