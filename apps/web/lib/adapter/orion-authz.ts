import { and, eq, ne, or, sql } from "drizzle-orm";
import { getDb, user, type Database } from "@megaui/database";
import {
  MegaForbiddenError,
  MegaUnauthorizedError,
  assertWorkspaceMember,
  checkMega2ClCiAuthz,
  type Mega2CiAuthzAction,
} from "@megaui/engine";
import {
  OrionClientError,
  OrionConfigError,
  getTask,
  isOrion2Configured,
  isValidOrionId,
  listTasks,
  resolveOrion2Config,
  type TaskGetResponse,
  type TaskSummaryItem,
} from "@megaui/engine/services/orion2";

import type { WebActor } from "@/lib/enterprise-session";
import { deriveMega2Actor, feishuMega2Principal } from "@/lib/mega2-session";

export type OrionAuthzHttpStatus = 400 | 401 | 403 | 404 | 503;

export class OrionAuthzError extends Error {
  readonly status: OrionAuthzHttpStatus;
  readonly code: string;

  constructor(status: OrionAuthzHttpStatus, code: string, message: string) {
    super(message);
    this.name = "OrionAuthzError";
    this.status = status;
    this.code = code;
  }
}

export interface OrionAuthzOptions {
  readonly db?: Database;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ClAuthzResult {
  readonly actorUserId: string;
  readonly clLink: string;
  readonly action: Mega2CiAuthzAction;
  readonly principal: string;
}

export type OrionTaskAccessTarget =
  | { readonly taskId: string; readonly attemptId?: undefined }
  | { readonly attemptId: string; readonly taskId?: undefined };

export interface TaskAuthzResult extends ClAuthzResult {
  readonly taskId: string;
  readonly environmentId: string;
  readonly attemptId?: string;
  readonly task?: TaskGetResponse;
  readonly taskSummary?: TaskSummaryItem;
}

interface VerifiedWorkspaceMember {
  readonly userId: string;
  readonly expectedPrincipal: string;
}

const VALID_CL_LINK_RE = /^[A-Za-z0-9._-]{1,128}$/;

function validateClLink(rawLink: string): string {
  const link = rawLink.trim();
  if (!link || link === "." || link === ".." || !VALID_CL_LINK_RE.test(link)) {
    throw new OrionAuthzError(400, "INVALID_CL_LINK", "Invalid Change List link");
  }
  return link;
}

function hasCookieHeader(headers: HeadersInit): boolean {
  const normalized = new Headers(headers);
  const cookie = normalized.get("cookie");
  return typeof cookie === "string" && cookie.trim().length > 0;
}

/**
 * Computes the single authoritative, case-sensitive `mega2` principal for a verified
 * `WebActor` using `@/lib/mega2-session`'s exact session-projection rules (`GC-02`):
 * - Feishu actor: `feishuMega2Principal(userId)` (`fs_<userId>`)
 * - Legacy actor: `deriveMega2Actor({ name, email })` (matching `mega2` `into_login_user`)
 */
function resolveExpectedMega2Principal(
  actor: WebActor,
  row: { readonly name: string; readonly email: string | null },
): string | undefined {
  if (actor.kind === "feishu") {
    return feishuMega2Principal(actor.userId);
  }
  return deriveMega2Actor({ name: row.name, email: row.email });
}

async function assertActorIsWorkspaceMember(
  actor: WebActor | null | undefined,
  db: Database,
): Promise<VerifiedWorkspaceMember> {
  const userId = actor?.userId?.trim();
  if (!actor || !userId) {
    throw new OrionAuthzError(401, "unauthenticated", "Authentication required");
  }
  try {
    const verifiedId = await assertWorkspaceMember(db, userId);
    const [row] = await db
      .select({ id: user.id, name: user.name, email: user.email, banned: user.banned })
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
    const expectedPrincipal = resolveExpectedMega2Principal(actor, {
      name: row.name,
      email: row.email,
    });
    if (!expectedPrincipal) {
      throw new OrionAuthzError(
        403,
        "ci_authz_principal_mismatch",
        "Unable to derive authoritative mega2 principal for web actor",
      );
    }

    // Fail closed if any other workspace user derives the same mega2 principal
    // (mirrors mega2-session.ts's principal-conflict guard across all actors).
    const conflictConditions = [
      eq(user.name, expectedPrincipal),
      sql`strpos(${user.email}, ${expectedPrincipal}) > 0`,
      ...(expectedPrincipal.startsWith("fs_")
        ? [eq(user.id, expectedPrincipal.slice(3))]
        : []),
    ];
    const candidates = await db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(and(ne(user.id, verifiedId), or(...conflictConditions)));
    for (const candidate of candidates) {
      if (candidate.id === verifiedId) continue;
      const derivedLegacy = deriveMega2Actor({
        name: candidate.name,
        email: candidate.email,
      });
      if (
        derivedLegacy === expectedPrincipal ||
        feishuMega2Principal(candidate.id) === expectedPrincipal
      ) {
        throw new OrionAuthzError(
          403,
          "ci_authz_principal_conflict",
          "Derived mega2 principal is not uniquely bound to the authenticated web actor",
        );
      }
    }

    return {
      userId: verifiedId,
      expectedPrincipal,
    };
  } catch (error) {
    if (error instanceof OrionAuthzError) {
      throw error;
    }
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

async function probeMega2CedarClAuthz(
  member: VerifiedWorkspaceMember,
  clLink: string,
  action: Mega2CiAuthzAction,
  headers: HeadersInit,
  options: OrionAuthzOptions,
): Promise<{ readonly clLink: string; readonly action: Mega2CiAuthzAction; readonly principal: string }> {
  const validLink = validateClLink(clLink);
  if (!hasCookieHeader(headers)) {
    throw new OrionAuthzError(401, "unauthenticated", "mega2 session authentication required");
  }
  const env = (options.env ?? process.env) as NodeJS.ProcessEnv;

  const decision = await checkMega2ClCiAuthz(
    validLink,
    action,
    {
      headers,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    },
    env,
  );

  if (decision.kind === "allowed") {
    if (decision.principal !== member.expectedPrincipal) {
      throw new OrionAuthzError(
        403,
        "ci_authz_principal_mismatch",
        "Authenticated web actor does not match mega2 session principal",
      );
    }
    return {
      clLink: decision.clLink,
      action: decision.action,
      principal: decision.principal,
    };
  }
  if (decision.kind === "unauthenticated") {
    throw new OrionAuthzError(401, decision.code, decision.message);
  }
  if (decision.kind === "denied") {
    throw new OrionAuthzError(403, decision.code, decision.message);
  }
  if (decision.kind === "not_found") {
    throw new OrionAuthzError(404, decision.code, decision.message);
  }
  throw new OrionAuthzError(503, decision.code, "CI authorization service unavailable");
}

/**
 * Fail-closed CL read authorization (`CLB-23` / `ADR-CLB-05`):
 * 1. Verifies the actor is an active, non-banned workspace member in Postgres.
 * 2. Probes `mega2` `GET /api/v1/cl/{link}/ci-authz?action=read` (enforced Cedar `viewRepo`)
 *    and binds the returned `mega2` principal to the verified web actor's identity.
 * Never mints an Orion2 JWT.
 */
export async function authorizeClRead(
  actor: WebActor | null | undefined,
  clLink: string,
  headers: HeadersInit,
  options: OrionAuthzOptions = {},
): Promise<ClAuthzResult> {
  const db = options.db ?? getDb();
  const member = await assertActorIsWorkspaceMember(actor, db);
  const decision = await probeMega2CedarClAuthz(member, clLink, "read", headers, options);
  return {
    actorUserId: member.userId,
    clLink: decision.clLink,
    action: decision.action,
    principal: decision.principal,
  };
}

/**
 * Fail-closed CL write authorization (`CLB-23` / `ADR-CLB-05`):
 * 1. Verifies the actor is an active, non-banned workspace member in Postgres.
 * 2. Probes `mega2` `GET /api/v1/cl/{link}/ci-authz?action=write` (enforced Cedar `editMergeRequest`)
 *    and binds the returned `mega2` principal to the verified web actor's identity.
 * Never mints an Orion2 JWT.
 */
export async function authorizeClWrite(
  actor: WebActor | null | undefined,
  clLink: string,
  headers: HeadersInit,
  options: OrionAuthzOptions = {},
): Promise<ClAuthzResult> {
  const db = options.db ?? getDb();
  const member = await assertActorIsWorkspaceMember(actor, db);
  const decision = await probeMega2CedarClAuthz(member, clLink, "write", headers, options);
  return {
    actorUserId: member.userId,
    clLink: decision.clLink,
    action: decision.action,
    principal: decision.principal,
  };
}

function classifyOrionLookupError(error: unknown): never {
  if (error instanceof OrionAuthzError) {
    throw error;
  }
  if (error instanceof OrionConfigError) {
    throw new OrionAuthzError(
      503,
      "ORION2_UNCONFIGURED",
      "Orion2 integration is not properly configured",
    );
  }
  if (error instanceof OrionClientError) {
    if (error.status === 404 || error.status === 403) {
      throw new OrionAuthzError(
        403,
        "ORION_TASK_ACCESS_DENIED",
        "Access to Orion task is denied",
      );
    }
    if (error.status === 400) {
      throw new OrionAuthzError(
        400,
        "INVALID_ORION_ID",
        "Invalid Orion identifier",
      );
    }
    throw new OrionAuthzError(
      503,
      "ORION_UPSTREAM_UNAVAILABLE",
      "Orion2 service unavailable",
    );
  }
  throw new OrionAuthzError(
    503,
    "ORION_UPSTREAM_UNAVAILABLE",
    "Orion2 service unavailable",
  );
}

/**
 * Fail-closed Orion task / attempt resource authorization (`CLB-23` / `ADR-CLB-05`):
 * 1. Verifies active workspace membership and request cookie presence before any Orion2 call.
 * 2. Performs an internal read-only ownership lookup scoped to server-bound
 *    `ORION2_ENVIRONMENT_ID` (`taskId` via `GET /v1/tasks/{taskId}`; `attemptId` via
 *    `GET /v1/tasks?attempt_id=` covering both latest and historical attempts) solely to
 *    discover the owning `source.cl_link`. Task metadata is never returned to the caller
 *    and no operation JWT (`task.write` / `log.read` / downstream read) is minted unless
 *    Cedar authorization succeeds.
 * 3. Rejects missing tasks, cross-environment tasks, and tasks without `source.cl_link` with `403`.
 * 4. Enforces `mega2` Cedar `viewRepo` (`read`) or `editMergeRequest` (`write`) on the owning CL
 *    and verifies the `mega2` principal matches the authenticated web actor.
 */
export async function authorizeTaskAccess(
  actor: WebActor | null | undefined,
  target: OrionTaskAccessTarget,
  action: Mega2CiAuthzAction,
  headers: HeadersInit,
  options: OrionAuthzOptions = {},
): Promise<TaskAuthzResult> {
  if (action !== "read" && action !== "write") {
    throw new OrionAuthzError(400, "INVALID_AUTHZ_ACTION", "Action must be 'read' or 'write'");
  }

  const db = options.db ?? getDb();
  const member = await assertActorIsWorkspaceMember(actor, db);

  if (!hasCookieHeader(headers)) {
    throw new OrionAuthzError(401, "unauthenticated", "mega2 session authentication required");
  }

  const hasTaskId = typeof target.taskId === "string" && target.taskId.length > 0;
  const hasAttemptId = typeof target.attemptId === "string" && target.attemptId.length > 0;
  if (hasTaskId === hasAttemptId) {
    throw new OrionAuthzError(
      400,
      "INVALID_ORION_ID",
      "Exactly one of taskId or attemptId is required",
    );
  }

  const rawId = hasTaskId ? target.taskId! : target.attemptId!;
  if (!isValidOrionId(rawId)) {
    throw new OrionAuthzError(400, "INVALID_ORION_ID", "Invalid Orion identifier");
  }

  const env = (options.env ?? process.env) as NodeJS.ProcessEnv;
  if (!isOrion2Configured(env)) {
    throw new OrionAuthzError(
      503,
      "ORION2_UNCONFIGURED",
      "Orion2 integration is not configured",
    );
  }

  let config;
  try {
    config = resolveOrion2Config(env);
  } catch (error) {
    classifyOrionLookupError(error);
  }

  let resolvedTaskId: string;
  let clLink: string | undefined;
  let task: TaskGetResponse | undefined;
  let taskSummary: TaskSummaryItem | undefined;

  try {
    if (hasTaskId) {
      const fetched = await getTask(
        rawId,
        { config, signal: options.signal, timeoutMs: options.timeoutMs },
        env,
      );
      if (fetched.task_id !== rawId) {
        throw new OrionAuthzError(
          403,
          "ORION_TASK_ACCESS_DENIED",
          "Access to Orion task is denied",
        );
      }
      resolvedTaskId = fetched.task_id;
      clLink = fetched.source?.cl_link?.trim() || undefined;
      task = fetched;
    } else {
      const list = await listTasks(
        { attemptId: rawId, limit: 2 },
        { config, signal: options.signal, timeoutMs: options.timeoutMs },
        env,
      );
      if (list.items.length !== 1) {
        throw new OrionAuthzError(
          403,
          "ORION_TASK_ACCESS_DENIED",
          "Access to Orion attempt is denied",
        );
      }
      const summary = list.items[0]!;
      const matchedAttempt = summary.matched_attempt_id ?? summary.attempt_id;
      if (matchedAttempt !== rawId) {
        throw new OrionAuthzError(
          403,
          "ORION_TASK_ACCESS_DENIED",
          "Access to Orion attempt is denied",
        );
      }
      resolvedTaskId = summary.task_id;
      clLink = summary.source?.cl_link?.trim() || undefined;
      taskSummary = summary;
    }
  } catch (error) {
    classifyOrionLookupError(error);
  }

  if (!clLink) {
    throw new OrionAuthzError(
      403,
      "ORION_TASK_ACCESS_DENIED",
      "Orion task is not bound to a Change List",
    );
  }

  const decision = await probeMega2CedarClAuthz(member, clLink, action, headers, options);

  return {
    actorUserId: member.userId,
    clLink: decision.clLink,
    action: decision.action,
    principal: decision.principal,
    taskId: resolvedTaskId,
    environmentId: config.environmentId,
    ...(hasAttemptId ? { attemptId: rawId } : {}),
    ...(task ? { task } : {}),
    ...(taskSummary ? { taskSummary } : {}),
  };
}
