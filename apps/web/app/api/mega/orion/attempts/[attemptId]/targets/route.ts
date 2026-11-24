import { NextResponse } from "next/server";
import { isValidOrionId, listAttemptTargets } from "@megaui/engine/services/orion2";

import { authorizeTaskAccess } from "@/lib/adapter/orion-authz";
import {
  mapOrionRouteError,
  orionFailureResponse,
  orionSuccessResponse,
  parsePositiveIntQuery,
  requireConfiguredOrion2,
  requireOrionActor,
  validateSingleQueryParams,
} from "../../../shared";

const ALLOWED_QUERY_KEYS: ReadonlySet<string> = new Set(["limit", "cursor"]);

interface AttemptTargetsRouteContext {
  readonly params: Promise<{ readonly attemptId: string }>;
}

/**
 * `GET /api/mega/orion/attempts/[attemptId]/targets` (`CLB-27`):
 * Requires configured Orion2, signed-in Web actor, valid `attemptId`, valid
 * pagination query parameters, and `authorizeTaskAccess({ attemptId }, "read")`
 * (resolving both latest and historical attempts via `CLB-01` and enforcing
 * Cedar `viewRepo` + server-bound `ORION2_ENVIRONMENT_ID`) before querying
 * `GET /v1/attempts/{attemptId}/targets` with a 60s `task.read` JWT.
 */
export async function GET(
  request: Request,
  context: AttemptTargetsRouteContext,
): Promise<NextResponse> {
  const configured = requireConfiguredOrion2();
  if (!configured.ok) return configured.response;

  const actorResult = await requireOrionActor(request);
  if (!actorResult.ok) return actorResult.response;

  const { attemptId } = await context.params;
  if (!isValidOrionId(attemptId)) {
    return orionFailureResponse(
      400,
      "INVALID_ORION_ID",
      "errors.mega.badRequest",
      "Invalid Orion attempt identifier",
    );
  }

  const { searchParams } = new URL(request.url);
  const queryCheck = validateSingleQueryParams(searchParams, ALLOWED_QUERY_KEYS);
  if (!queryCheck.ok) {
    return orionFailureResponse(
      400,
      "BAD_REQUEST",
      "errors.mega.badRequest",
      queryCheck.message,
    );
  }

  const limitParsed = parsePositiveIntQuery(searchParams.get("limit"), 1, 100);
  if (!limitParsed.ok) {
    return orionFailureResponse(
      400,
      "BAD_REQUEST",
      "errors.mega.badRequest",
      "limit must be an integer between 1 and 100",
    );
  }

  const rawCursor = searchParams.get("cursor");
  if (rawCursor !== null && (rawCursor.trim().length === 0 || rawCursor.length > 256)) {
    return orionFailureResponse(
      400,
      "BAD_REQUEST",
      "errors.mega.badRequest",
      "Invalid cursor query parameter",
    );
  }

  try {
    await authorizeTaskAccess(
      actorResult.actor,
      { attemptId },
      "read",
      request.headers,
    );
    const data = await listAttemptTargets(
      attemptId,
      {
        ...(limitParsed.value !== undefined ? { limit: limitParsed.value } : {}),
        ...(rawCursor !== null ? { cursor: rawCursor } : {}),
      },
      { config: configured.config },
    );
    return orionSuccessResponse(data);
  } catch (error) {
    return mapOrionRouteError(error, request);
  }
}
