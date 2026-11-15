// megaui:libs/database/schema/pg/mega-content.ts@0ff3a9d
//
// Ported for PK-05 (REF-07). SaaS tables intentionally omitted at package scope.
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  megaContentBlockVariants,
  megaContentContainerTypes,
  megaContentLinkTargetKinds,
} from "./constants";

export {
  megaContentBlockVariants,
  megaContentContainerTypes,
  megaContentLinkTargetKinds,
};
export type {
  MegaContentBlockVariant,
  MegaContentContainerType,
  MegaContentLinkTargetKind,
} from "./constants";

/** Yjs document binary state (Y.encodeStateAsUpdate bytes). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Universal content container (ADR-CE-03).
 * Domain metadata tables hold structured fields; body always lives here.
 */
export const megaContent = pgTable(
  "mega_content",
  {
    containerType: text("container_type").notNull(),
    containerId: text("container_id").notNull(),
    bodyJson: jsonb("body_json").notNull().default({}),
    ydocState: bytea("ydoc_state"),
    bodyFormatVersion: integer("body_format_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "mega_content_pk",
      columns: [table.containerType, table.containerId],
    }),
  ],
);

/**
 * Outgoing wikilinks / entity links rebuilt on save (whole-table delete+insert per source).
 */
export const megaContentLinks = pgTable(
  "mega_content_links",
  {
    id: text("id").primaryKey(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    contextSummary: text("context_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("mega_content_links_source_idx").on(table.sourceType, table.sourceId),
    index("mega_content_links_target_idx").on(table.targetKind, table.targetId),
  ],
);

/**
 * Flattened block index for (( search and deep links; rebuilt per source on save.
 *
 * CE-112 / ADR-CE-15 / ADR-FS-01 (EG-10): Postgres also maintains a GENERATED
 * `text_search` tsvector column + GIN index `mega_content_blocks_fts_idx`
 * (see `drizzle/0002_body_fts.sql`, hand-written — not `drizzle-kit
 * generate`d). That column is not modeled here so inserts never try to
 * write a generated value, and `db:push` is hard-disabled (`package.json`)
 * so it can never be dropped by an unmanaged push either.
 */
export const megaContentBlocks = pgTable(
  "mega_content_blocks",
  {
    id: text("id").primaryKey(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    blockId: text("block_id").notNull(),
    parentBlockId: text("parent_block_id"),
    depth: integer("depth").notNull().default(0),
    variant: text("variant").notNull().default(megaContentBlockVariants.PARAGRAPH),
    textSummary: text("text_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("mega_content_blocks_source_idx").on(table.sourceType, table.sourceId),
    index("mega_content_blocks_block_id_idx").on(table.blockId),
    uniqueIndex("mega_content_blocks_source_block_uidx").on(
      table.sourceType,
      table.sourceId,
      table.blockId,
    ),
  ],
);

/** GIN FTS index name (Postgres migration `0002_body_fts.sql`, EG-10). */
export const MEGA_CONTENT_BLOCKS_FTS_INDEX = "mega_content_blocks_fts_idx";

// Keep enum object referenced so tree-shaking / unused-export lints stay quiet in consumers.
void megaContentContainerTypes;
void megaContentLinkTargetKinds;

export type MegaContent = InferSelectModel<typeof megaContent>;
export type NewMegaContent = InferInsertModel<typeof megaContent>;
export type MegaContentLink = InferSelectModel<typeof megaContentLinks>;
export type NewMegaContentLink = InferInsertModel<typeof megaContentLinks>;
export type MegaContentBlock = InferSelectModel<typeof megaContentBlocks>;
export type NewMegaContentBlock = InferInsertModel<typeof megaContentBlocks>;
