// megaui:apps/next-app/app/[lang]/workspace/cls/[n]/components/merge-box.tsx@0ff3a9d
// CLB-34: enforces CI gate messaging and checks link when CI is not passing.
"use client";

import Link from "next/link";
import {
  ChevronRight, CircleCheck, CircleDashed, CircleMinus, CircleX, GitMerge,
  GitPullRequestDraft, ListChecks, TriangleAlert,
} from "lucide-react";
import type { CIStatus, CL } from "@megaui/core";
import type { ProjectedMega2CL } from "@/lib/adapter/mega2/cl-projection";
import styles from "./merge-box.module.css";

type MergeBoxCL = CL & Pick<ProjectedMega2CL, "mergeBox">;
type Condition = NonNullable<NonNullable<ProjectedMega2CL["mergeBox"]>["merge_requirements"]>["conditions"][number];

export interface MergeBoxLabels {
  closed: string;
  draft: string;
  requirementsTitle: string;
  requirementsStatus: string;
  requirementsPending: string;
  conditionNames: Record<Condition["type"], string>;
  conditionResults: Record<Condition["result"], string>;
  inQueueSubtitle: string;
  inQueueTitle: string;
  mergeAction: string;
  merged: string;
  needsReviewSubtitle: string;
  needsReviewTitle: string;
  readySubtitle: string;
  readyTitle: string;
  rebaseAction: string;
  rebaseSubtitle: string;
  rebaseTitle: string;
  squashNote: string;
  ciFailingTitle: string;
  ciFailingSubtitle: string;
  ciRunningTitle: string;
  ciRunningSubtitle: string;
  ciQueuedTitle: string;
  ciQueuedSubtitle: string;
  ciSkippedTitle: string;
  ciSkippedSubtitle: string;
  viewChecks: string;
}

export type MergeVisual = {
  action?: "merge" | "rebase";
  ciBlocked?: boolean;
  note?: string;
  showChecksLink?: boolean;
  subtitle: string;
  title: string;
  tone: "accent" | "muted" | "danger" | "merged";
};

function ciBlockerInfo(
  ci: CIStatus,
  labels: MergeBoxLabels,
): { readonly title: string; readonly subtitle: string; readonly tone: "danger" | "muted" } {
  switch (ci) {
    case "failing":
      return {
        title: labels.ciFailingTitle,
        subtitle: labels.ciFailingSubtitle,
        tone: "danger",
      };
    case "running":
      return {
        title: labels.ciRunningTitle,
        subtitle: labels.ciRunningSubtitle,
        tone: "muted",
      };
    case "queued":
      return {
        title: labels.ciQueuedTitle,
        subtitle: labels.ciQueuedSubtitle,
        tone: "muted",
      };
    case "skipped":
    default:
      return {
        title: labels.ciSkippedTitle,
        subtitle: labels.ciSkippedSubtitle,
        tone: "muted",
      };
  }
}

export function mergeVisual(cl: MergeBoxCL, labels: MergeBoxLabels): MergeVisual {
  if (cl.state === "merged") return { subtitle: "", title: labels.merged, tone: "merged" };
  if (cl.state === "closed") return { subtitle: "", title: labels.closed, tone: "muted" };
  if (cl.state === "wip") return { subtitle: "", title: labels.draft, tone: "muted" };

  const liveRequirements = cl.mergeBox !== undefined;
  const approvals = cl.reviewers.filter((reviewer) => reviewer.verdict === "approved").length;
  switch (cl.merge) {
    case "queue-ready":
      if (cl.ci !== "passing") {
        const blocker = ciBlockerInfo(cl.ci, labels);
        return {
          ciBlocked: true,
          showChecksLink: true,
          subtitle: blocker.subtitle,
          title: blocker.title,
          tone: blocker.tone,
        };
      }
      return {
        action: "merge",
        note: liveRequirements ? undefined : labels.squashNote,
        subtitle: liveRequirements ? "" : labels.readySubtitle
          .replace("{approvals}", String(approvals))
          .replace("{score}", String(cl.mergeScore ?? "—")),
        title: labels.readyTitle,
        tone: "accent",
      };
    case "in-queue":
      if (cl.ci !== "passing") {
        const blocker = ciBlockerInfo(cl.ci, labels);
        return {
          ciBlocked: true,
          showChecksLink: true,
          subtitle: blocker.subtitle,
          title: blocker.title,
          tone: blocker.tone,
        };
      }
      return {
        action: "merge",
        note: labels.squashNote,
        subtitle: labels.inQueueSubtitle.replace("{position}", String(cl.queuePosition ?? "—")),
        title: labels.inQueueTitle,
        tone: "accent",
      };
    case "rebase-needed": {
      const ciPendingOrFailed = cl.ci !== "passing";
      const blocker = ciPendingOrFailed ? ciBlockerInfo(cl.ci, labels) : undefined;
      return {
        action: "rebase",
        ...(blocker
          ? {
              ciBlocked: true,
              note: `${blocker.title}: ${blocker.subtitle}`,
              showChecksLink: true,
            }
          : {}),
        subtitle: labels.rebaseSubtitle,
        title: labels.rebaseTitle,
        tone: "danger",
      };
    }
    default: {
      const ciPendingOrFailed = cl.ci !== "passing";
      const blocker = ciPendingOrFailed ? ciBlockerInfo(cl.ci, labels) : undefined;
      return {
        ...(blocker
          ? {
              ciBlocked: true,
              note: `${blocker.title}: ${blocker.subtitle}`,
              showChecksLink: true,
            }
          : {}),
        subtitle: liveRequirements || !cl.reviewers.length ? "" : labels.needsReviewSubtitle
          .replace("{approvals}", String(approvals))
          .replace("{total}", String(cl.reviewers.length)),
        title: liveRequirements ? labels.requirementsPending : labels.needsReviewTitle,
        tone: "muted",
      };
    }
  }
}

const toneIcons = {
  accent: CircleCheck,
  danger: TriangleAlert,
  merged: GitMerge,
  muted: CircleDashed,
} as const;

const conditionIcons = {
  PASSED: CircleCheck,
  FAILED: CircleX,
  PENDING: CircleDashed,
} as const;

export function MergeBox({
  checksHref,
  cl,
  labels,
  onMerge,
  onRebase,
  pending,
  showActions,
}: {
  checksHref?: string;
  cl: MergeBoxCL;
  labels: MergeBoxLabels;
  onMerge?(): void;
  onRebase?(): void;
  pending: boolean;
  /** The BFF rechecks permissions for every decision action. */
  showActions: boolean;
}) {
  const visual = mergeVisual(cl, labels);
  const Icon = cl.state === "closed" ? CircleMinus : cl.state === "wip" ? GitPullRequestDraft : toneIcons[visual.tone];
  const conditions = cl.mergeBox?.merge_requirements?.conditions ?? [];
  const passed = conditions.filter((condition) => condition.result === "PASSED").length;

  return (
    <section
      className={styles.box}
      data-ci={cl.ci}
      data-ci-blocked={visual.ciBlocked ? "true" : "false"}
      data-mega-cls="merge-box"
      data-merge={cl.merge}
      data-tone={visual.tone}
    >
      <div className={styles.summary}>
        <span className={styles.icon}><Icon aria-hidden="true" size={18} /></span>
        <div className={styles.content}>
          <h2>{visual.title}</h2>
          {visual.subtitle && <p>{visual.subtitle}</p>}
          {visual.note && <p>{visual.note}</p>}
        </div>
        <div className={styles.actions}>
          {visual.showChecksLink && checksHref && (
            <Link data-mega-cls="merge-box-checks-link" href={checksHref}>
              {labels.viewChecks}<ChevronRight aria-hidden="true" size={14} />
            </Link>
          )}
          {showActions && visual.action === "merge" && cl.ci === "passing" && onMerge && (
            <button data-mega-cls="merge-action" disabled={pending} onClick={onMerge} type="button">
              {labels.mergeAction}
            </button>
          )}
          {showActions && visual.action === "rebase" && onRebase && (
            <button data-mega-cls="rebase-action" disabled={pending} onClick={onRebase} type="button">
              {labels.rebaseAction}
            </button>
          )}
        </div>
      </div>
      {conditions.length > 0 && (
        <details className={styles.requirements}>
          <summary>
            <ListChecks aria-hidden="true" size={16} />
            <strong>{labels.requirementsTitle}</strong>
            <span>{labels.requirementsStatus.replace("{passed}", String(passed)).replace("{total}", String(conditions.length))}</span>
            <ChevronRight className={styles.chevron} aria-hidden="true" size={14} />
          </summary>
          <ul>
            {conditions.map((condition) => {
              const ResultIcon = conditionIcons[condition.result];
              return (
                <li key={condition.type}>
                  <ResultIcon aria-hidden="true" data-result={condition.result} size={15} />
                  <span>{labels.conditionNames[condition.type]}</span>
                  <span className={styles.result}>{labels.conditionResults[condition.result]}</span>
                  {condition.result !== "PASSED" && condition.message && <p>{condition.message}</p>}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}
