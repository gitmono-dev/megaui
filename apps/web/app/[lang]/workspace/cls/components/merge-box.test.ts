import type { CIStatus, CL, CLMergeState } from "@megaui/core";
import { en, zhCN } from "@megaui/i18n";
import { describe, expect, it } from "vitest";

import { mergeVisual, type MergeBoxLabels } from "./merge-box";

const ALL_CI_STATUSES: readonly CIStatus[] = [
  "passing",
  "failing",
  "running",
  "queued",
  "skipped",
];

const ALL_MERGE_STATES: readonly CLMergeState[] = [
  "queue-ready",
  "in-queue",
  "rebase-needed",
  "needs-review",
  "merged",
];

function makeCl(overrides: Partial<CL> = {}): CL {
  return {
    id: "cl_1",
    publicId: "mergeBoxDemo",
    number: 1,
    title: "Test CL",
    state: "ready",
    author: {
      id: "user_1",
      username: "dev",
      displayName: "Dev",
      avatarInitials: "DV",
      avatarColor: "#000000",
    },
    reviewers: [
      {
        user: {
          id: "user_2",
          username: "rev",
          displayName: "Rev",
          avatarInitials: "RV",
          avatarColor: "#111111",
        },
        verdict: "approved",
      },
    ],
    packageId: "core",
    branch: "feat/clb34",
    files: [],
    revisions: [],
    additions: 10,
    deletions: 3,
    ci: "passing",
    merge: "queue-ready",
    mergeScore: 100,
    atomic: false,
    crossPackage: [],
    linkedIssues: [],
    createdAt: "2026-11-24T10:00:00Z",
    updatedAt: "2026-11-24T10:00:00Z",
    ...overrides,
  };
}

function expectedBlocker(ci: Exclude<CIStatus, "passing">, labels: MergeBoxLabels) {
  switch (ci) {
    case "failing":
      return { title: labels.ciFailingTitle, subtitle: labels.ciFailingSubtitle, tone: "danger" as const };
    case "running":
      return { title: labels.ciRunningTitle, subtitle: labels.ciRunningSubtitle, tone: "muted" as const };
    case "queued":
      return { title: labels.ciQueuedTitle, subtitle: labels.ciQueuedSubtitle, tone: "muted" as const };
    case "skipped":
      return { title: labels.ciSkippedTitle, subtitle: labels.ciSkippedSubtitle, tone: "muted" as const };
  }
}

describe("mergeVisual exhaustive CI x merge-state matrix (CLB-34)", () => {
  const labels = en.workspace.clDetail.conversation.mergeBox;

  it("covers all 25 open CL combinations (5 CI statuses x 5 merge states)", () => {
    for (const merge of ALL_MERGE_STATES) {
      for (const ci of ALL_CI_STATUSES) {
        const cl = makeCl({
          state: merge === "in-queue" ? "queued" : merge === "rebase-needed" ? "conflicts" : "ready",
          merge,
          ci,
          queuePosition: merge === "in-queue" ? 2 : undefined,
        });
        const visual = mergeVisual(cl, labels);
        const tag = `merge=${merge} ci=${ci}`;

        if (merge === "queue-ready") {
          if (ci === "passing") {
            expect(visual, tag).toEqual({
              action: "merge",
              note: labels.squashNote,
              subtitle: "1 approvals · merge score 100 · no conflicts with main",
              title: labels.readyTitle,
              tone: "accent",
            });
          } else {
            const blocker = expectedBlocker(ci, labels);
            expect(visual, tag).toEqual({
              ciBlocked: true,
              showChecksLink: true,
              subtitle: blocker.subtitle,
              title: blocker.title,
              tone: blocker.tone,
            });
          }
        } else if (merge === "in-queue") {
          if (ci === "passing") {
            expect(visual, tag).toEqual({
              action: "merge",
              note: labels.squashNote,
              subtitle: "Position 2",
              title: labels.inQueueTitle,
              tone: "accent",
            });
          } else {
            const blocker = expectedBlocker(ci, labels);
            expect(visual, tag).toEqual({
              ciBlocked: true,
              showChecksLink: true,
              subtitle: blocker.subtitle,
              title: blocker.title,
              tone: blocker.tone,
            });
          }
        } else if (merge === "rebase-needed") {
          if (ci === "passing") {
            expect(visual, tag).toEqual({
              action: "rebase",
              subtitle: labels.rebaseSubtitle,
              title: labels.rebaseTitle,
              tone: "danger",
            });
          } else {
            const blocker = expectedBlocker(ci, labels);
            expect(visual, tag).toEqual({
              action: "rebase",
              ciBlocked: true,
              note: `${blocker.title}: ${blocker.subtitle}`,
              showChecksLink: true,
              subtitle: labels.rebaseSubtitle,
              title: labels.rebaseTitle,
              tone: "danger",
            });
          }
        } else {
          if (ci === "passing") {
            expect(visual, tag).toEqual({
              subtitle: "1/1 approvals",
              title: labels.needsReviewTitle,
              tone: "muted",
            });
          } else {
            const blocker = expectedBlocker(ci, labels);
            expect(visual, tag).toEqual({
              ciBlocked: true,
              note: `${blocker.title}: ${blocker.subtitle}`,
              showChecksLink: true,
              subtitle: "1/1 approvals",
              title: labels.needsReviewTitle,
              tone: "muted",
            });
          }
        }
      }
    }
  });

  it("covers all 25 merged CL combinations (5 CI statuses x 5 merge states) and validates zh-CN parity", () => {
    for (const ci of ALL_CI_STATUSES) {
      for (const merge of ALL_MERGE_STATES) {
        const merged = mergeVisual(makeCl({ state: "merged", merge, ci }), labels);
        expect(merged, `merged merge=${merge} ci=${ci}`).toEqual({
          subtitle: "",
          title: labels.merged,
          tone: "merged",
        });
      }
    }

    const zhLabels = zhCN.workspace.clDetail.conversation.mergeBox;
    for (const ci of ["failing", "running", "queued", "skipped"] as const) {
      const blocked = mergeVisual(makeCl({ merge: "queue-ready", ci }), zhLabels);
      expect(blocked.action).toBeUndefined();
      expect(blocked.ciBlocked).toBe(true);
      expect(blocked.showChecksLink).toBe(true);
      expect(blocked.title.length).toBeGreaterThan(0);
      expect(blocked.subtitle.length).toBeGreaterThan(0);
    }
  });
});
