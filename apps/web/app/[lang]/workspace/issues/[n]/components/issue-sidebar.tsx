import type { Issue } from "@megaui/core";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

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
  const { t } = useTranslation();
  const labels = t.workspace.issues.properties;
  const properties = [
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
        border: `1px solid ${MEGA_TOKENS.border}`,
        borderRadius: MEGA_RADIUS_TOKENS.md,
        marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
        padding: MEGA_SPACING_TOKENS[8],
      }}
    >
      <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: "4px 12px", overflowWrap: "anywhere" }}>
        {properties.filter(([, value]) => value).map(([name, value]) => (
          <div key={name} style={{ display: "contents" }}><dt>{name}</dt><dd style={{ margin: 0 }}>{value}</dd></div>
        ))}
      </dl>
      {issue.packageId && <p style={{ margin: 0 }}>
        <strong>{packageLabel}</strong>: {issue.packageId}
      </p>}
      <p style={{ margin: `${MEGA_SPACING_TOKENS[6]} 0 0` }}>
        <strong>{linkedClsLabel}</strong>:{" "}
        {issue.linkedClPublicIds?.length
          ? issue.linkedClPublicIds.join(", ")
          : noneLabel}
      </p>
      <p data-mega-issues="watchers" style={{ margin: `${MEGA_SPACING_TOKENS[6]} 0 0` }}>
        watchers: {issue.watcherIds.length}
      </p>
    </aside>
  );
}
