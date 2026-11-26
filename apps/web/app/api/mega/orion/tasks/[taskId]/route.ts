import { NextResponse } from "next/server";
import { isValidOrionId } from "@megaui/engine/services/orion2";

import { authorizeTaskAccess } from "@/lib/adapter/orion-authz";
import {
  mapOrionRouteError,
  orionFailureResponse,
  orionSuccessResponse,
  requireConfiguredOrion2,
  requireOrionActor,
  validateSingleQueryParams,
} from "../../shared";

const EMPTY_QUERY_KEYS: ReadonlySet<string> = new Set();

interface TaskDetailRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

/**
 * `GET /api/mega/orion/tasks/[taskId]` (`CLB-26`):
 * Requires configured Orion2, signed-in Web actor, valid `taskId`, and
 * `authorizeTaskAccess({ taskId }, "read")` (server-bound `ORION2_ENVIRONMENT_ID`,
 * owning `cl_link`, enforced Cedar `viewRepo`, and exact principal binding).
 */
export async function GET(
  request: Request,
  context: TaskDetailRouteContext,
): Promise<NextResponse> {
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
    const authz = await authorizeTaskAccess(
      actorResult.actor,
      { taskId },
      "read",
      request.headers,
    );
    if (!authz.task) {
      return orionFailureResponse(
        503,
        "ORION_UPSTREAM_UNAVAILABLE",
        "errors.mega.internal",
        "Orion2 task detail unavailable",
      );
    }
    return orionSuccessResponse(authz.task);
  } catch (error) {
    return mapOrionRouteError(error, request);
  }
}
