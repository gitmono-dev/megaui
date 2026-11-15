// megaui:libs/database/schema/pg/mega-chat.ts@0ff3a9d
//
// Ported for PK-05 (REF-07). SaaS tables intentionally omitted at package scope.
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { megaChannelKinds } from "./constants";
import { user } from "../auth/user";
import { createdAtColumn, updatedAtColumn } from "../timestamps";

export { megaChannelKinds };
export type { MegaChannelKind } from "./constants";

/**
 * Chat domain metadata (CE-17).
 * Message body / segments move through mega_content; mega_messages stores
 * authoring and reaction metadata only.
 * CE-18 temporarily persists ChatSegment arrays in mega_content.body_json as
 * `{ segments: ChatSegment[] }`; CE-80 will migrate this JSON envelope during
 * content containerization. Do not add a segments column to mega_messages.
 */
export const megaChannels = pgTable("mega_channels", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull().default(megaChannelKinds.PUBLIC),
  name: text("name").notNull(),
  topic: text("topic"),
  participantIds: jsonb("participant_ids").$type<string[]>().notNull().default([]),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export const megaMessages = pgTable("mega_messages", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => megaChannels.id, { onDelete: "cascade" }),
  authorId: text("author_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  reactions: jsonb("reactions")
    .$type<Array<Record<string, unknown>>>()
    .notNull()
    .default([]),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
});

export const megaAgentThreads = pgTable("mega_agent_threads", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  scopePackageId: text("scope_package_id"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export type MegaChannel = InferSelectModel<typeof megaChannels>;
export type NewMegaChannel = InferInsertModel<typeof megaChannels>;
export type MegaMessage = InferSelectModel<typeof megaMessages>;
export type NewMegaMessage = InferInsertModel<typeof megaMessages>;
export type MegaAgentThread = InferSelectModel<typeof megaAgentThreads>;
export type NewMegaAgentThread = InferInsertModel<typeof megaAgentThreads>;
