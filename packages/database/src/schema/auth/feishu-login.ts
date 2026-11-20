// megaui-only (FSL-119, FSL-163): Feishu login code storage contract and its indexes; issue, verify and cleanup services follow in their own cards.
import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
