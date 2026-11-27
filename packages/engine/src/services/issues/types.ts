// megaui:libs/mega/services/types.ts@0ff3a9d (issue-shaped input/output slice)
//
// Diff vs upstream (GC-03, registered on the EG-04 task card):
// - `ListIssuesInput`/`ListIssuesResult` are megaui-only: upstream
//   `listIssues(filter?)` had no pagination — the card AC requires it, so
//   the engine layer adds offset/limit via the shared `parsePagination`
//   parser and returns `{ items, total, offset, limit }` instead of a bare
//   array.
// - `IssueTransitionAction` is megaui-only: upstream's `closeIssue` is a
//   single idempotent one-way action (no reopen). This card's AC requires
//   a full state-transition legality matrix, so both `close` and `reopen`
//   are modeled explicitly (see `issues.ts` diff header for the matrix).
import type { Filter, Issue, IssuePropertiesInput } from "@megaui/core";
import type { PaginationInput } from "../../context";

export interface CreateIssueInput extends IssuePropertiesInput {
  title: string;
  packageId?: string;
  /** Plain-text body (no Lexical/plain-text import pipeline ported yet — see issues.ts diff header). */
  body?: string;
}

export interface ListIssuesInput {
  filter?: Filter;
  pagination?: PaginationInput;
}

export interface ListIssuesResult {
  items: Issue[];
  total: number;
  offset: number;
  limit: number;
}

export type IssueTransitionAction = "close" | "reopen";
