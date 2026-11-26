// megaui-only (WA-10 / CLB-33): CL Checks page with real Orion2 tasks,
// stable browser-side Idempotency-Key build controls, auto-polling, and live SSE logs.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import type { CIStatus } from "@megaui/core";
import { MegaApiError, megaFetch, megaGet, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { WorkspaceLoading } from "@/app/[lang]/workspace/components/workspace-loading";
import { useTranslation } from "@/hooks/use-translation";
import { useCurrentCL } from "../cl-route";
import { BuildLogViewer } from "./components/build-log-viewer";

interface OrionTaskSummary {
  readonly task_id: string;
  readonly attempt_id: string;
  readonly status: "pending" | "leased" | "running" | "succeeded" | "failed" | "cancelled";
  readonly targets?: readonly string[];
  readonly source?: {
    readonly commit_sha?: string;
    readonly cl_link?: string;
    readonly head_revision?: number;
  };
  readonly created_at?: string;
  readonly updated_at?: string;
}

interface ChecksView {
  pipeline: readonly { id: string; name: string; status: CIStatus }[];
  runner: string;
  queuedAt?: string;
  checks: readonly {
    id: string;
    name: string;
    status: CIStatus;
    matrix?: string;
    durationSeconds?: number;
    logCount?: number;
    passedCount?: number;
  }[];
  logTail: readonly unknown[];
  benchmarks: readonly unknown[];
  clLink?: string;
  headCommit?: string;
  headRevision?: number;
  repoPath?: string;
  latestTask?: OrionTaskSummary | null;
  tasks?: readonly OrionTaskSummary[];
}

const ACTIVE_POLL_INTERVAL_MS = 3000;

function generateOrionIdempotencyKey(action: "trigger" | "retry"): string {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `ui-${action}-${randomPart}`.slice(0, 128);
}

function isTaskActive(task: OrionTaskSummary | null | undefined): boolean {
  if (!task) return false;
  return task.status === "pending" || task.status === "leased" || task.status === "running";
}

function formatDuration(seconds: number | undefined): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
}

function heroTitle(
  status: CIStatus | "empty",
  labels: { allPassed: string; inProgress: string; someFailed: string },
): string {
  if (status === "passing") return labels.allPassed;
  if (status === "failing") return labels.someFailed;
  return labels.inProgress;
}

function aggregateStatus(checks: ChecksView["checks"]): CIStatus | "empty" {
  if (checks.length === 0) return "empty";
  if (checks.some((check) => check.status === "failing")) return "failing";
  if (checks.some((check) => check.status === "running" || check.status === "queued")) return "running";
  // All-skipped is not green (Bugbot R54): do not map to `passing`.
  if (checks.every((check) => check.status === "skipped")) return "skipped";
  if (checks.every((check) => check.status === "passing" || check.status === "skipped")) return "passing";
  return "running";
}

export default function CLChecksPage() {
  const cl = useCurrentCL();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const checksText = t.workspace.clDetail.checks;
  const clNumber = cl.number;

  // Stable browser-side Idempotency-Key store bound to `{ action, commitSha/taskId }`:
  // reused across network/transient retries; rotated only on success or binding change.
  const idempotencyKeysRef = useRef<Map<string, string>>(new Map());
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null);
  const [observedAttempts, setObservedAttempts] = useState<
    readonly { readonly attemptId: string; readonly status: string }[]
  >([]);
  const [actionError, setActionError] = useState<string | null>(null);

  const recordObservedAttempt = (attemptId: string | undefined, status: string) => {
    if (!attemptId) return;
    setObservedAttempts((prev) => {
      const existingIdx = prev.findIndex((item) => item.attemptId === attemptId);
      if (existingIdx >= 0) {
        if (prev[existingIdx]!.status === status) return prev;
        const copy = [...prev];
        copy[existingIdx] = { attemptId, status };
        return copy;
      }
      return [{ attemptId, status }, ...prev];
    });
  };

  const getOrCreateStableKey = (
    action: "trigger" | "retry",
    bindingToken: string,
  ): string => {
    const scopeKey = `${action}:${bindingToken}`;
    const existing = idempotencyKeysRef.current.get(scopeKey);
    if (existing) return existing;
    const created = generateOrionIdempotencyKey(action);
    idempotencyKeysRef.current.set(scopeKey, created);
    return created;
  };

  const rotateStableKey = (action: "trigger" | "retry", bindingToken: string) => {
    idempotencyKeysRef.current.delete(`${action}:${bindingToken}`);
  };

  const checksQuery = useQuery({
    queryKey: megaQueryKeys.clChecks(clNumber),
    queryFn: () => megaGet<ChecksView>(["cls", String(clNumber), "checks"]),
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const hasActiveCheck = data.checks.some(
        (check) => check.status === "queued" || check.status === "running",
      );
      return hasActiveCheck || isTaskActive(data.latestTask)
        ? ACTIVE_POLL_INTERVAL_MS
        : false;
    },
  });

  const latestAttemptId = checksQuery.data?.latestTask?.attempt_id ?? null;
  const latestCommitRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const data = checksQuery.data;
    if (!data) return;
    const entries: { readonly attemptId: string; readonly status: string }[] = [];
    if (data.latestTask?.attempt_id) {
      entries.push({ attemptId: data.latestTask.attempt_id, status: data.latestTask.status });
    }
    for (const task of data.tasks ?? []) {
      if (task.attempt_id) {
        entries.push({ attemptId: task.attempt_id, status: task.status });
      }
    }
    if (entries.length === 0) return;
    setObservedAttempts((prev) => {
      const merged = new Map<string, string>();
      for (const entry of entries) {
        if (!merged.has(entry.attemptId)) {
          merged.set(entry.attemptId, entry.status);
        }
      }
      for (const item of prev) {
        if (!merged.has(item.attemptId)) {
          merged.set(item.attemptId, item.status);
        }
      }
      const next = [...merged.entries()].map(([attemptId, status]) => ({ attemptId, status }));
      if (
        next.length === prev.length &&
        next.every((n, idx) => prev[idx]?.attemptId === n.attemptId && prev[idx]?.status === n.status)
      ) {
        return prev;
      }
      return next;
    });
  }, [checksQuery.data]);

  useEffect(() => {
    const headCommit = checksQuery.data?.headCommit;
    if (latestCommitRef.current !== undefined && headCommit !== latestCommitRef.current) {
      // Rotate any cached trigger key when the CL commit advances.
      for (const key of [...idempotencyKeysRef.current.keys()]) {
        if (key.startsWith("trigger:")) {
          idempotencyKeysRef.current.delete(key);
        }
      }
      setSelectedAttemptId(null);
    }
    latestCommitRef.current = headCommit;
  }, [checksQuery.data?.headCommit]);

  const triggerMutation = useMutation({
    mutationFn: async (bindingToken: string) => {
      const idempotencyKey = getOrCreateStableKey("trigger", bindingToken);
      return megaFetch<{ readonly attempt_id?: string; readonly status?: string }>(
        ["cls", String(clNumber), "checks", "trigger"],
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({}),
        },
      );
    },
    onSuccess: (data, bindingToken) => {
      setActionError(null);
      rotateStableKey("trigger", bindingToken);
      recordObservedAttempt(data?.attempt_id, data?.status ?? "accepted");
      setSelectedAttemptId(data?.attempt_id ?? null);
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.clChecks(clNumber) });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : String(error));
    },
  });

  const retryMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const idempotencyKey = getOrCreateStableKey("retry", taskId);
      return megaFetch<{ readonly attempt_id?: string; readonly status?: string }>(
        ["orion", "tasks", taskId, "retry"],
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
        },
      );
    },
    onSuccess: (data, taskId) => {
      setActionError(null);
      rotateStableKey("retry", taskId);
      recordObservedAttempt(data?.attempt_id, data?.status ?? "accepted");
      setSelectedAttemptId(data?.attempt_id ?? null);
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.clChecks(clNumber) });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : String(error));
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (taskId: string) =>
      megaFetch<unknown>(["orion", "tasks", taskId, "cancel"], {
        method: "POST",
      }),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.clChecks(clNumber) });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : String(error));
    },
  });

  if (checksQuery.isPending) {
    return (
      <section aria-busy="true" data-mega-cls="checks">
        <WorkspaceLoading label={checksText.loading} />
      </section>
    );
  }

  if (checksQuery.isError) {
    return (
      <section data-mega-cls="checks">
        <div role="alert" style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
          <p style={{ margin: 0 }}>{checksText.error}</p>
          <button data-mega-cls="retry" onClick={() => void checksQuery.refetch()} type="button">
            {checksText.retry}
          </button>
        </div>
      </section>
    );
  }

  const view = checksQuery.data;
  const status = aggregateStatus(view.checks);
  const ok = view.checks.filter((check) => check.status === "passing").length;
  const skipped = view.checks.filter((check) => check.status === "skipped").length;
  const totalDuration = view.checks.reduce((sum, check) => sum + (check.durationSeconds ?? 0), 0);

  const hasOrionContext = Boolean(
    view.clLink || view.latestTask || (view.tasks && view.tasks.length > 0),
  );
  const latestTask = view.latestTask ?? null;
  const tasks = view.tasks ?? [];
  const activeAttemptId = selectedAttemptId ?? latestAttemptId ?? tasks[0]?.attempt_id ?? null;
  const triggerBindingToken = `${view.headCommit ?? ""}:${view.headRevision ?? ""}:${view.clLink ?? clNumber}`;
  const anyActionPending =
    triggerMutation.isPending || retryMutation.isPending || cancelMutation.isPending;

  return (
    <section data-mega-cls="checks" style={{ display: "grid", gap: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
      <header
        data-mega-cls="checks-hero"
        data-status={status}
        style={{
          border: `1px solid ${MEGA_TOKENS.border}`,
          borderRadius: MEGA_RADIUS_TOKENS.md,
          padding: `calc(${MEGA_SPACING_TOKENS[8]} * 1.5)`,
        }}
      >
        <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0 }}>
          {heroTitle(status, checksText.hero)}
        </h2>
        {view.checks.length === 0 ? (
          <p data-mega-cls="checks-empty" style={{ color: MEGA_TOKENS.muted, margin: `${MEGA_SPACING_TOKENS[6]} 0 0` }}>
            {checksText.hero.summary
              .replace("{ok}", "0")
              .replace("{total}", "0")
              .replace("{skipped}", "0")
              .replace("{duration}", "—")}
          </p>
        ) : (
          <p style={{ color: MEGA_TOKENS.muted, margin: `${MEGA_SPACING_TOKENS[6]} 0 0` }}>
            {checksText.hero.summary
              .replace("{ok}", String(ok))
              .replace("{total}", String(view.checks.length))
              .replace("{skipped}", String(skipped))
              .replace("{duration}", formatDuration(totalDuration))}
          </p>
        )}
        <p style={{ color: MEGA_TOKENS.muted, margin: `${MEGA_SPACING_TOKENS[6]} 0 0` }}>
          {checksText.hero.kvRunner}: {view.runner || "—"}
          {view.queuedAt ? ` · ${checksText.hero.kvQueued}: ${view.queuedAt}` : ""}
        </p>
      </header>

      {hasOrionContext ? (
        <section
          data-mega-cls="orion-controls"
          style={{
            border: `1px solid ${MEGA_TOKENS.border}`,
            borderRadius: MEGA_RADIUS_TOKENS.md,
            display: "grid",
            gap: MEGA_SPACING_TOKENS[8],
            padding: `calc(${MEGA_SPACING_TOKENS[8]} * 1.5)`,
          }}
        >
          <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: MEGA_SPACING_TOKENS[8], justifyContent: "space-between" }}>
            <div>
              <h3 style={{ fontSize: "0.95rem", fontWeight: 650, margin: 0 }}>{checksText.controls.title}</h3>
              <p data-mega-cls="orion-task-meta" style={{ color: MEGA_TOKENS.muted, margin: `${MEGA_SPACING_TOKENS[4]} 0 0` }}>
                {latestTask
                  ? checksText.controls.taskMeta
                      .replace("{taskId}", latestTask.task_id)
                      .replace("{attemptId}", latestTask.attempt_id)
                      .replace("{status}", latestTask.status)
                  : checksText.controls.noTaskYet}
              </p>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: MEGA_SPACING_TOKENS[8] }}>
              <button
                data-mega-cls="trigger-build"
                disabled={anyActionPending}
                onClick={() => triggerMutation.mutate(triggerBindingToken)}
                type="button"
              >
                {triggerMutation.isPending ? checksText.controls.submitting : checksText.controls.triggerBuild}
              </button>
              {latestTask ? (
                <button
                  data-mega-cls="retry-build"
                  disabled={anyActionPending || isTaskActive(latestTask)}
                  onClick={() => retryMutation.mutate(latestTask.task_id)}
                  type="button"
                >
                  {retryMutation.isPending ? checksText.controls.submitting : checksText.controls.retryBuild}
                </button>
              ) : null}
              {latestTask && isTaskActive(latestTask) ? (
                <button
                  data-mega-cls="cancel-build"
                  disabled={anyActionPending}
                  onClick={() => cancelMutation.mutate(latestTask.task_id)}
                  type="button"
                >
                  {cancelMutation.isPending ? checksText.controls.submitting : checksText.controls.cancelBuild}
                </button>
              ) : null}
            </div>
          </div>
          {actionError ? (
            <p data-mega-cls="orion-action-error" role="alert" style={{ color: MEGA_TOKENS.danger, margin: 0 }}>
              {checksText.controls.actionError.replace("{message}", actionError)}
            </p>
          ) : null}
          {observedAttempts.length > 1 ? (
            <div data-mega-cls="orion-task-history" style={{ display: "flex", flexWrap: "wrap", gap: MEGA_SPACING_TOKENS[6] }}>
              <span style={{ color: MEGA_TOKENS.muted }}>{checksText.controls.attemptHistory}:</span>
              {observedAttempts.map((entry) => (
                <button
                  data-attempt-id={entry.attemptId}
                  data-mega-cls="select-attempt"
                  key={entry.attemptId}
                  onClick={() => setSelectedAttemptId(entry.attemptId)}
                  type="button"
                >
                  {entry.attemptId} ({entry.status})
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {status === "failing" ? (
        <p data-mega-cls="checks-failed" role="status" style={{ color: MEGA_TOKENS.danger, margin: 0 }}>
          {checksText.hero.someFailed}
        </p>
      ) : null}

      <table data-mega-cls="checks-table" style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>{checksText.table.check}</th>
            <th style={{ textAlign: "left" }}>{checksText.table.matrix}</th>
            <th style={{ textAlign: "left" }}>{checksText.table.duration}</th>
            <th style={{ textAlign: "left" }}>{checksText.table.logs}</th>
          </tr>
        </thead>
        <tbody>
          {view.checks.map((check) => (
            <tr data-mega-cls="check-row" data-status={check.status} key={check.id}>
              <td>
                <span aria-label={checksText.table.statusAriaLabel.replace("{status}", check.status)}>
                  {check.name}
                </span>
              </td>
              <td>{check.matrix ?? "—"}</td>
              <td>{formatDuration(check.durationSeconds)}</td>
              <td>
                {check.passedCount != null
                  ? checksText.table.passPill.replace("{count}", String(check.passedCount))
                  : check.logCount != null
                    ? String(check.logCount)
                    : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {hasOrionContext && activeAttemptId ? (
        <BuildLogViewer attemptId={activeAttemptId} labels={checksText.liveLog} />
      ) : null}
    </section>
  );
}
