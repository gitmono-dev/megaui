import Link from "next/link";

import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

interface CodePathHeaderProps {
  readonly breadcrumbAriaLabel: string;
  readonly codeLabel: string;
  readonly isDirectory: boolean;
  readonly pathSegments: readonly string[];
  readonly previewAvailable: boolean;
  readonly previewLabel: string;
  readonly tabsAriaLabel: string;
  readonly workspaceBase: string;
  readonly workspaceName: string;
  readonly onTabChange: (tab: "code" | "preview") => void;
}

const headerStyle = {
  borderBottom: `1px solid ${MEGA_TOKENS.border}`,
  padding: `calc(${MEGA_SPACING_TOKENS[8]} * 1.5) calc(${MEGA_SPACING_TOKENS[8]} * 3.5)`,
};

export function CodePathHeader({
  breadcrumbAriaLabel,
  codeLabel,
  isDirectory,
  pathSegments,
  previewAvailable,
  previewLabel,
  tabsAriaLabel,
  workspaceBase,
  workspaceName,
  onTabChange,
}: CodePathHeaderProps) {
  return (
    <header style={headerStyle}>
      <nav aria-label={breadcrumbAriaLabel} data-mega-code="breadcrumb">
        <Link
          href={`${workspaceBase}/code`}
          style={{ color: MEGA_TOKENS.muted, textDecoration: "none" }}
        >
          {workspaceName}
        </Link>
        {pathSegments.map((segment, index) => {
          const hrefPath = pathSegments
            .slice(0, index + 1)
            .map(encodeURIComponent)
            .join("/");
          return (
            <span key={hrefPath}>
              <span style={{ color: MEGA_TOKENS.muted }}> / </span>
              <Link
                href={`${workspaceBase}/code/${hrefPath}`}
                style={{ color: MEGA_TOKENS.text, textDecoration: "none" }}
              >
                {segment}
              </Link>
            </span>
          );
        })}
      </nav>
      {!isDirectory && previewAvailable ? (
        <div
          aria-label={tabsAriaLabel}
          role="tablist"
          style={{
            display: "flex",
            gap: MEGA_SPACING_TOKENS[8],
            marginTop: MEGA_SPACING_TOKENS[8],
          }}
        >
          <button data-mega-code="tab-preview" onClick={() => onTabChange("preview")} type="button">
            {previewLabel}
          </button>
          <button data-mega-code="tab-code" onClick={() => onTabChange("code")} type="button">
            {codeLabel}
          </button>
        </div>
      ) : null}
    </header>
  );
}
