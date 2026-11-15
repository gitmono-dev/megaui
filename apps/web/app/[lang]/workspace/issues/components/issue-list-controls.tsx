import { parseQuery } from "@megaui/core";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

const ISSUE_SORTS = ["updated-desc", "created-desc", "created-asc", "priority-desc"] as const;

export type IssueSort = (typeof ISSUE_SORTS)[number];

interface IssueListControlsProps {
  readonly onNewIssue: () => void;
  readonly onQueryChange: (value: string) => void;
  readonly onSortChange: (sort: IssueSort) => void;
  readonly onStateChange: (state: "open" | "closed") => void;
  readonly query: string;
  readonly sort: NonNullable<ReturnType<typeof parseQuery>["sort"]> | undefined;
  readonly state: "open" | "closed";
  readonly total: number;
}

function isIssueSort(value: string): value is IssueSort {
  return ISSUE_SORTS.some((sort) => sort === value);
}

export function IssueListControls({
  onNewIssue,
  onQueryChange,
  onSortChange,
  onStateChange,
  query,
  sort,
  state,
  total,
}: IssueListControlsProps) {
  const { t } = useTranslation();
  const issuesText = t.workspace.issues;

  return (
    <>
      <div style={{ alignItems: "center", display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
        <h1 data-mega-issues="title" style={{ fontSize: "1.35rem", fontWeight: 700, margin: 0 }}>
          {issuesText.title}
        </h1>
        <span
          style={{
            color: MEGA_TOKENS.muted,
            fontSize: "calc(var(--mega-density-font-size) - 1px)",
          }}
        >
          {issuesText.scopeAllPackages}
        </span>
        <span style={{ flex: 1 }} />
        <button data-mega-issues="new" onClick={onNewIssue} type="button">
          {issuesText.newIssue}
        </button>
      </div>

      <label style={{ display: "block", marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
        <VisuallyHiddenLabel>{issuesText.filterAriaLabel}</VisuallyHiddenLabel>
        <input
          data-mega-issues="filter"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={issuesText.filterPlaceholder}
          style={{
            border: `1px solid ${MEGA_TOKENS.border}`,
            borderRadius: MEGA_RADIUS_TOKENS.md,
            padding: MEGA_SPACING_TOKENS[8],
            width: "100%",
          }}
          value={query}
        />
      </label>

      <div
        data-mega-issues="tabs"
        style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8], marginTop: MEGA_SPACING_TOKENS[8] }}
      >
        <button
          data-mega-issues={state === "open" ? "tab-active" : "tab"}
          data-tab="open"
          onClick={() => onStateChange("open")}
          type="button"
        >
          {issuesText.openTab}
        </button>
        <button
          data-mega-issues={state === "closed" ? "tab-active" : "tab"}
          data-tab="closed"
          onClick={() => onStateChange("closed")}
          type="button"
        >
          {issuesText.closedTab}
        </button>
        <label style={{ marginLeft: "auto" }}>
          <VisuallyHiddenLabel>{issuesText.dropdowns.sort}</VisuallyHiddenLabel>
          <select
            data-mega-issues="sort"
            onChange={(event) => {
              if (isIssueSort(event.target.value)) onSortChange(event.target.value);
            }}
            value={sort ?? "updated-desc"}
          >
            {ISSUE_SORTS.map((key) => (
              <option key={key} value={key}>
                {issuesText.dropdowns.sorts[key]}
              </option>
            ))}
          </select>
        </label>
        <span style={{ color: MEGA_TOKENS.muted }}>{total}</span>
      </div>
    </>
  );
}

function VisuallyHiddenLabel({ children }: { readonly children: string }) {
  return (
    <span
      style={{
        clip: "rect(0 0 0 0)",
        clipPath: "inset(50%)",
        height: 1,
        overflow: "hidden",
        position: "absolute",
        width: 1,
      }}
    >
      {children}
    </span>
  );
}
