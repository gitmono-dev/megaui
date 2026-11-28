// megaui:apps/next-app/app/[lang]/workspace/components/home-cards/home-card-grid.tsx@0ff3a9d
"use client";

import Link from "next/link";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import type { HomeDashboard } from "@/lib/adapter/home";

import { presentCLAuthor, type CLViewer } from "../cls/[n]/cl-author";

type CardLabels = {
  reviewCls: { title: string; recent: string; action: string; empty: string };
  assignedIssues: { title: string; action: string; empty: string };
  activity: { title: string; action: string; empty: string; updated: string };
  latestRelease: { title: string; action: string; latest: string; empty: string };
  recentDocs: { title: string; action: string; empty: string };
  activeChannels: { title: string; unread: string; empty: string };
};

function Card({
  title,
  actionHref,
  actionLabel,
  empty,
  children,
  testId,
}: {
  title: string;
  actionHref?: string;
  actionLabel?: string;
  empty?: boolean;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <section
      data-mega-home="card"
      data-card={testId}
      style={{
        background: MEGA_TOKENS.bg,
        border: `1px solid ${MEGA_TOKENS.border}`,
        borderRadius: MEGA_RADIUS_TOKENS.md,
        padding: `calc(${MEGA_SPACING_TOKENS[8]} * 1.5)`,
      }}
    >
      <header style={{ alignItems: "baseline", display: "flex", justifyContent: "space-between", marginBottom: MEGA_SPACING_TOKENS[8] }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        {actionHref && actionLabel ? (
          <Link href={actionHref}>
            {actionLabel}
          </Link>
        ) : null}
      </header>
      {empty ? (
        <p data-mega-home="card-empty" style={{ margin: 0 }}>
          {children}
        </p>
      ) : (
        children
      )}
    </section>
  );
}

export function HomeCardGrid({
  cards,
  labels,
  workspaceBase,
  viewer,
}: {
  cards: HomeDashboard["cards"];
  labels: CardLabels;
  workspaceBase: string;
  viewer?: CLViewer | null;
}) {
  const hasReviews = cards.reviewRequests.length > 0;
  const cls = hasReviews ? cards.reviewRequests : cards.recentCls ?? [];
  return (
    <div
      data-mega-home="card-grid"
      style={{
        display: "grid",
        gap: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
        gridTemplateColumns: "repeat(3, 1fr)",
        padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2.25) calc(${MEGA_SPACING_TOKENS[8]} * 3.5) calc(${MEGA_SPACING_TOKENS[8]} * 5)`,
      }}
    >
      <Card
        actionHref={`${workspaceBase}/cls`}
        actionLabel={labels.reviewCls.action}
        empty={cls.length === 0}
        testId="review"
        title={hasReviews ? labels.reviewCls.title : labels.reviewCls.recent}
      >
        {cls.length === 0
          ? labels.reviewCls.empty
          : cls.map((cl) => (
              <Link href={`${workspaceBase}/cls/${cl.publicId}`} key={cl.publicId} style={{ display: "block", marginBottom: MEGA_SPACING_TOKENS[6] }}>
                {cl.title}
              </Link>
            ))}
      </Card>
      <Card
        actionHref={`${workspaceBase}/issues`}
        actionLabel={labels.assignedIssues.action}
        empty={cards.assignedIssues.length === 0}
        testId="issues"
        title={labels.assignedIssues.title}
      >
        {cards.assignedIssues.length === 0
          ? labels.assignedIssues.empty
          : cards.assignedIssues.map((issue) => (
              <Link href={`${workspaceBase}/issues/${issue.publicId ?? issue.number}`} key={issue.number} style={{ display: "block", marginBottom: MEGA_SPACING_TOKENS[6] }}>
                {issue.publicId ?? `#${issue.number}`} {issue.title}
              </Link>
            ))}
      </Card>
      <Card
        actionHref={`${workspaceBase}/inbox`}
        actionLabel={labels.activity.action}
        empty={cards.activity.length === 0}
        testId="activity"
        title={labels.activity.title}
      >
        {cards.activity.length === 0
          ? labels.activity.empty
          : cards.activity.map((row) => {
              const actor = row.author ? presentCLAuthor(row.author, viewer).displayName : row.actorName;
              const [before, after = ""] = labels.activity.updated.split("{ref}");
              return <p key={row.id} style={{ margin: `0 0 ${MEGA_SPACING_TOKENS[6]}` }}>
                {before?.replace("{actor}", actor)}
                <Link href={`${workspaceBase}/cls/${encodeURIComponent(row.entityRef)}`}>{row.title}</Link>
                {after.replace("{actor}", actor)}
              </p>;
            })}
      </Card>
      <Card
        actionHref={`${workspaceBase}/tags`}
        actionLabel={labels.latestRelease.action}
        empty={cards.releases.length === 0}
        testId="releases"
        title={labels.latestRelease.title}
      >
        {cards.releases.length === 0
          ? labels.latestRelease.empty
          : cards.releases.map((release) => (
              <p key={release.id} style={{ margin: `0 0 ${MEGA_SPACING_TOKENS[6]}` }}>
                {release.tag} {release.title}
              </p>
            ))}
      </Card>
      <Card
        actionHref={`${workspaceBase}/docs`}
        actionLabel={labels.recentDocs.action}
        empty={cards.docs.length === 0}
        testId="docs"
        title={labels.recentDocs.title}
      >
        {cards.docs.length === 0
          ? labels.recentDocs.empty
          : cards.docs.map((doc) => (
              <Link href={`${workspaceBase}/docs/${doc.id}`} key={doc.id} style={{ display: "block", marginBottom: MEGA_SPACING_TOKENS[6] }}>
                {doc.title}
              </Link>
            ))}
      </Card>
      <Card
        empty={cards.channels.length === 0}
        testId="channels"
        title={labels.activeChannels.title}
      >
        {cards.channels.length === 0
          ? labels.activeChannels.empty
          : cards.channels.map((channel) => (
              <Link href={`${workspaceBase}/channels/${channel.id}`} key={channel.id} style={{ display: "block", marginBottom: MEGA_SPACING_TOKENS[6] }}>
                #{channel.name}
              </Link>
            ))}
      </Card>
    </div>
  );
}
