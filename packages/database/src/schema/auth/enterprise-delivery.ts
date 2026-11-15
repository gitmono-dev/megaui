// megaui-only (FS-33): encrypted payloads stay outside the general leased-job queue.
import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { enterpriseChallenges } from "./enterprise-login";

export const enterpriseDmDeliveries = pgTable("enterprise_dm_deliveries", {
  // This stable UUID is also the later provider idempotency key.
  id: uuid("id").primaryKey(),
  challengeId: uuid("challenge_id").notNull(),
  deliveryKeyId: text("delivery_key_id").notNull(),
  // The crypto service owns the opaque AEAD envelope format and its independent key.
  encryptedPayload: text("encrypted_payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, table => ({
  challenge: uniqueIndex("enterprise_dm_deliveries_challenge_uidx").on(table.challengeId),
  expiryBinding: foreignKey({ name: "enterprise_dm_deliveries_challenge_expiry_fk",
    columns: [table.challengeId, table.expiresAt], foreignColumns: [enterpriseChallenges.id, enterpriseChallenges.expiresAt] }).onDelete("cascade"),
  cleanup: index("enterprise_dm_deliveries_expires_at_idx").on(table.expiresAt),
  envelope: check("enterprise_dm_deliveries_envelope_check", sql`${table.deliveryKeyId} ~ '^[A-Za-z0-9._-]{1,128}$'
    and char_length(${table.encryptedPayload}) between 48 and 8192 and ${table.encryptedPayload} ~ '^[A-Za-z0-9_-]+$'`),
  lifetime: check("enterprise_dm_deliveries_lifetime_check", sql`isfinite(${table.createdAt}) and isfinite(${table.expiresAt}) and ${table.expiresAt} > ${table.createdAt}
    and (${table.firstAttemptAt} is null or (isfinite(${table.firstAttemptAt}) and ${table.firstAttemptAt} >= ${table.createdAt}))
    and (${table.sentAt} is null or (isfinite(${table.sentAt}) and ${table.sentAt} >= ${table.createdAt}))`),
}));

export type EnterpriseDmDelivery = InferSelectModel<typeof enterpriseDmDeliveries>;
export type NewEnterpriseDmDelivery = InferInsertModel<typeof enterpriseDmDeliveries>;
