// megaui:libs/database/schema/pg/user.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-04 task card):
// - Dropped the SaaS billing/referral columns (stripeCustomerId,
//   creemCustomerId, dodoCustomerId, creditBalance, referralCode,
//   referredByCode, commissionBalance, kycVerified) — SaaS-domain surface,
//   stripped per the plan's global "SaaS 模板域剥离" decision.
// - Dropped phoneNumber/phoneNumberVerified — the phone-number auth plugin
//   is explicitly excluded by the PK-06 task card ("不引入 phone/wechat 登录").
// - Kept role/banned/banReason/banExpires: these are the better-auth
//   `admin` plugin's schema fields (upstream keeps that plugin; PK-06 does
//   not list it as removed).
// - Dropped upstream's `role` NOT NULL + `DEFAULT userRoles.USER` — better-
//   auth's admin plugin documents `role` as optional / app-defaulted, not
//   DB-enforced (same GC-13 "match docs, not upstream drift" disposition as
//   banExpires / email unique). Column remains nullable text without a
//   DB default.
// - name/email now match better-auth's documented reference schema
//   (`name` NOT NULL, `email` NOT NULL UNIQUE) instead of upstream's looser
//   columns — upstream never added a DB-level unique constraint on email,
//   which is reference debt (GC-13), not an intentional diff.
// - `banExpires` is `timestamp` (better-auth's documented type), not
//   `numeric` as upstream — the numeric column there is drift vs the
//   better-auth docs, not an intentional choice.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull(),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  // better-auth `admin` plugin fields (kept — see PK-06 task card).
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
});

export type User = InferSelectModel<typeof user>;
export type NewUser = InferInsertModel<typeof user>;
