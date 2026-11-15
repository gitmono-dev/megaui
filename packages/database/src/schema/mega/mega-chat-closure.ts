// megaui:libs/database/schema/pg/mega-chat-closure.ts@0ff3a9d
//
// Ported for PK-05 (REF-07). SaaS tables intentionally omitted at package scope.
import { InferInsertModel, InferSelectModel, sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  megaChannelMemberRoles,
  megaNotificationKinds,
} from "./constants";
import { megaChannels, megaMessages } from "./mega-chat";
import { user } from "../auth/user";

export { megaChannelMemberRoles, megaNotificationKinds };
export type {
  MegaChannelMemberRole,
  MegaNotificationKind,
} from "./constants";

/**
 * Chat closure domain (CE-130).
 * Channel membership + per-user unread watermark; DM uses the same table
 * (exactly two member rows). Notifications are real rows for Inbox (CE-133).
 */
export const megaChannelMembers = pgTable(
  "mega_channel_members",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => megaChannels.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default(megaChannelMemberRoles.MEMBER),
    lastReadMessageId: text("last_read_message_id").references(
      () => megaMessages.id,
      { onDelete: "set null" },
    ),
    muted: boolean("muted").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("mega_channel_members_channel_user_uidx").on(
      table.channelId,
      table.userId,
    ),
  ],
);

export const megaNotifications = pgTable(
  "mega_notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default(megaNotificationKinds.MENTION),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    url: text("url").notNull(),
    summary: text("summary").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Unread fan-out: (userId, readAt IS NULL) partial index (CE-130 AC).
    index("mega_notifications_user_unread_idx")
      .on(table.userId)
      .where(sql`${table.readAt} IS NULL`),
  ],
);

export type MegaChannelMember = InferSelectModel<typeof megaChannelMembers>;
export type NewMegaChannelMember = InferInsertModel<typeof megaChannelMembers>;
export type MegaNotification = InferSelectModel<typeof megaNotifications>;
export type NewMegaNotification = InferInsertModel<typeof megaNotifications>;
