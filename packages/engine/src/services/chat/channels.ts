// megaui:libs/mega/services/repos/chat-repo.ts@0ff3a9d (loadChannel slice)
//
// Diff vs upstream (GC-03, registered on the EG-07 task card):
// - `getPeerLastReadMessageId` duplicates the 6-line read-only query EG-02's
//   `createMembersService` already has (as an unexported closure) — it is
//   not re-forked business logic, just the same `mega_channel_members`
//   lookup, kept local because members.ts does not export it and this
//   card's write set may not touch `services/members.ts`.
// - Correctness fix: upstream persists a DM channel's `name` once at
//   creation time (`openOrCreateDm` sets it to the *creator's* view of the
//   peer's display name) and `loadChannel` never recomputes it — so the
//   non-creating participant would see their own name as the channel
//   title. `loadChannel` here always derives `name` from the freshly
//   resolved `participant`, per viewer.
import { and, asc, eq, ne } from "drizzle-orm";
import {
  megaChannelKinds,
  megaChannelMembers,
  megaChannels,
  type Database,
} from "@megaui/database";
import type { Channel, DirectMessageChannel, WorkspaceChannel } from "@megaui/core";
import { placeholderUser, resolveUser } from "./users";

type ChannelRow = typeof megaChannels.$inferSelect;

export async function getPeerLastReadMessageId(
  database: Database,
  channelId: string,
  selfUserId: string,
): Promise<string | undefined> {
  const [row] = await database
    .select({ lastReadMessageId: megaChannelMembers.lastReadMessageId })
    .from(megaChannelMembers)
    .where(
      and(eq(megaChannelMembers.channelId, channelId), ne(megaChannelMembers.userId, selfUserId)),
    )
    .limit(1);
  return row?.lastReadMessageId ?? undefined;
}

export async function loadChannel(
  database: Database,
  row: ChannelRow,
  actorUserId: string | null | undefined,
): Promise<Channel> {
  const base = {
    id: row.id,
    name: row.name,
    topic: row.topic ?? undefined,
    unreadCount: 0,
    mentionCount: 0,
  };

  if (row.kind === megaChannelKinds.DM) {
    const participantIds = Array.isArray(row.participantIds) ? row.participantIds : [];
    const selfId = actorUserId?.trim();
    const peerId = participantIds.find((id) => id !== selfId) ?? participantIds[0];
    const participant = peerId ? await resolveUser(database, peerId) : undefined;
    const participantLastReadMessageId = selfId
      ? await getPeerLastReadMessageId(database, row.id, selfId)
      : undefined;
    return {
      ...base,
      name: participant?.displayName ?? row.name,
      kind: "dm",
      participant: participant ?? placeholderUser(row.id),
      participantLastReadMessageId,
    } satisfies DirectMessageChannel;
  }

  return {
    ...base,
    kind: "channel",
    visibility: row.kind === megaChannelKinds.PRIVATE ? "private" : "public",
  } satisfies WorkspaceChannel;
}

export async function listChannelRows(database: Database): Promise<ChannelRow[]> {
  return database.select().from(megaChannels).orderBy(asc(megaChannels.name));
}

export async function getChannelRow(database: Database, channelId: string): Promise<ChannelRow | undefined> {
  const [row] = await database.select().from(megaChannels).where(eq(megaChannels.id, channelId)).limit(1);
  return row;
}
