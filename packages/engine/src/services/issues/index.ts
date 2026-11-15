import type { Database } from "@megaui/database";
import { createIssuesService, type IssuesService } from "./issues";

export { createIssuesService, type IssuesService } from "./issues";
export type {
  CreateIssueInput,
  IssueTransitionAction,
  ListIssuesInput,
  ListIssuesResult,
} from "./types";

export interface IssuesDomain {
  issues: IssuesService;
}

/** Wires the issues-domain service against one `Database` (EG-04). */
export function createIssuesDomain(database: Database): IssuesDomain {
  const issues = createIssuesService(database);
  return { issues };
}
