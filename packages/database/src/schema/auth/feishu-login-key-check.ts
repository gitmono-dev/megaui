// megaui-only (FSL-159): Feishu login key fingerprint table. It holds at most one row: the HMAC fingerprint
// HMAC-SHA256(ENTERPRISE_OTP_HMAC_KEY, "feishu-login-key-check:v1:" + FEISHU_APP_ID) as lowercase hex, never
// the key itself. Schema only; the runtime consistency check follows in FSL-161.
import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const feishuLoginKeyCheck = pgTable("feishu_login_key_check", {
  // Always 1: together with the primary key this keeps the table to a single row.
  id: integer("id").primaryKey().default(1),
  keyCheck: text("key_check").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  singleRow: check("feishu_login_key_check_single_row_check", sql`${table.id} = 1`),
  keyCheckFormat: check("feishu_login_key_check_key_check_check", sql`${table.keyCheck} ~ '^[0-9a-f]{64}$'`),
}));

export type FeishuLoginKeyCheck = InferSelectModel<typeof feishuLoginKeyCheck>;
export type NewFeishuLoginKeyCheck = InferInsertModel<typeof feishuLoginKeyCheck>;
