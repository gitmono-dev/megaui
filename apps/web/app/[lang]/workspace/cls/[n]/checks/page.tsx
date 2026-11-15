// megaui-only (WA-10): lean checks page — hero summary + table + empty/fail states.
"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import type { CIStatus } from "@megaui/core";
import { MegaApiError, megaGet, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

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
  const params = useParams<{ n: string }>();
  const { t } = useTranslation();
  const checksText = t.workspace.clDetail.checks;
  const clNumber = Number(params?.n);

  const checksQuery = useQuery({
    queryKey: megaQueryKeys.clChecks(clNumber),
    queryFn: () => megaGet<ChecksView>(["cls", String(clNumber), "checks"]),
    enabled: Number.isInteger(clNumber) && clNumber > 0,
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });

  if (checksQuery.isPending) {
    return (
      <section aria-busy="true" data-mega-cls="checks">
        <p>{checksText.loading}</p>
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
    </section>
  );
}
