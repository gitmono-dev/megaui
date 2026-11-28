import Link from "next/link";

import type { Issue } from "@megaui/core";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

interface IssueDetailHeaderProps {
  readonly backToListLabel: string;
  readonly canAct: boolean;
  readonly closedLabel: string;
  readonly issue: Issue;
  readonly metaTemplate: string;
  readonly openLabel: string;
  readonly watching: boolean;
  readonly watchingLabel: string;
  readonly watchLabel: string;
  readonly watchPending: boolean;
  readonly workspaceBase: string;
  readonly onWatch: () => void;
}

export function IssueDetailHeader({
  backToListLabel,
  canAct,
  closedLabel,
  issue,
  metaTemplate,
  openLabel,
  watching,
  watchingLabel,
  watchLabel,
  watchPending,
  workspaceBase,
  onWatch,
}: IssueDetailHeaderProps) {
  return (
    <header
      data-mega-issues="chrome"
      style={{
        borderBottom: `1px solid ${MEGA_TOKENS.border}`,
        paddingBottom: MEGA_SPACING_TOKENS[8],
      }}
    >
      <p style={{ color: MEGA_TOKENS.muted, margin: 0 }}>
        <Link
          href={`${workspaceBase}/issues`}
          style={{ color: MEGA_TOKENS.muted, textDecoration: "none" }}
        >
          {backToListLabel}
        </Link>
      </p>
      <div
        style={{
          alignItems: "center",
          display: "flex",
          flexWrap: "wrap",
          gap: MEGA_SPACING_TOKENS[8],
          marginTop: MEGA_SPACING_TOKENS[6],
        }}
      >
        <h1
          data-mega-issues="detail-title"
          style={{ fontSize: "1.75rem", fontWeight: 700, margin: 0 }}
        >
          {issue.title} <span style={{ color: MEGA_TOKENS.muted, fontWeight: 400 }}>{issue.publicId ?? `#${issue.number}`}</span>
        </h1>
        <span data-mega-issues="state-pill" data-state={issue.state}>
          {issue.state === "open" ? openLabel : closedLabel}
        </span>
        {canAct ? (
          <button
            data-mega-issues="watch"
            data-watching={watching ? "true" : "false"}
            disabled={watchPending}
            onClick={onWatch}
            type="button"
          >
            {watching ? watchingLabel : watchLabel}
          </button>
        ) : null}
      </div>
      <p style={{ color: MEGA_TOKENS.muted, margin: `${MEGA_SPACING_TOKENS[6]} 0 0` }}>
        {metaTemplate
          .replace("{author}", issue.author.displayName)
          .replace("{time}", issue.createdAt)
          .replace("{comments}", String(issue.commentCount))}
        {issue.packageId && ` · ${issue.packageId}`}
      </p>
    </header>
  );
}
