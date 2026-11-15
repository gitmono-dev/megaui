import type { Issue } from "@megaui/core";
import { IssueCard } from "@megaui/ui/composites";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

interface IssueListResultsProps {
  readonly onNextPage: () => void;
  readonly onPreviousPage: () => void;
  readonly page: number;
  readonly pageSize: number;
  readonly rows: readonly Issue[];
  readonly total: number;
  readonly totalPages: number;
  readonly workspaceBase: string;
}

export function IssueListResults({
  onNextPage,
  onPreviousPage,
  page,
  pageSize,
  rows,
  total,
  totalPages,
  workspaceBase,
}: IssueListResultsProps) {
  const { t } = useTranslation();
  const issuesText = t.workspace.issues;

  return (
    <>
      {rows.length === 0 ? (
        <p
          data-mega-issues="empty"
          style={{ color: MEGA_TOKENS.muted, marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}
        >
          {issuesText.empty}
        </p>
      ) : (
        <ul
          data-mega-issues="list"
          style={{
            display: "grid",
            gap: MEGA_SPACING_TOKENS[8],
            listStyle: "none",
            margin: `calc(${MEGA_SPACING_TOKENS[8]} * 2) 0 0`,
            padding: 0,
          }}
        >
          {rows.map((issue) => (
            <li data-mega-issues="row" key={issue.id}>
              <IssueCard
                commentCountLabel={`${issue.commentCount}`}
                href={`${workspaceBase}/issues/${issue.number}`}
                issue={issue}
                priorityLabel={issue.priority}
                stateLabel={issue.state === "open" ? issuesText.openTab : issuesText.closedTab}
              />
            </li>
          ))}
        </ul>
      )}
      {total > pageSize ? (
        <div
          data-mega-issues="pagination"
          style={{
            alignItems: "center",
            display: "flex",
            gap: MEGA_SPACING_TOKENS[8],
            marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
          }}
        >
          <button
            data-mega-issues="page-prev"
            disabled={page <= 1}
            onClick={onPreviousPage}
            type="button"
          >
            {t.workspace.clsList.pagination.previous}
          </button>
          <span data-mega-issues="page-status">
            {t.workspace.clsList.pagination.pageStatus
              .replace("{page}", String(page))
              .replace("{total}", String(totalPages))}
          </span>
          <button
            data-mega-issues="page-next"
            disabled={page >= totalPages}
            onClick={onNextPage}
            type="button"
          >
            {t.workspace.clsList.pagination.next}
          </button>
        </div>
      ) : null}
    </>
  );
}
