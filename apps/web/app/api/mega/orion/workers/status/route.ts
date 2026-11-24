import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, user } from "@megaui/database";
import {
  MegaForbiddenError,
  MegaUnauthorizedError,
  assertWorkspaceMember,
} from "@megaui/engine";
import {
  ORION_WORKER_STATUSES,
  listWorkers,
  type OrionWorkerStatus,
} from "@megaui/engine/services/orion2";

import { OrionAuthzError } from "@/lib/adapter/orion-authz";
import {
  mapOrionRouteError,
  orionFailureResponse,
  orionSuccessResponse,
  parsePositiveIntQuery,
  requireConfiguredOrion2,
  requireOrionActor,
  validateSingleQueryParams,
} from "../../shared";

// Client-supplied `environment_id` is accepted only to be strictly ignored so
// requests are always pinned to server-side `ORION2_ENVIRONMENT_ID` (`CLB-28`).
const ALLOWED_QUERY_KEYS: ReadonlySet<string> = new Set([
  "status",
  "limit",
  "cursor",
  "environment_id",
]);
const VALID_WORKER_STATUS_SET = new Set<string>(ORION_WORKER_STATUSES);

async function requireActiveWorkspaceMember(userId: string): Promise<void> {
  try {
    const db = getDb();
    const verifiedId = await assertWorkspaceMember(db, userId);
    const [row] = await db
      .select({ id: user.id, banned: user.banned })
      .from(user)
      .where(eq(user.id, verifiedId))
      .limit(1);
    if (!row || row.banned === true) {
      throw new OrionAuthzError(
        403,
        "WORKSPACE_MEMBER_REQUIRED",
        "Only active workspace members can perform this action",
      );
    }
  } catch (error) {
    if (error instanceof OrionAuthzError) throw error;
    if (error instanceof MegaUnauthorizedError) {
      throw new OrionAuthzError(401, "unauthenticated", "Authentication required");
    }
    if (error instanceof MegaForbiddenError) {
      throw new OrionAuthzError(
        403,
        "WORKSPACE_MEMBER_REQUIRED",
        "Only workspace members can perform this action",
      );
    }
    throw new OrionAuthzError(
      503,
      "ci_authz_unavailable",
      "Workspace membership verification unavailable",
    );
  }
}

/**
 * `GET /api/mega/orion/workers/status` (`CLB-28`):
 * Requires configured Orion2, signed-in Web actor, and active workspace
 * membership (`assertWorkspaceMember` + non-banned). Always pins the 60s
 * `task.read` JWT to server-side `ORION2_ENVIRONMENT_ID` (ignoring any
 * client-supplied `environment_id`).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const configured = requireConfiguredOrion2();
  if (!configured.ok) return configured.response;

  const actorResult = await requireOrionActor(request);
  if (!actorResult.ok) return actorResult.response;

  try {
    await requireActiveWorkspaceMember(actorResult.actor.userId);
  } catch (error) {
    return mapOrionRouteError(error, request);
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

  const rawStatus = searchParams.get("status");
  if (rawStatus !== null && !VALID_WORKER_STATUS_SET.has(rawStatus)) {
    return orionFailureResponse(
      400,
      "BAD_REQUEST",
      "errors.mega.badRequest",
      "Invalid worker status filter",
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
    const data = await listWorkers(
      {
        ...(rawStatus !== null ? { status: rawStatus as OrionWorkerStatus } : {}),
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
