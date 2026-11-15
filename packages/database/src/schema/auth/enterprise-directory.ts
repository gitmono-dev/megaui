// FS-56：目录快照与水位。
//
// The directory facts of the worker live here: a complete snapshot is
// identified by its scope and its generation, the completion flag is set in
// the same transaction that wrote the last page, every identity keeps the
// generation it was last reconciled at, and the freshness query walks the
// observation time. A generation that is older than the stored one is
// refused by a compare-and-set, so an out-of-order page can not move the
// watermark backwards.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** One directory snapshot of an authorized scope. */
export const enterpriseDirectorySnapshots = pgTable(
  "enterprise_directory_snapshots",
  {
    id: text("id").primaryKey(),
    /** The hash of the authorized scope. */
    scopeHash: text("scope_hash").notNull(),
    /** The generation of the snapshot. */
    generation: integer("generation").notNull(),
    /** True only after every page was written in the same transaction. */
    complete: boolean("complete").notNull().default(false),
    /** How many members the snapshot holds. */
    memberCount: integer("member_count").notNull().default(0),
    /** The moment the provider was observed. */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    /** The moment the last page committed the completion flag. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    // A snapshot is identified by the scope and the generation.
    identity: uniqueIndex("enterprise_directory_snapshots_scope_generation_uidx").on(
      table.scopeHash,
      table.generation,
    ),
    // The freshness query reads the newest observation of a scope.
    freshness: index("enterprise_directory_snapshots_scope_observed_idx").on(
      table.scopeHash,
      table.observedAt,
    ),
  }),
);

/** The current generation of one authorized scope. */
export const enterpriseDirectoryWatermarks = pgTable(
  "enterprise_directory_watermarks",
  {
    id: text("id").primaryKey(),
    scopeHash: text("scope_hash").notNull(),
    /** The highest generation that was reconciled. */
    generation: integer("generation").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    scope: uniqueIndex("enterprise_directory_watermarks_scope_uidx").on(table.scopeHash),
  }),
);

/** The generation every identity was last reconciled at. */
export const enterpriseDirectoryIdentityWatermarks = pgTable(
  "enterprise_directory_identity_watermarks",
  {
    id: text("id").primaryKey(),
    identityId: text("identity_id").notNull(),
    scopeHash: text("scope_hash").notNull(),
    /** The latest generation the identity was reconciled at. */
    generation: integer("generation").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    identity: uniqueIndex("enterprise_directory_identity_watermarks_identity_uidx").on(
      table.identityId,
    ),
    scope: index("enterprise_directory_identity_watermarks_scope_idx").on(table.scopeHash),
  }),
);

export type EnterpriseDirectorySnapshot = InferSelectModel<typeof enterpriseDirectorySnapshots>;
export type NewEnterpriseDirectorySnapshot = InferInsertModel<typeof enterpriseDirectorySnapshots>;
export type EnterpriseDirectoryWatermark = InferSelectModel<typeof enterpriseDirectoryWatermarks>;
export type NewEnterpriseDirectoryWatermark = InferInsertModel<typeof enterpriseDirectoryWatermarks>;
export type EnterpriseDirectoryIdentityWatermark = InferSelectModel<
  typeof enterpriseDirectoryIdentityWatermarks
>;
export type NewEnterpriseDirectoryIdentityWatermark = InferInsertModel<
  typeof enterpriseDirectoryIdentityWatermarks
>;

/**
 * Advances the watermark with a compare-and-set.
 *
 * A new generation may only replace the stored one when it is higher, so an
 * out-of-order snapshot is refused instead of moving the watermark back.
 */
export async function advanceDirectoryWatermark(
  pool: { query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null }> },
  scopeHash: string,
  generation: number,
): Promise<boolean> {
  const result = await pool.query(
    `update "enterprise_directory_watermarks"
        set generation = $1
      where scope_hash = $2 and generation < $1`,
    [generation, scopeHash],
  );
  return (result.rowCount ?? 0) > 0;
}
