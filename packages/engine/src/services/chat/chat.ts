// megaui:libs/mega/services/chat.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-07 task card):
// - Channel CRUD / membership (`createChannel`, `openOrCreateDm`,
//   `listChannelMembers`, `inviteChannelMember`, `removeChannelMember`,
//   `leaveChannel`) are EG-02's `MembersService` methods, passed through
//   as-is (task card instruction: "reuse `createMembersService`, do not
//   fork"). `listChannels` / `markChannelRead` compose `MembersService`
//   with this card's own channel-row loading + unread projection, mirroring
//   how upstream's `chat.ts` composes `members.ts` + `unread.ts` via
//   dynamic `import()` (megaui wires them explicitly instead).
// - `toggleMessageReaction` requires an explicit `actorUserId` and is
//   channel-access-gated + `FOR UPDATE`-locked (GC-08: concurrent toggles
//   cannot race past the GC-10 reaction-capacity check) — upstream's
//   version takes no actor and no lock (single-viewer mock store).
// - `sendChatMessage` / `replyToChatThread` advance the sender's own read
//   watermark inline (same ordering as upstream: sender must not see their
//   own message as unread) via this card's `unread.ts`, not upstream's
//   dynamic `import('./unread')`.
import { eq } from "drizzle-orm";
import { megaMessages, type Database } from "@megaui/database";
import { buildChannelCollectionRoomName, type Channel, type ChatMessage, type Thread } from "@megaui/core";
import { MegaBadRequestError, MegaNotFoundError, MegaUnauthorizedError } from "../../errors";
import type { CollabInternalBridge } from "../collab/internal-bridge";
import type { MembersService } from "../members";
import { getChannelRow, listChannelRows, loadChannel } from "./channels";
import { createMessagesRepo, loadChatMessage } from "./messages";
import { parseReactionRows, toggleReactionRow } from "./reactions";
import type { EditChatMessageInput, ReplyToThreadInput, SendChatMessageInput } from "./types";
import { advanceMemberWatermark, projectChannelUnread } from "./unread";

export interface ChatServiceOptions {
  collabBridge?: CollabInternalBridge;
}

async function bestEffortCollectionPush(
  bridge: CollabInternalBridge | undefined,
  run: (bridge: CollabInternalBridge) => Promise<unknown>,
): Promise<void> {
  if (!bridge) return;
  try {
    await run(bridge);
  } catch {
    // Best-effort hint; the PG write already committed.
  }
}

export function createChatService(
  database: Database,
  members: MembersService,
  options?: ChatServiceOptions,
) {
  const messagesRepo = createMessagesRepo(database, members);

  /**
   * ER-05 P1 fix: upstream's `chat.ts` `listChannels(actorUserId?)` treats
   * `actorUserId === undefined` (not `null`) as a trusted-internal-caller
   * escape hatch that skips ACL filtering entirely. This is a fail-open
   * hole for a real multi-tenant ACL — `undefined`/`null`/an empty string
   * are all "no actor" and always go through `filterChannelsForActor`
   * (which itself returns `[]` for a missing actor, GC-07 fail-closed).
   * Intentional divergence from upstream: there is no internal caller here
   * that needs the unfiltered list.
   */
  async function listChannels(actorUserId?: string | null): Promise<Channel[]> {
    const rows = await listChannelRows(database);
    const channels = await Promise.all(rows.map((row) => loadChannel(database, row, actorUserId)));
    const visible = await members.filterChannelsForActor(channels, actorUserId);
    return Promise.all(visible.map((channel) => projectChannelUnread(database, channel, actorUserId)));
  }

  async function markChannelRead(
    channelId: string,
    actorUserId: string | null | undefined,
  ): Promise<Channel> {
    await members.assertCanAccessChannel(channelId, actorUserId);
    await advanceMemberWatermark(database, channelId, actorUserId);
    const row = await getChannelRow(database, channelId);
    if (!row) throw new MegaNotFoundError("Channel", channelId);
    const channel = await loadChannel(database, row, actorUserId);
    return projectChannelUnread(database, channel, actorUserId);
  }

  async function sendChatMessage(
    input: SendChatMessageInput,
    actorUserId: string | null | undefined,
  ): Promise<ChatMessage> {
    const created = await messagesRepo.sendChatMessage(input, actorUserId);
    const trimmed = actorUserId?.trim();
    if (trimmed) await advanceMemberWatermark(database, input.channelId, trimmed, created.id);
    await bestEffortCollectionPush(options?.collabBridge, (bridge) =>
      bridge.appendCollectionChild(buildChannelCollectionRoomName(input.channelId), created.id),
    );
    return created;
  }

  async function editChatMessage(
    messageId: string,
    input: EditChatMessageInput,
    actorUserId: string | null | undefined,
  ): Promise<ChatMessage> {
    const updated = await messagesRepo.editChatMessage(messageId, input, actorUserId);
    if (updated.channelId) {
      const channelId = updated.channelId;
      await bestEffortCollectionPush(options?.collabBridge, (bridge) =>
        bridge.bumpCollectionRevision(buildChannelCollectionRoomName(channelId), {
          kind: "edit",
          messageId: updated.id,
        }),
      );
    }
    return updated;
  }

  async function replyToChatThread(
    rootMessageId: string,
    input: ReplyToThreadInput,
    actorUserId: string | null | undefined,
  ): Promise<ChatMessage> {
    const created = await messagesRepo.replyToChatThread(rootMessageId, input, actorUserId);
    const trimmed = actorUserId?.trim();
    if (trimmed && created.channelId) {
      await advanceMemberWatermark(database, created.channelId, trimmed, created.id);
    }
    if (created.channelId) {
      const channelId = created.channelId;
      await bestEffortCollectionPush(options?.collabBridge, (bridge) =>
        bridge.appendCollectionChild(buildChannelCollectionRoomName(channelId), created.id),
      );
    }
    return created;
  }

  /** Card AC: reactions CRUD (with permissions + the GC-10 capacity cap, see `./limits.ts`). */
  async function toggleMessageReaction(
    messageId: string,
    emoji: string,
    actorUserId: string | null | undefined,
  ): Promise<ChatMessage> {
    const actor = actorUserId?.trim();
    if (!actor) throw new MegaUnauthorizedError("A signed-in session is required");
    if (!emoji.trim()) throw new MegaBadRequestError("Reaction emoji is required");

    const [row] = await database.select().from(megaMessages).where(eq(megaMessages.id, messageId)).limit(1);
    if (!row) throw new MegaNotFoundError("Chat message", messageId);
    await members.assertCanAccessChannel(row.channelId, actorUserId);

    await database.transaction(async (tx) => {
      const [locked] = await tx
        .select({ id: megaMessages.id, reactions: megaMessages.reactions })
        .from(megaMessages)
        .where(eq(megaMessages.id, messageId))
        .for("update")
        .limit(1);
      if (!locked) throw new MegaNotFoundError("Chat message", messageId);
      const next = toggleReactionRow(parseReactionRows(locked.reactions), emoji, actor);
      await tx
        .update(megaMessages)
        .set({ reactions: next as unknown as Array<Record<string, unknown>>, updatedAt: new Date() })
        .where(eq(megaMessages.id, messageId));
    });

    const [updated] = await database.select().from(megaMessages).where(eq(megaMessages.id, messageId)).limit(1);
    if (!updated) throw new MegaNotFoundError("Chat message", messageId);
    const loaded = await loadChatMessage(database, updated, actorUserId);
    await bestEffortCollectionPush(options?.collabBridge, (bridge) =>
      bridge.bumpCollectionRevision(buildChannelCollectionRoomName(row.channelId), {
        kind: "reaction",
        messageId: loaded.id,
      }),
    );
    return loaded;
  }

  async function listChatMessages(
    channelId: string,
    actorUserId: string | null | undefined,
  ): Promise<ChatMessage[]> {
    return messagesRepo.listChatMessages(channelId, actorUserId);
  }

  async function listChatThreads(
    channelId: string,
    actorUserId: string | null | undefined,
  ): Promise<Thread[]> {
    return messagesRepo.listChatThreads(channelId, actorUserId);
  }

  async function getChatThread(
    rootMessageId: string,
    actorUserId: string | null | undefined,
  ): Promise<Thread> {
    return messagesRepo.getChatThread(rootMessageId, actorUserId);
  }

  return {
    listChannels,
    createChannel: members.createChannel,
    openOrCreateDm: members.openOrCreateDm,
    listChannelMembers: members.listChannelMembers,
    inviteChannelMember: members.inviteChannelMember,
    removeChannelMember: members.removeChannelMember,
    leaveChannel: members.leaveChannel,
    markChannelRead,
    listChatMessages,
    sendChatMessage,
    editChatMessage,
    listChatThreads,
    getChatThread,
    replyToChatThread,
    toggleMessageReaction,
  };
}

export type ChatService = ReturnType<typeof createChatService>;
