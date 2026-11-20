// megaui-only (FSL-119, FSL-163, FSL-120, FSL-147): Feishu login code storage contract and its indexes, the Feishu
// identity binding table and the Feishu session source table; issue, verify, account creation and cleanup
// services follow in their own cards.
import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { session } from "./auth";
import { user } from "./user";

export const FEISHU_LOGIN_CODE_STATES = ["reserved", "active", "consumed", "void"] as const;
export type FeishuLoginCodeState = (typeof FEISHU_LOGIN_CODE_STATES)[number];

export const feishuLoginCodes = pgTable("feishu_login_codes", {
  id: uuid("id").primaryKey(),
  flowHash: text("flow_hash").notNull(),
  // Strictly increasing reservation order within one flow, assigned under the flow lock.
  flowSeq: integer("flow_seq").notNull(),
  emailHmac: text("email_hmac").notNull(),
  // Strictly increasing reservation order within one email HMAC, assigned under the email lock.
  emailSeq: integer("email_seq").notNull(),
  // Sensitive short-lived hold: present only while the row is active (two-way CHECK below).
  email: text("email"),
  openId: text("open_id"),
  displayName: text("display_name"),
  // Only the HMAC of the code is stored, never the code itself.
  codeHmac: text("code_hmac"),
  state: text("state").notNull(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  state: check("feishu_login_codes_state_check", sql`${table.state} in ('reserved','active','consumed','void')`),
  hold: check("feishu_login_codes_hold_check", sql`(${table.state} = 'active'
      and ${table.email} is not null and ${table.openId} is not null
      and ${table.displayName} is not null and ${table.codeHmac} is not null)
    or (${table.state} <> 'active'
      and ${table.email} is null and ${table.openId} is null
      and ${table.displayName} is null and ${table.codeHmac} is null)`),
  // FSL-163: strict order within one flow; flow binding and verification select by it.
  flowOrder: uniqueIndex("feishu_login_codes_flow_seq_uidx").on(table.flowHash, table.flowSeq),
  // FSL-163: per-email cooldown lookups.
  emailCooldown: index("feishu_login_codes_email_created_at_idx").on(table.emailHmac, table.createdAt),
  // FSL-163: strict order for one email across flows; activation is decided by it.
  emailOrder: uniqueIndex("feishu_login_codes_email_seq_uidx").on(table.emailHmac, table.emailSeq),
  // FSL-163: global budget counts and cleanup.
  created: index("feishu_login_codes_created_at_idx").on(table.createdAt),
}));

export type FeishuLoginCode = InferSelectModel<typeof feishuLoginCodes>;
export type NewFeishuLoginCode = InferInsertModel<typeof feishuLoginCodes>;

// FSL-120: binds one Feishu member of one app to one local user. Only the keyed, irreversible
// HMAC of the open_id is kept: HMAC-SHA256(ENTERPRISE_OTP_HMAC_KEY, "feishu-identity:v1:" + app_id + ":" + open_id)
// as lowercase hex; the open_id itself is never stored.
export const feishuIdentities = pgTable("feishu_identities", {
  appId: text("app_id").notNull(),
  openIdHmac: text("open_id_hmac").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  openIdHmacFormat: check("feishu_identities_open_id_hmac_check", sql`${table.openIdHmac} ~ '^[0-9a-f]{64}$'`),
  // One Feishu member of one app maps to exactly one local user.
  member: unique("feishu_identities_app_open_id_hmac_unique").on(table.appId, table.openIdHmac),
  // One local user carries at most one binding per app.
  userApp: unique("feishu_identities_user_app_unique").on(table.userId, table.appId),
}));

export type FeishuIdentity = InferSelectModel<typeof feishuIdentities>;
export type NewFeishuIdentity = InferInsertModel<typeof feishuIdentities>;

// FSL-147: marks a better-auth session as issued by Feishu login. Only the session ID is kept; the row
// disappears with its session. Writing (FSL-124) and reading (FSL-126) follow in their own cards.
export const feishuLoginSessions = pgTable("feishu_login_sessions", {
  sessionId: text("session_id").primaryKey().references(() => session.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type FeishuLoginSession = InferSelectModel<typeof feishuLoginSessions>;
export type NewFeishuLoginSession = InferInsertModel<typeof feishuLoginSessions>;
