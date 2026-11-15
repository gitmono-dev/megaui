// megaui:libs/database/schema/pg/mega-docs.ts@0ff3a9d
//
// Ported for PK-05 (REF-07). SaaS tables intentionally omitted at package scope.
import { InferInsertModel, InferSelectModel, sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  megaDocCollaboratorRoles,
  megaDocStatus,
} from "./constants";
import { user } from "../auth/user";
import { createdAtColumn, updatedAtColumn } from "../timestamps";

export { megaDocCollaboratorRoles, megaDocStatus };
export type {
  MegaDocCollaboratorRole,
  MegaDocStatus,
} from "./constants";

/**
 * Docs domain metadata (CE-11). Body lives in mega_content (container_type=doc).
 * Title uniqueness excludes soft-deleted rows (partial unique index).
 */
export const megaDocs = pgTable(
  "mega_docs",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    folderId: text("folder_id"),
    excerpt: text("excerpt"),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").notNull().default(megaDocStatus.DRAFT),
    viewCount: integer("view_count").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // Soft-delete aware: only live docs compete on title (ADR-CE-05).
    uniqueIndex("mega_docs_title_live_uidx")
      .on(table.title)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const megaDocVersions = pgTable(
  "mega_doc_versions",
  {
    id: text("id").primaryKey(),
    docId: text("doc_id")
      .notNull()
      .references(() => megaDocs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    summary: text("summary"),
    /** Opaque snapshot ref (ydoc / body pointer); format owned by CE-92. */
    snapshotRef: text("snapshot_ref"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("mega_doc_versions_doc_version_uidx").on(table.docId, table.version),
  ],
);

export const megaDocStars = pgTable(
  "mega_doc_stars",
  {
    id: text("id").primaryKey(),
    docId: text("doc_id")
      .notNull()
      .references(() => megaDocs.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("mega_doc_stars_user_doc_uidx").on(table.userId, table.docId),
  ],
);

export const megaDocCollaborators = pgTable(
  "mega_doc_collaborators",
  {
    id: text("id").primaryKey(),
    docId: text("doc_id")
      .notNull()
      .references(() => megaDocs.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default(megaDocCollaboratorRoles.EDITOR),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("mega_doc_collaborators_doc_user_uidx").on(table.docId, table.userId),
  ],
);

/**
 * Doc comments (CE-71 / ADR-CE-08). Body lives in mega_content
 * (container_type=doc_comment); commentCount on Doc is derived via COUNT.
 */
export const megaDocComments = pgTable("mega_doc_comments", {
  id: text("id").primaryKey(),
  docId: text("doc_id")
    .notNull()
    .references(() => megaDocs.id, { onDelete: "cascade" }),
  authorId: text("author_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  reactions: jsonb("reactions")
    .$type<Array<Record<string, unknown>>>()
    .notNull()
    .default([]),
  createdAt: createdAtColumn(),
});

export type MegaDoc = InferSelectModel<typeof megaDocs>;
export type NewMegaDoc = InferInsertModel<typeof megaDocs>;
export type MegaDocVersion = InferSelectModel<typeof megaDocVersions>;
export type NewMegaDocVersion = InferInsertModel<typeof megaDocVersions>;
export type MegaDocStar = InferSelectModel<typeof megaDocStars>;
export type NewMegaDocStar = InferInsertModel<typeof megaDocStars>;
export type MegaDocCollaborator = InferSelectModel<typeof megaDocCollaborators>;
export type NewMegaDocCollaborator = InferInsertModel<typeof megaDocCollaborators>;
export type MegaDocComment = InferSelectModel<typeof megaDocComments>;
export type NewMegaDocComment = InferInsertModel<typeof megaDocComments>;
