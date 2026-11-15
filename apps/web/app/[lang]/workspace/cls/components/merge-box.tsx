// megaui:apps/next-app/app/[lang]/workspace/cls/[n]/components/merge-box.tsx@0ff3a9d
"use client";

import type { CL } from "@megaui/core";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

export interface MergeBoxLabels {
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
}

type MergeVisual = {
  action?: "merge" | "rebase";
  note?: string;
  subtitle: string;
  title: string;
  tone: "accent" | "muted" | "danger" | "merged";
};

export function mergeVisual(cl: CL, labels: MergeBoxLabels): MergeVisual {
  if (cl.state === "merged") return { subtitle: "", title: labels.merged, tone: "merged" };
  const approvals = cl.reviewers.filter((reviewer) => reviewer.verdict === "approved").length;
  switch (cl.merge) {
    case "queue-ready":
      return {
        action: "merge",
        note: labels.squashNote,
        subtitle: labels.readySubtitle
          .replace("{approvals}", String(approvals))
          .replace("{score}", String(cl.mergeScore ?? "—")),
        title: labels.readyTitle,
        tone: "accent",
      };
    case "in-queue":
      return {
        action: "merge",
        note: labels.squashNote,
        subtitle: labels.inQueueSubtitle.replace("{position}", String(cl.queuePosition ?? "—")),
        title: labels.inQueueTitle,
        tone: "accent",
      };
    case "rebase-needed":
      return { action: "rebase", subtitle: labels.rebaseSubtitle, title: labels.rebaseTitle, tone: "danger" };
    default:
      return {
        subtitle: labels.needsReviewSubtitle
          .replace("{approvals}", String(approvals))
          .replace("{total}", String(cl.reviewers.length)),
        title: labels.needsReviewTitle,
        tone: "muted",
      };
  }
}

const toneColors = {
  accent: MEGA_TOKENS.accent,
  danger: MEGA_TOKENS.danger,
  merged: MEGA_TOKENS.merged,
  muted: MEGA_TOKENS.muted,
} as const;

export function MergeBox({
  cl,
  labels,
  onMerge,
  onRebase,
  pending,
  showActions,
}: {
  cl: CL;
  labels: MergeBoxLabels;
  onMerge?(): void;
  onRebase?(): void;
  pending: boolean;
  /** Author-only decision actions (engine ACL is fail-closed server-side). */
  showActions: boolean;
}) {
  const visual = mergeVisual(cl, labels);
  return (
    <section
      data-mega-cls="merge-box"
      data-merge={cl.merge}
      style={{
        background: MEGA_TOKENS.subtle,
        border: `1px solid ${MEGA_TOKENS.border}`,
        borderLeft: `3px solid ${toneColors[visual.tone]}`,
        borderRadius: MEGA_RADIUS_TOKENS.md,
        padding: `calc(${MEGA_SPACING_TOKENS[8]} * 1.5)`,
      }}
    >
      <h2 style={{ color: toneColors[visual.tone], fontSize: "var(--mega-density-font-size)", fontWeight: 650, margin: 0 }}>
        {visual.title}
      </h2>
      {visual.subtitle ? (
        <p style={{ color: MEGA_TOKENS.muted, margin: `${MEGA_SPACING_TOKENS[6]} 0 0` }}>{visual.subtitle}</p>
      ) : null}
      {visual.note ? (
        <p style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 1px)", margin: `${MEGA_SPACING_TOKENS[6]} 0 0` }}>
          {visual.note}
        </p>
      ) : null}
      {showActions && visual.action === "merge" && onMerge ? (
        <button data-mega-cls="merge-action" disabled={pending} onClick={onMerge} type="button" style={{ marginTop: MEGA_SPACING_TOKENS[8] }}>
          {labels.mergeAction}
        </button>
      ) : null}
      {showActions && visual.action === "rebase" && onRebase ? (
        <button data-mega-cls="rebase-action" disabled={pending} onClick={onRebase} type="button" style={{ marginTop: MEGA_SPACING_TOKENS[8] }}>
          {labels.rebaseAction}
        </button>
      ) : null}
    </section>
  );
}
