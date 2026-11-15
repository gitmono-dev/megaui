// megaui-only (FS-32): one-time login grants and server-only session metadata.
import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { user } from "./user";
import { enterpriseChallenges } from "./enterprise-login";
import { enterpriseIdentity } from "./enterprise-identity";
import { enterprisePolicy } from "./enterprise-policy";

/**
 * A grant is created by the later OTP-consume transaction and is never a
 * session-token store. Its UUID is the only server-side bridge to a session.
 */
export const enterpriseLoginGrants = pgTable("enterprise_login_grants", {
  id: uuid("id").primaryKey(),
  challengeId: uuid("challenge_id")
    .notNull()
    .references(() => enterpriseChallenges.id, { onDelete: "restrict" }),
  scope: text("scope").notNull().references(() => enterprisePolicy.scope, { onDelete: "restrict" }),
  deploymentRole: text("deployment_role").notNull(),
  localUserId: text("local_user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  identityId: text("identity_id")
    .notNull()
    .references(() => enterpriseIdentity.id, { onDelete: "restrict" }),
  identityVersion: integer("identity_version").notNull(),
  authEpoch: integer("auth_epoch").notNull(),
  flowHash: text("flow_hash").notNull(),
  generation: integer("generation").notNull(),
  purpose: text("purpose").notNull().default("login"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  recoverUntil: timestamp("recover_until", { withTimezone: true }).notNull(),
}, table => ({
  challenge: uniqueIndex("enterprise_login_grants_challenge_uidx").on(table.challengeId),
  recovery: index("enterprise_login_grants_recover_until_idx").on(table.recoverUntil),
  binding: check("enterprise_login_grants_binding_check", sql`${table.deploymentRole} in ('development','test','production','canary')
    and ${table.purpose} = 'login' and ${table.identityVersion} > 0 and ${table.authEpoch} >= 0
    and ${table.generation} > 0 and ${table.flowHash} ~ '^[0-9a-f]{64}$'
    and char_length(${table.scope}) between 1 and 256 and ${table.scope} ~ '[^[:space:]]'`),
  lifetime: check("enterprise_login_grants_lifetime_check", sql`isfinite(${table.createdAt})
    and isfinite(${table.recoverUntil}) and ${table.recoverUntil} > ${table.createdAt}
    and ${table.recoverUntil} <= ${table.createdAt} + interval '390 seconds'`),
}));

export type EnterpriseLoginGrant = InferSelectModel<typeof enterpriseLoginGrants>;
export type NewEnterpriseLoginGrant = InferInsertModel<typeof enterpriseLoginGrants>;
