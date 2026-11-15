// megaui:libs/database/schema/pg/mega-cls.ts@0ff3a9d
//
// Ported for PK-05 (REF-07). SaaS tables intentionally omitted at package scope.
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  megaClCiStatuses,
  megaClMergeStates,
  megaClStates,
} from "./constants";
import { user } from "../auth/user";

export { megaClCiStatuses, megaClMergeStates, megaClStates };
export type {
  MegaClCiStatus,
  MegaClMergeState,
  MegaClState,
} from "./constants";

/**
 * CL domain metadata (CE-15).
 * Description / comment bodies live in mega_content (cl / cl_comment /
 * inline_comment).
 *
 * files + revisions are JSON columns holding fixture-grade structured data
 * (patch text + commit list). They are rebuildable caches, not a source of
 * truth for mega2 blobs (see Migration and rollback on CE-15).
 * Inline replies stay as JSON on mega_inline_comments (no reply subtable in v1).
 */
export const megaCls = pgTable(
  "mega_cls",
  {
    id: text("id").primaryKey(),
    number: integer("number").notNull(),
    /** mega2 CL link for n→link commits resolution (nullable until seed). */
    link: text("link"),
    title: text("title").notNull(),
    state: text("state").notNull().default(megaClStates.WIP),
    packageId: text("package_id").notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    reviewers: jsonb("reviewers")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    additions: integer("additions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    files: jsonb("files")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    revisions: jsonb("revisions")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    ci: text("ci").notNull().default(megaClCiStatuses.QUEUED),
    merge: text("merge").notNull().default(megaClMergeStates.NEEDS_REVIEW),
    mergeScore: integer("merge_score"),
    queuePosition: integer("queue_position"),
    atomic: boolean("atomic").notNull().default(false),
    crossPackage: jsonb("cross_package").$type<string[]>().notNull().default([]),
    linkedIssues: jsonb("linked_issues").$type<number[]>().notNull().default([]),
    branch: text("branch"),
    subscribed: boolean("subscribed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("mega_cls_number_uidx").on(table.number)],
);

export const megaClComments = pgTable("mega_cl_comments", {
  id: text("id").primaryKey(),
  clNumber: integer("cl_number").notNull(),
  authorId: text("author_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  reactions: jsonb("reactions")
    .$type<Array<Record<string, unknown>>>()
    .notNull()
    .default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const megaInlineComments = pgTable("mega_inline_comments", {
  id: text("id").primaryKey(),
  clNumber: integer("cl_number").notNull(),
  filePath: text("file_path").notNull(),
  side: text("side").notNull().default("additions"),
  line: integer("line").notNull(),
  authorId: text("author_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Nested replies JSON (id/authorId/body/createdAt/revision); body text inline. */
  replies: jsonb("replies")
    .$type<Array<Record<string, unknown>>>()
    .notNull()
    .default([]),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type MegaCl = InferSelectModel<typeof megaCls>;
export type NewMegaCl = InferInsertModel<typeof megaCls>;
export type MegaClComment = InferSelectModel<typeof megaClComments>;
export type NewMegaClComment = InferInsertModel<typeof megaClComments>;
export type MegaInlineComment = InferSelectModel<typeof megaInlineComments>;
export type NewMegaInlineComment = InferInsertModel<typeof megaInlineComments>;
