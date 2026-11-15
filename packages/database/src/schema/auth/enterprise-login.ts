// megaui-only (FS-33): storage contracts; request, budget and consume services follow in their own cards.
import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { enterpriseIdentity } from "./enterprise-identity";
import { enterprisePolicy } from "./enterprise-policy";
import { user } from "./user";

export const ENTERPRISE_PAIRING_STATES = ["pending", "confirmed", "expired"] as const;
export const ENTERPRISE_CHALLENGE_STATES = ["active", "consumed", "superseded", "revoked", "expired"] as const;
export const ENTERPRISE_LOGIN_BUDGET_KINDS = ["anonymous-ip", "sender-send", "sender-invalid", "verify-failure"] as const;

export const enterprisePairings = pgTable("enterprise_pairings", {
  id: uuid("id").primaryKey(),
  scope: text("scope").notNull().references(() => enterprisePolicy.scope),
  deploymentRole: text("deployment_role").notNull(),
  tenantKey: text("tenant_key").notNull(),
  appId: text("app_id").notNull(),
  flowHash: text("flow_hash").notNull(),
  generation: integer("generation").notNull(),
  purpose: text("purpose").notNull().default("login"),
  tokenHash: text("token_hash").notNull(),
  // Unknown aliases still create the same opaque pending response.
  intendedIdentityId: text("intended_identity_id"),
  state: text("state").notNull().default("pending"),
  confirmedIdentityVersion: integer("confirmed_identity_version"),
  confirmedMessageId: text("confirmed_message_id"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
}, table => ({
  identity: foreignKey({ name: "enterprise_pairings_identity_fk", columns: [table.intendedIdentityId], foreignColumns: [enterpriseIdentity.id] }).onDelete("cascade"),
  token: uniqueIndex("enterprise_pairings_token_hash_uidx").on(table.tokenHash),
  generation: uniqueIndex("enterprise_pairings_flow_generation_uidx").on(table.scope, table.deploymentRole, table.purpose, table.flowHash, table.generation),
  pending: uniqueIndex("enterprise_pairings_pending_flow_uidx").on(table.scope, table.deploymentRole, table.purpose, table.flowHash).where(sql`${table.state} = 'pending'`),
  message: uniqueIndex("enterprise_pairings_message_uidx").on(table.scope, table.tenantKey, table.appId, table.confirmedMessageId).where(sql`${table.confirmedMessageId} is not null`),
  cleanup: index("enterprise_pairings_retain_until_idx").on(table.retainUntil),
  // FS-91: scope/role equality followed by the bounded cleanup page order.
  scopedCleanup: index("enterprise_pairings_scope_retention_idx").on(table.scope, table.deploymentRole, table.retainUntil, table.id),
  confirmedFlows: index("enterprise_pairings_identity_state_idx").on(table.scope, table.intendedIdentityId, table.state),
  binding: check("enterprise_pairings_binding_check", sql`${table.deploymentRole} in ('development','test','production','canary')
    and ${table.purpose} = 'login' and ${table.generation} > 0
    and ${table.flowHash} ~ '^[0-9a-f]{64}$' and ${table.tokenHash} ~ '^[0-9a-f]{64}$'
    and char_length(${table.tenantKey}) between 1 and 256 and ${table.tenantKey} ~ '[^[:space:]]'
    and char_length(${table.appId}) between 1 and 256 and ${table.appId} ~ '[^[:space:]]'`),
  state: check("enterprise_pairings_state_check", sql`${table.state} in ('pending','confirmed','expired')`),
  confirmation: check("enterprise_pairings_confirmation_check", sql`(
    (${table.confirmedAt} is null and ${table.confirmedMessageId} is null and ${table.confirmedIdentityVersion} is null)
    or (${table.confirmedAt} is not null and ${table.confirmedMessageId} is not null and ${table.confirmedIdentityVersion} is not null
      and ${table.intendedIdentityId} is not null and ${table.confirmedIdentityVersion} > 0
      and char_length(${table.confirmedMessageId}) between 1 and 256 and ${table.confirmedMessageId} ~ '[^[:space:]]'))
    and (${table.state} <> 'pending' or ${table.confirmedAt} is null)
    and (${table.state} <> 'confirmed' or ${table.confirmedAt} is not null)`),
  lifetime: check("enterprise_pairings_lifetime_check", sql`isfinite(${table.createdAt}) and isfinite(${table.expiresAt}) and isfinite(${table.retainUntil})
    and ${table.expiresAt} = ${table.createdAt} + interval '120 seconds'
    and (${table.confirmedAt} is null or (isfinite(${table.confirmedAt}) and ${table.confirmedAt} >= ${table.createdAt} and ${table.confirmedAt} < ${table.expiresAt}))
    and ${table.retainUntil} = coalesce(${table.confirmedAt} + interval '390 seconds', ${table.expiresAt})`),
}));

export const enterpriseChallenges = pgTable("enterprise_challenges", {
  id: uuid("id").primaryKey(),
  scope: text("scope").notNull().references(() => enterprisePolicy.scope),
  deploymentRole: text("deployment_role").notNull(),
  localUserId: text("local_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  identityId: text("identity_id").notNull().references(() => enterpriseIdentity.id, { onDelete: "cascade" }),
  identityVersion: integer("identity_version").notNull(),
  flowHash: text("flow_hash").notNull(),
  generation: integer("generation").notNull(),
  purpose: text("purpose").notNull().default("login"),
  // A pairing may be cleaned after recovery; consuming a code does not depend on keeping that row.
  pairingId: uuid("pairing_id").references(() => enterprisePairings.id, { onDelete: "set null" }),
  codeHmac: text("code_hmac"),
  hmacKeyId: text("hmac_key_id"),
  state: text("state").notNull().default("active"),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  recoverUntil: timestamp("recover_until", { withTimezone: true }),
  secretExpiresAt: timestamp("secret_expires_at", { withTimezone: true }).notNull(),
  secretClearedAt: timestamp("secret_cleared_at", { withTimezone: true }),
}, table => ({
  generation: uniqueIndex("enterprise_challenges_flow_generation_uidx").on(table.scope, table.deploymentRole, table.purpose, table.flowHash, table.generation),
  active: uniqueIndex("enterprise_challenges_active_flow_uidx").on(table.scope, table.deploymentRole, table.purpose, table.flowHash).where(sql`${table.state} = 'active'`),
  pairing: uniqueIndex("enterprise_challenges_pairing_uidx").on(table.pairingId),
  // The delivery FK binds the exact expiry, not just an independently supplied challenge id.
  deliveryExpiry: unique("enterprise_challenges_id_expiry_unique").on(table.id, table.expiresAt),
  expiry: index("enterprise_challenges_expires_at_idx").on(table.expiresAt),
  secretCleanup: index("enterprise_challenges_secret_expiry_idx").on(table.secretExpiresAt).where(sql`${table.codeHmac} is not null`),
  binding: check("enterprise_challenges_binding_check", sql`${table.deploymentRole} in ('development','test','production','canary')
    and ${table.purpose} = 'login' and ${table.generation} > 0 and ${table.identityVersion} > 0
    and ${table.flowHash} ~ '^[0-9a-f]{64}$' and ${table.failedAttempts} between 0 and 5`),
  state: check("enterprise_challenges_state_check", sql`${table.state} in ('active','consumed','superseded','revoked','expired')`),
  lifetime: check("enterprise_challenges_lifetime_check", sql`isfinite(${table.createdAt}) and isfinite(${table.expiresAt}) and isfinite(${table.secretExpiresAt})
    and ${table.expiresAt} = ${table.createdAt} + interval '300 seconds'
    and ${table.secretExpiresAt} >= ${table.createdAt} and ${table.secretExpiresAt} <= coalesce(${table.recoverUntil}, ${table.expiresAt})
    and (${table.state} <> 'active' or ${table.secretExpiresAt} = ${table.expiresAt})
    and (${table.state} <> 'consumed' or ${table.secretExpiresAt} = ${table.recoverUntil})`),
  consumption: check("enterprise_challenges_consumption_check", sql`(
    (${table.consumedAt} is null and ${table.recoverUntil} is null)
    or (${table.consumedAt} is not null and ${table.recoverUntil} is not null
      and isfinite(${table.consumedAt}) and isfinite(${table.recoverUntil})
      and ${table.consumedAt} >= ${table.createdAt} and ${table.consumedAt} < ${table.expiresAt}
      and ${table.recoverUntil} = ${table.consumedAt} + interval '90 seconds'))
    and (${table.state} <> 'consumed' or ${table.consumedAt} is not null)
    and (${table.state} <> 'active' or ${table.consumedAt} is null)`),
  secret: check("enterprise_challenges_secret_check", sql`(
    (${table.codeHmac} is not null and ${table.hmacKeyId} is not null and ${table.secretClearedAt} is null
      and ${table.codeHmac} ~ '^[0-9a-f]{64}$' and ${table.hmacKeyId} ~ '^[A-Za-z0-9._-]{1,128}$')
    or (${table.codeHmac} is null and ${table.hmacKeyId} is null and ${table.secretClearedAt} is not null
      and isfinite(${table.secretClearedAt}) and ${table.secretClearedAt} >= ${table.secretExpiresAt}))
    and (${table.state} <> 'active' or ${table.codeHmac} is not null)`),
}));

export const enterpriseLoginBudgets = pgTable("enterprise_login_budgets", {
  scope: text("scope").notNull().references(() => enterprisePolicy.scope),
  deploymentRole: text("deployment_role").notNull(),
  budgetKind: text("budget_kind").notNull(),
  // Anonymous keys are daily HMACs; verified failure keys bind identity+flow, never generation.
  subjectHash: text("subject_hash").notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  used: integer("used").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  nextAllowedAt: timestamp("next_allowed_at", { withTimezone: true }),
}, table => ({
  scopeKey: primaryKey({ name: "enterprise_login_budgets_scope_key_pk", columns: [table.scope, table.deploymentRole, table.budgetKind, table.subjectHash, table.windowStartedAt] }),
  cleanup: index("enterprise_login_budgets_expires_at_idx").on(table.expiresAt),
  binding: check("enterprise_login_budgets_binding_check", sql`${table.deploymentRole} in ('development','test','production','canary')
    and ${table.budgetKind} in ('anonymous-ip','sender-send','sender-invalid','verify-failure')
    and ${table.subjectHash} ~ '^[0-9a-f]{64}$' and ${table.used} >= 0`),
  lifetime: check("enterprise_login_budgets_lifetime_check", sql`isfinite(${table.windowStartedAt}) and isfinite(${table.expiresAt})
    and ${table.expiresAt} > ${table.windowStartedAt} and (${table.nextAllowedAt} is null or isfinite(${table.nextAllowedAt}))`),
}));

export type EnterprisePairing = InferSelectModel<typeof enterprisePairings>;
export type NewEnterprisePairing = InferInsertModel<typeof enterprisePairings>;
export type EnterpriseChallenge = InferSelectModel<typeof enterpriseChallenges>;
export type NewEnterpriseChallenge = InferInsertModel<typeof enterpriseChallenges>;
export type EnterpriseLoginBudget = InferSelectModel<typeof enterpriseLoginBudgets>;
export type NewEnterpriseLoginBudget = InferInsertModel<typeof enterpriseLoginBudgets>;
