import { NextResponse } from "next/server";
import {
  ORION_TASK_STATUSES,
  listTasks,
  type OrionTaskStatus,
} from "@megaui/engine/services/orion2";

import { authorizeClRead } from "@/lib/adapter/orion-authz";
import {
  isValidClLinkParam,
  mapOrionRouteError,
  orionFailureResponse,
  orionSuccessResponse,
  parsePositiveIntQuery,
  requireConfiguredOrion2,
  requireOrionActor,
  validateSingleQueryParams,
} from "../shared";

const ALLOWED_QUERY_KEYS = new Set(["cl_link", "status", "limit", "cursor"]);
const VALID_STATUS_SET = new Set<string>(ORION_TASK_STATUSES);

/**
 * `GET /api/mega/orion/tasks?cl_link=...` (`CLB-26`):
 * Requires configured Orion2, signed-in Web actor, valid `cl_link`, and enforced
 * Cedar `viewRepo` authorization before minting a 60s `task.read` JWT.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const configured = requireConfiguredOrion2();
  if (!configured.ok) return configured.response;

  const actorResult = await requireOrionActor(request);
  if (!actorResult.ok) return actorResult.response;

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

  const clLink = searchParams.get("cl_link");
  if (!isValidClLinkParam(clLink)) {
    return orionFailureResponse(
      400,
      "INVALID_CL_LINK",
      "errors.mega.badRequest",
      "A valid cl_link query parameter is required",
    );
  }

  const rawStatus = searchParams.get("status");
  if (rawStatus !== null && !VALID_STATUS_SET.has(rawStatus)) {
    return orionFailureResponse(
      400,
      "BAD_REQUEST",
      "errors.mega.badRequest",
      "Invalid task status filter",
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
    const authz = await authorizeClRead(actorResult.actor, clLink, request.headers);
    const data = await listTasks(
      {
        clLink: authz.clLink,
        ...(rawStatus !== null ? { status: rawStatus as OrionTaskStatus } : {}),
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
