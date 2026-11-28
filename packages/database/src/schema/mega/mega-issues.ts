// megaui:libs/database/schema/pg/mega-issues.ts@0ff3a9d
//
// Ported for PK-05 (REF-07). SaaS tables intentionally omitted at package scope.
import type { IssueType, IssueWorkflowStatus } from "@megaui/core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { megaIssuePriorities, megaIssueStates } from "./constants";
import { user } from "../auth/user";

export { megaIssuePriorities, megaIssueStates };
export type { MegaIssuePriority, MegaIssueState } from "./constants";

/**
 * Issues domain metadata (CE-13, ADR-CE-10 upstream authority).
 * Body lives in mega_content (container_type=issue / issue_comment).
 *
 * Multi-value fields (labelIds, assigneeIds, watcherIds, linkedCLs, reactions,
 * milestone) are JSON: labels are still fixture catalog entries (no mega_labels
 * table yet), and CE-13 is scoped to two tables only.
 */
export const megaIssues = pgTable(
  "mega_issues",
  {
    id: text("id").primaryKey(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    state: text("state").notNull().default(megaIssueStates.OPEN),
    workflowStatus: text("workflow_status").$type<IssueWorkflowStatus>().notNull().default("backlog"),
    priority: text("priority").notNull().default(megaIssuePriorities.P2),
    packageId: text("package_id").notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    issueType: text("issue_type").$type<IssueType>(),
    projects: jsonb("projects").$type<string[]>().notNull().default([]),
    milestone: jsonb("milestone").$type<Record<string, unknown> | null>(),
    labelIds: jsonb("label_ids").$type<string[]>().notNull().default([]),
    assigneeIds: jsonb("assignee_ids").$type<string[]>().notNull().default([]),
    watcherIds: jsonb("watcher_ids").$type<string[]>().notNull().default([]),
    linkedCLs: jsonb("linked_cls").$type<number[]>().notNull().default([]),
    reactions: jsonb("reactions")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    /** Denormalized comment count; CE-14 keeps this derived from comments. */
    commentCount: integer("comment_count").notNull().default(0),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("mega_issues_number_uidx").on(table.number)],
);

export const megaIssueComments = pgTable("mega_issue_comments", {
  id: text("id").primaryKey(),
  issueNumber: integer("issue_number").notNull(),
  authorId: text("author_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  reactions: jsonb("reactions")
    .$type<Array<Record<string, unknown>>>()
    .notNull()
    .default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type MegaIssue = InferSelectModel<typeof megaIssues>;
export type NewMegaIssue = InferInsertModel<typeof megaIssues>;
export type MegaIssueComment = InferSelectModel<typeof megaIssueComments>;
export type NewMegaIssueComment = InferInsertModel<typeof megaIssueComments>;
