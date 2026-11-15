// megaui-only (FS-55): durable enterprise login notification outbox.
//
// A row is created after a successful session/grant write.  It contains the
// destination snapshot and the data needed by FS-31's notification template,
// but deliberately has no authentication material.  The grant UUID is the
// idempotency boundary: a grant can produce at most one notification row.
import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { enterpriseLoginGrants } from "./enterprise-grant";

/** Durable delivery states used by the future notification worker. */
export const ENTERPRISE_NOTIFICATION_STATES = [
  "pending",
  "sending",
  "sent",
  "skipped",
  "failed",
] as const;
export type EnterpriseNotificationState =
  (typeof ENTERPRISE_NOTIFICATION_STATES)[number];

export const enterpriseNotificationOutbox = pgTable(
  "enterprise_notification_outbox",
  {
    id: uuid("id").primaryKey(),
    /** The successful login grant; this is also the idempotency key. */
    grantId: uuid("grant_id")
      .notNull()
      .references(() => enterpriseLoginGrants.id, { onDelete: "restrict" }),
    /** The profile address captured for this notification attempt; null is a durable skipped row. */
    destinationEmail: text("destination_email"),
    /** Opaque profile-address version (normally the profile updated_at value). */
    destinationVersion: text("destination_version").notNull(),
    /** FS-31 template fields; none is an OTP, token, or auth link. */
    recipientName: text("recipient_name").notNull(),
    loginAt: timestamp("login_at", { withTimezone: true }).notNull(),
    device: text("device").notNull(),
    source: text("source").notNull(),
    appName: text("app_name").notNull(),
    appUrl: text("app_url").notNull(),
    locale: text("locale").notNull().default("en"),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    skippedAt: timestamp("skipped_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    /** A bounded retention deadline for metadata cleanup. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    grant: uniqueIndex("enterprise_notification_outbox_grant_uidx").on(
      table.grantId,
    ),
    delivery: index("enterprise_notification_outbox_delivery_idx").on(
      table.state,
      table.availableAt,
    ),
    cleanup: index("enterprise_notification_outbox_expires_at_idx").on(
      table.expiresAt,
    ),
    state: check(
      "enterprise_notification_outbox_state_check",
      sql`${table.state} in ('pending','sending','sent','skipped','failed')`,
    ),
    locale: check(
      "enterprise_notification_outbox_locale_check",
      sql`${table.locale} in ('en','zh-CN')`,
    ),
    fields: check(
      "enterprise_notification_outbox_fields_check",
      sql`(${table.destinationEmail} is null or (char_length(${table.destinationEmail}) between 1 and 320
        and ${table.destinationEmail} !~ '[[:space:]]'))
        and char_length(${table.destinationVersion}) between 1 and 256
        and ${table.destinationVersion} !~ '[[:space:]]'
        and char_length(${table.recipientName}) between 1 and 256
        and char_length(${table.device}) between 1 and 512
        and char_length(${table.source}) between 1 and 512
        and char_length(${table.appName}) between 1 and 256
        and ${table.appUrl} ~ '^https?://[^?#[:space:]]+$'`,
    ),
    attempts: check(
      "enterprise_notification_outbox_attempts_check",
      sql`${table.attempts} >= 0`,
    ),
    lifetime: check(
      "enterprise_notification_outbox_lifetime_check",
      sql`isfinite(${table.loginAt})
        and isfinite(${table.availableAt})
        and isfinite(${table.createdAt})
        and isfinite(${table.expiresAt})
        and ${table.expiresAt} > ${table.createdAt}
        and ${table.expiresAt} <= ${table.createdAt} + interval '31 days'`,
    ),
    terminal: check(
      "enterprise_notification_outbox_terminal_check",
      sql`(
        ${table.state} in ('pending','sending','failed')
          and ${table.sentAt} is null
          and ${table.skippedAt} is null
      ) or (
        ${table.state} = 'sent'
          and ${table.sentAt} is not null
          and ${table.skippedAt} is null
      ) or (
        ${table.state} = 'skipped'
          and ${table.sentAt} is null
          and ${table.skippedAt} is not null
      )`,
    ),
  }),
);

/** Short alias used by callers that refer to the table as notifications. */
export const enterpriseNotifications = enterpriseNotificationOutbox;

export type EnterpriseNotification = InferSelectModel<
  typeof enterpriseNotificationOutbox
>;
export type NewEnterpriseNotification = InferInsertModel<
  typeof enterpriseNotificationOutbox
>;
