import type { CheckRun, CIStatus, PipelineStage } from "@megaui/core";
import { getDb, type Database } from "@megaui/database";
import {
  fetchMega2ClDetail,
  fetchMega2ClMergeBox,
  type CLChecksView,
  type Mega2Condition,
} from "@megaui/engine";
import {
  OrionClientError,
  OrionConfigError,
  isOrion2Configured,
  listAttemptTargets,
  listTasks,
  resolveOrion2Config,
  type TargetStatusItem,
  type TaskSummaryItem,
} from "@megaui/engine/services/orion2";

import type { WebActor } from "@/lib/enterprise-session";
import { OrionAuthzError, authorizeClRead } from "./orion-authz";

const MAX_TASK_PAGES = 20;
const TASK_PAGE_LIMIT = 100;
const MAX_TARGET_PAGES = 10;
const TARGET_PAGE_LIMIT = 100;

export interface OrionCLChecksView extends CLChecksView {
  readonly clLink?: string;
  readonly headCommit?: string;
  readonly headRevision?: number;
  readonly repoPath?: string;
  readonly latestTask?: TaskSummaryItem | null;
  readonly tasks?: readonly TaskSummaryItem[];
  readonly mergeBoxCi?: Mega2Condition | null;
}

export interface GetOrionBackedClChecksParams {
  readonly actor: WebActor | null | undefined;
  readonly clLink: string;
  readonly headers: HeadersInit;
  readonly db?: Database;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function mapTargetStatusToCiStatus(status: TargetStatusItem["status"]): CIStatus {
  if (status === "success") return "passing";
  if (status === "failed") return "failing";
  if (status === "running") return "running";
  return "queued";
}

function mapTaskStatusToCiStatus(status: string): CIStatus {
  const lower = status.toLowerCase();
  if (lower === "succeeded" || lower === "passed") return "passing";
  if (lower === "failed") return "failing";
  if (lower === "running") return "running";
  if (lower === "cancelled" || lower === "canceled") return "skipped";
  return "queued";
}

function computeDurationSeconds(startedAt: string, completedAt: string): number | undefined {
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(completedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return undefined;
  }
  return Math.round((endMs - startMs) / 1000);
}

async function fetchAllClTasks(
  clLink: string,
  config: ReturnType<typeof resolveOrion2Config>,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<TaskSummaryItem[]> {
  const collected: TaskSummaryItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let lastNextCursor: string | null = null;
  for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
    const res = await listTasks(
      { clLink, limit: TASK_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      { config, signal, timeoutMs },
      env,
    );
    collected.push(...res.items);
    lastNextCursor = res.next_cursor;
    if (!res.next_cursor) {
      return collected;
    }
    if (seenCursors.has(res.next_cursor)) {
      throw new OrionAuthzError(
        503,
        "ORION_UPSTREAM_UNAVAILABLE",
        "Orion2 task pagination cursor loop detected",
      );
    }
    seenCursors.add(res.next_cursor);
    cursor = res.next_cursor;
  }
  if (lastNextCursor) {
    throw new OrionAuthzError(
      503,
      "ORION_UPSTREAM_UNAVAILABLE",
      "Orion2 task pagination exceeded safety bound",
    );
  }
  return collected;
}

async function fetchAllAttemptTargets(
  attemptId: string,
  config: ReturnType<typeof resolveOrion2Config>,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<TargetStatusItem[]> {
  const collected: TargetStatusItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let lastNextCursor: string | null = null;
  for (let page = 0; page < MAX_TARGET_PAGES; page += 1) {
    const res = await listAttemptTargets(
      attemptId,
      { limit: TARGET_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      { config, signal, timeoutMs },
      env,
    );
    collected.push(...res.items);
    lastNextCursor = res.next_cursor;
    if (!res.next_cursor) {
      return collected;
    }
    if (seenCursors.has(res.next_cursor)) {
      throw new OrionAuthzError(
        503,
        "ORION_UPSTREAM_UNAVAILABLE",
        "Orion2 target pagination cursor loop detected",
      );
    }
    seenCursors.add(res.next_cursor);
    cursor = res.next_cursor;
  }
  if (lastNextCursor) {
    throw new OrionAuthzError(
      503,
      "ORION_UPSTREAM_UNAVAILABLE",
      "Orion2 target pagination exceeded safety bound",
    );
  }
  return collected;
}

function targetToCheckRun(target: TargetStatusItem): CheckRun {
  const isTerminal = target.status === "success" || target.status === "failed";
  const durationSeconds = isTerminal
    ? computeDurationSeconds(target.created_at, target.updated_at)
    : undefined;
  const matrix = [target.category, target.action].filter(Boolean).join(" / ") || undefined;
  return {
    id: target.status_id,
    name: target.target_path,
    status: mapTargetStatusToCiStatus(target.status),
    ...(matrix ? { matrix } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    logId: target.attempt_id,
    startedAt: target.created_at,
    ...(isTerminal ? { completedAt: target.updated_at } : {}),
  };
}

function taskSummaryToFallbackCheckRun(task: TaskSummaryItem): CheckRun {
  const status = mapTaskStatusToCiStatus(task.status);
  const isTerminal = status === "passing" || status === "failing" || status === "skipped";
  const durationSeconds = isTerminal
    ? computeDurationSeconds(task.created_at, task.updated_at)
    : undefined;
  return {
    id: task.attempt_id,
    name: task.targets.join(", ") || "Orion Build",
    status,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    logId: task.attempt_id,
    startedAt: task.created_at,
    ...(isTerminal ? { completedAt: task.updated_at } : {}),
  };
}

/**
 * Aggregates live `mega2` CL detail + Merge Box `CiStatus` with `orion2` task and
 * latest-attempt Buck2 target statuses into a backward-compatible `CLChecksView` (`CLB-24`).
 *
 * Security invariants:
 * - Always calls `authorizeClRead` BEFORE any `orion2` JWT is minted or sent.
 * - Never includes JWTs, secrets, or raw upstream credentials in the returned view.
 */
export async function getOrionBackedClChecks(
  params: GetOrionBackedClChecksParams,
): Promise<OrionCLChecksView> {
  const env = (params.env ?? process.env) as NodeJS.ProcessEnv;
  const db = params.db ?? getDb();

  // Fail closed on enforced Cedar `viewRepo` BEFORE touching Orion2.
  const authz = await authorizeClRead(params.actor, params.clLink, params.headers, {
    db,
    env,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });

  if (!isOrion2Configured(env)) {
    throw new OrionAuthzError(
      503,
      "ORION2_UNCONFIGURED",
      "Orion2 integration is not configured",
    );
  }

  let config: ReturnType<typeof resolveOrion2Config>;
  try {
    config = resolveOrion2Config(env);
  } catch (error) {
    if (error instanceof OrionConfigError) {
      throw new OrionAuthzError(
        503,
        "ORION2_UNCONFIGURED",
        "Orion2 integration is not properly configured",
      );
    }
    throw error;
  }

  try {
    const reqOpts = {
      headers: params.headers,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
    };
    const [tasks, mergeBox, detail] = await Promise.all([
      fetchAllClTasks(authz.clLink, config, env, params.signal, params.timeoutMs),
      fetchMega2ClMergeBox(authz.clLink, reqOpts, env),
      fetchMega2ClDetail(authz.clLink, reqOpts, env),
    ]);

    // Bind active check runs and pipeline strictly to the CL's current live
    // (head_revision, to_hash) so an older revision's passing build is never
    // presented as the current head's CI result.
    const latestTask =
      tasks.find(
        (task) =>
          task.source?.head_revision === detail.head_revision &&
          task.source?.commit_sha === detail.to_hash,
      ) ?? null;

    let checks: CheckRun[] = [];
    if (latestTask) {
      const targets = await fetchAllAttemptTargets(
        latestTask.attempt_id,
        config,
        env,
        params.signal,
        params.timeoutMs,
      );
      checks =
        targets.length > 0
          ? targets.map(targetToCheckRun)
          : [taskSummaryToFallbackCheckRun(latestTask)];
    }

    const pipeline: PipelineStage[] = latestTask
      ? [
          {
            id: latestTask.task_id,
            name: "Orion Buck2 Build",
            status: mapTaskStatusToCiStatus(latestTask.status),
            checks,
          },
        ]
      : [];

    const mergeBoxCi =
      mergeBox.merge_requirements?.conditions.find((c) => c.type === "CiStatus") ??
      null;

    return {
      pipeline,
      runner: latestTask ? "orion2" : "",
      ...(latestTask ? { queuedAt: latestTask.created_at } : {}),
      checks,
      logTail: [],
      benchmarks: [],
      clLink: authz.clLink,
      headCommit: detail.to_hash,
      headRevision: detail.head_revision,
      repoPath: detail.path,
      latestTask,
      tasks,
      mergeBoxCi,
    };
  } catch (error) {
    if (error instanceof OrionAuthzError) {
      throw error;
    }
    if (error instanceof OrionClientError || error instanceof OrionConfigError) {
      throw new OrionAuthzError(
        503,
        "ORION_UPSTREAM_UNAVAILABLE",
        "Orion2 checks aggregation unavailable",
      );
    }
    throw error;
  }
}
