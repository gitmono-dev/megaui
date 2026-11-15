// megaui:libs/mega/services/unread.ts@0ff3a9d
//
// This is the "closure" domain the task card's Current-evidence row points
// at (REF-07 `schema/pg/mega-chat-closure.ts` header comment: "Chat closure
// domain... Channel membership + per-user unread watermark"). PK-05 kept
// only `mega_channel_members` (no separate `mega_chat_closure` table, see
// plan revision R3) — the watermark lives on
// `mega_channel_members.last_read_message_id` exactly as upstream's
// `unread.ts` already assumes. The pure comparisons this module calls
// (`messagesAfterWatermark` / `messageMentionsActor` / `maxMessageWatermark`)
// are PK-02's `@megaui/core/unread-math`, not re-implemented here — this
// module is only the persisted half (member-row read/write + message
// hydration) plus the aggregation helper.
//
// Diff vs upstream (GC-03, registered on the EG-07 task card):
// - No `MEGA_CHAT_DATA_BACKEND=mock` branch (DEBT-04) — PG only.
// - No process-wide `CURRENT_USER` fallback: `computeChannelUnread` /
//   `advanceMemberWatermark` return an all-zero / throw for a missing
//   actor instead of silently attributing reads to a fixture user
//   (GC-07 fail-closed).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { megaChannelMemberRoles, megaChannelMembers, type Database } from "@megaui/database";
import {
  maxMessageWatermark,
  messageMentionsActor,
  messagesAfterWatermark,
  type ChatMessage,
  type User,
} from "@megaui/core";
import { MegaUnauthorizedError } from "../../errors";
import { listAllChannelMessagesFlat } from "./messages";
import { resolveUser } from "./users";

export interface ChannelUnreadProjection {
  unreadCount: number;
  mentionCount: number;
  lastReadMessageId?: string;
  muted: boolean;
  /** Latest top-level (non-thread-reply) message id that @-mentions the actor. */
  latestMentionMessageId?: string;
}

interface MemberState {
  lastReadMessageId?: string;
  muted: boolean;
  exists: boolean;
}

async function readMemberState(
  database: Database,
  channelId: string,
  actorUserId: string,
): Promise<MemberState> {
  const [row] = await database
    .select({
      lastReadMessageId: megaChannelMembers.lastReadMessageId,
      muted: megaChannelMembers.muted,
    })
    .from(megaChannelMembers)
    .where(
      and(eq(megaChannelMembers.channelId, channelId), eq(megaChannelMembers.userId, actorUserId)),
    )
    .limit(1);
  return {
    lastReadMessageId: row?.lastReadMessageId ?? undefined,
    muted: row?.muted ?? false,
    exists: Boolean(row),
  };
}

/**
 * Ensures the actor has a membership row so a watermark can be stored
 * (public channels are workspace-implicit until the first read/mark-read).
 */
export async function ensureMemberRowForWatermark(
  database: Database,
  channelId: string,
  actorUserId: string,
): Promise<void> {
  const state = await readMemberState(database, channelId, actorUserId);
  if (state.exists) return;
  await database
    .insert(megaChannelMembers)
    .values({
      id: `chmem_${randomUUID()}`,
      channelId,
      userId: actorUserId,
      role: megaChannelMemberRoles.MEMBER,
      lastReadMessageId: null,
      muted: false,
      joinedAt: new Date(),
    })
    .onConflictDoNothing({ target: [megaChannelMembers.channelId, megaChannelMembers.userId] });
}

async function resolveActor(database: Database, actorUserId: string): Promise<User> {
  return resolveUser(database, actorUserId);
}

export async function computeChannelUnread(
  database: Database,
  channelId: string,
  actorUserId: string | null | undefined,
): Promise<ChannelUnreadProjection> {
  const trimmed = actorUserId?.trim();
  if (!trimmed) return { unreadCount: 0, mentionCount: 0, muted: false };

  const actor = await resolveActor(database, trimmed);
  const state = await readMemberState(database, channelId, trimmed);
  const messages: readonly ChatMessage[] = await listAllChannelMessagesFlat(database, channelId);

  const unread = messagesAfterWatermark(messages, state.lastReadMessageId);
  const mentions = unread.filter((message) => messageMentionsActor(message, actor));
  // Jump target must be a top-level row — thread replies are not rendered
  // as channel list rows.
  const ordered = messagesAfterWatermark(messages, undefined);
  const latestMention = [...ordered]
    .reverse()
    .find((message) => !message.threadId && messageMentionsActor(message, actor));

  return {
    unreadCount: state.muted ? 0 : unread.length,
    mentionCount: state.muted ? 0 : mentions.length,
    lastReadMessageId: state.lastReadMessageId,
    muted: state.muted,
    latestMentionMessageId: latestMention?.id,
  };
}

/** Sum unread across channels, excluding muted memberships (closure-aggregation rule). */
export function aggregateUnreadCounts(
  projections: readonly Pick<ChannelUnreadProjection, "unreadCount" | "mentionCount" | "muted">[],
): { unreadCount: number; mentionCount: number } {
  return projections.reduce(
    (acc, row) => {
      if (row.muted) return acc;
      return {
        unreadCount: acc.unreadCount + row.unreadCount,
        mentionCount: acc.mentionCount + row.mentionCount,
      };
    },
    { unreadCount: 0, mentionCount: 0 },
  );
}

export interface ChannelUnreadFields {
  unreadCount: number;
  mentionCount: number;
  lastReadMessageId?: string;
  latestMentionMessageId?: string;
}

export async function projectChannelUnread<
  T extends { id: string } & ChannelUnreadFields,
>(database: Database, channel: T, actorUserId: string | null | undefined): Promise<T> {
  const unread = await computeChannelUnread(database, channel.id, actorUserId);
  return {
    ...channel,
    unreadCount: unread.unreadCount,
    mentionCount: unread.mentionCount,
    lastReadMessageId: unread.lastReadMessageId ?? channel.lastReadMessageId,
    latestMentionMessageId: unread.latestMentionMessageId,
  };
}

/** Advances the actor's watermark to `targetMessageId` (or the latest message). Never moves backward. */
export async function advanceMemberWatermark(
  database: Database,
  channelId: string,
  actorUserId: string | null | undefined,
  targetMessageId?: string | null,
): Promise<ChannelUnreadProjection> {
  const trimmed = actorUserId?.trim();
  if (!trimmed) throw new MegaUnauthorizedError("A signed-in session is required");
  await ensureMemberRowForWatermark(database, channelId, trimmed);

  const messages = await listAllChannelMessagesFlat(database, channelId);
  const ordered = messagesAfterWatermark(messages, undefined);
  const latest = ordered.at(-1);
  const candidate = targetMessageId?.trim() || latest?.id;

  // `FOR UPDATE`-lock the member row and recompute `next` against the
  // locked read (not the pre-transaction `readMemberState` above) so two
  // concurrent advances (e.g. `markChannelRead` racing a `sendChatMessage`
  // watermark bump) cannot interleave a read-then-write and move the
  // watermark backward.
  await database.transaction(async (tx) => {
    const [row] = await tx
      .select({ lastReadMessageId: megaChannelMembers.lastReadMessageId })
      .from(megaChannelMembers)
      .where(and(eq(megaChannelMembers.channelId, channelId), eq(megaChannelMembers.userId, trimmed)))
      .for("update")
      .limit(1);
    const currentWatermark = row?.lastReadMessageId ?? undefined;
    const next = maxMessageWatermark(messages, currentWatermark, candidate);
    if (next !== currentWatermark) {
      await tx
        .update(megaChannelMembers)
        .set({ lastReadMessageId: next ?? null })
        .where(and(eq(megaChannelMembers.channelId, channelId), eq(megaChannelMembers.userId, trimmed)));
    }
  });

  return computeChannelUnread(database, channelId, trimmed);
}
