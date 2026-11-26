import { NextResponse } from "next/server";
import { cancelTask, isValidOrionId } from "@megaui/engine/services/orion2";

import { requireSameOriginCsrf } from "@/lib/adapter/csrf";
import { authorizeTaskAccess } from "@/lib/adapter/orion-authz";
import {
  mapOrionRouteError,
  orionFailureResponse,
  orionSuccessResponse,
  requireConfiguredOrion2,
  requireOrionActor,
  validateSingleQueryParams,
} from "../../../shared";

const EMPTY_QUERY_KEYS: ReadonlySet<string> = new Set();

interface TaskCancelRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

/**
 * `POST /api/mega/orion/tasks/[taskId]/cancel` (`CLB-30`):
 * Enforces canonical-origin CSRF (`403`), Orion2 configuration (`503`),
 * signed-in Web actor (`401`), valid `taskId` (`400`), and
 * `authorizeTaskAccess({ taskId }, "write")` (enforced Cedar `editMergeRequest`
 * + server-bound `ORION2_ENVIRONMENT_ID`) before forwarding
 * `POST /v1/tasks/{taskId}/cancel` with a 60s `task.write` JWT.
 */
export async function POST(
  request: Request,
  context: TaskCancelRouteContext,
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

  try {
    await authorizeTaskAccess(
      actorResult.actor,
      { taskId },
      "write",
      request.headers,
    );
    const data = await cancelTask(taskId, { config: configured.config });
    return orionSuccessResponse(data);
  } catch (error) {
    return mapOrionRouteError(error, request);
  }
}
