// megaui:libs/database/schema/pg/auth.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-04 task card):
// - All timestamp columns use `{ withTimezone: true }` (timestamptz).
//   Upstream auth tables use bare `timestamp()` (no tz) while upstream
//   `user` already uses timestamptz — we align auth tables to the same
//   project-wide timestamptz convention (JS `Date` / Node drivers).
// - `account`/`session`/`verification` `createdAt`/`updatedAt` add
//   `.defaultNow()` (and `$onUpdate` on updatedAt). Upstream leaves
//   account/session timestamps without defaults and verification
//   timestamps nullable — better-auth's documented schema expects NOT
//   NULL + defaults here (DEBT-10 for verification nullability;
//   account/session defaults are the same docs-alignment disposition).
// - `verification.createdAt`/`updatedAt` are NOT NULL with defaults
//   (upstream left them nullable) — DEBT-10.
// - Kept `session.impersonatedBy`: better-auth `admin` plugin session
//   field (upstream keeps that plugin; PK-06 does not remove it).
// - `session.token` UNIQUE is unchanged vs upstream (already present).
import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./user";
import { enterpriseLoginGrants } from "./enterprise-grant";
import { enterpriseIdentity } from "./enterprise-identity";

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Server-only enterprise login metadata; legacy sessions leave these null. */
  enterpriseGrantId: uuid("enterprise_grant_id")
    .references(() => enterpriseLoginGrants.id, { onDelete: "restrict" }),
  enterpriseIdentityId: text("enterprise_identity_id")
    .references(() => enterpriseIdentity.id, { onDelete: "restrict" }),
  authEpoch: integer("auth_epoch"),
  authMethod: text("auth_method"),
  // better-auth `admin` plugin field (kept — see PK-06 task card).
  impersonatedBy: text("impersonated_by"),
}, table => ({
  enterpriseGrant: uniqueIndex("session_enterprise_grant_uidx").on(table.enterpriseGrantId),
  enterpriseMetadata: check("session_enterprise_metadata_check", sql`(
    (${table.enterpriseGrantId} is null and ${table.enterpriseIdentityId} is null
      and ${table.authEpoch} is null and ${table.authMethod} is null)
    or (${table.enterpriseGrantId} is not null and ${table.enterpriseIdentityId} is not null
      and ${table.authEpoch} is not null and ${table.authEpoch} >= 0
      and ${table.authMethod} is not null and char_length(${table.authMethod}) between 1 and 64
      and ${table.authMethod} ~ '^[A-Za-z0-9._:-]+$')
  )`),
}));

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export type Account = InferSelectModel<typeof account>;
export type NewAccount = InferInsertModel<typeof account>;
export type Session = InferSelectModel<typeof session>;
export type NewSession = InferInsertModel<typeof session>;
export type Verification = InferSelectModel<typeof verification>;
export type NewVerification = InferInsertModel<typeof verification>;
