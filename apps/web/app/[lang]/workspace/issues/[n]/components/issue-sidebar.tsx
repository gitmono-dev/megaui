import Link from "next/link";
import type { Issue } from "@megaui/core";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

interface IssueSidebarProps {
  readonly issue: Issue;
  readonly linkedClsLabel: string;
  readonly noneLabel: string;
  readonly packageLabel: string;
}

export function IssueSidebar({
  issue,
  linkedClsLabel,
  noneLabel,
  packageLabel,
}: IssueSidebarProps) {
  const { t, locale } = useTranslation();
  const labels = t.workspace.issues.properties;
  const properties = [
    [t.workspace.issues.create.status, issue.workflowStatus && t.workspace.issues.create.statuses[issue.workflowStatus]],
    [labels.assignees, issue.assignees.map(user => user.displayName).join(", ")],
    [labels.labels, issue.labels.map(label => label.name).join(", ")],
    [labels.type, issue.issueType && labels.types[issue.issueType]],
    [labels.priority, issue.priority],
    [labels.projects, issue.projects?.join(", ")],
    [labels.milestone, issue.milestone?.title],
  ];
  return (
    <aside
      data-mega-issues="sidebar"
      style={{
        marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
        padding: MEGA_SPACING_TOKENS[8],
      }}
    >
      <dl style={{ margin: 0, overflowWrap: "anywhere" }}>
        {properties.map(([name, value]) => (
          <div key={name} style={{ borderBottom: `1px solid ${MEGA_TOKENS.border}`, padding: "12px 0" }}><dt style={{ color: MEGA_TOKENS.muted, fontWeight: 600 }}>{name}</dt><dd style={{ margin: "8px 0 0" }}>{value || noneLabel}</dd></div>
        ))}
      </dl>
      {issue.packageId && <p style={{ margin: 0 }}>
        <strong>{packageLabel}</strong>: {issue.packageId}
      </p>}
      <p style={{ margin: `${MEGA_SPACING_TOKENS[6]} 0 0` }}>
        <strong>{linkedClsLabel}</strong>:{" "}
        {issue.linkedClPublicIds?.length
          ? issue.linkedClPublicIds.map((id, index) => <span key={id}>{index > 0 && ", "}<Link style={{ color: "var(--mega-doc-link)" }} href={`/${locale}/workspace/cls/${id}`}>{id}</Link></span>)
          : noneLabel}
      </p>
      <p data-mega-issues="watchers" style={{ margin: `${MEGA_SPACING_TOKENS[6]} 0 0` }}>
        watchers: {issue.watcherIds.length}
      </p>
    </aside>
  );
}
