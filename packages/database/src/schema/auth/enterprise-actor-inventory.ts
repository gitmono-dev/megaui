// megaui-only (FS-90): complete approved actor inventory, including empty inventories.
// FS-70 owns validation/canonicalization and writes this receipt atomically with
// reservations and the approved operation. Freshness is distinct from ownership:
// re-observing the same owners must not invalidate an approved migration digest.
import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { enterprisePolicy } from "./enterprise-policy";

export interface InventoryActorSource {
  actor: string;
  /** Explicit subject ids; local owners use their original user.id. */
  owners: string[];
}

export const enterpriseActorInventory = pgTable("enterprise_actor_inventory", {
  scope: text("scope").primaryKey().references(() => enterprisePolicy.scope),
  operationId: uuid("operation_id").notNull(),
  /** SHA-256 of the exact approved source bytes. */
  sourceDigest: text("source_digest").notNull(),
  /** Canonical local subject-to-actor coverage digest; detects new same-name users. */
  subjectsDigest: text("subjects_digest").notNull(),
  /** Canonical ownership digest excludes observation/approval metadata. */
  ownershipDigest: text("ownership_digest").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  upstreamActors: jsonb("upstream_actors").$type<InventoryActorSource[]>().notNull(),
}, (table) => ({
  sourceDigestFormat: check("enterprise_actor_inventory_source_digest_check", sql`${table.sourceDigest} ~ '^[0-9a-f]{64}$'`),
  subjectsDigestFormat: check("enterprise_actor_inventory_subjects_digest_check", sql`${table.subjectsDigest} ~ '^[0-9a-f]{64}$'`),
  ownershipDigestFormat: check("enterprise_actor_inventory_ownership_digest_check", sql`${table.ownershipDigest} ~ '^[0-9a-f]{64}$'`),
  finiteObservation: check("enterprise_actor_inventory_observed_at_check", sql`isfinite(${table.observedAt})`),
  sourceArray: check("enterprise_actor_inventory_upstream_actors_check", sql`jsonb_typeof(${table.upstreamActors}) = 'array'`),
}));

export type EnterpriseActorInventory = InferSelectModel<typeof enterpriseActorInventory>;
export type NewEnterpriseActorInventory = InferInsertModel<typeof enterpriseActorInventory>;
