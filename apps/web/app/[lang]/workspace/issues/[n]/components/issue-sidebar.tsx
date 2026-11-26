import type { Issue } from "@megaui/core";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

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
