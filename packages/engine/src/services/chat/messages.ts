// megaui:libs/mega/services/chat.ts@0ff3a9d (message/thread CRUD slice)
// megaui:libs/mega/services/repos/chat-repo.ts@0ff3a9d (message/thread CRUD slice)
//
// Diff vs upstream (GC-03, registered on the EG-07 task card):
// - No Lexical body (see `./types.ts` diff header) — segments only.
// - No collab-bridge federation notify / content-link-graph / blocks
//   rebuild hooks (`afterChatMessageWrite`, `notifyChannelCollectionAppend`)
//   — real-time push is explicitly out of this card's scope.
// - No notification fanout (`fanoutAfterChatWrite`) — EG-09, registered
//   out-of-scope on the task card.
// - Every mutation requires an explicit, non-optional-in-effect
//   `actorUserId` and gates through `MembersService.assertCanAccessChannel`
//   (fail-closed) — upstream's `actorUserId?: string | null` parameter
//   skips the permission check entirely when omitted.
// - GC-10 input caps (`validateChatSegments`, see `./limits.ts`) run before
//   every write — upstream has no such ceiling.
// - Thread model collapse (megaui-only): upstream's `Thread.id` is a
//   separate synthetic id from `Thread.rootMessageId`, and upstream has no
//   thread-creation endpoint at all — `replyToChatThread` 404s unless a
//   `Thread` row was already pre-seeded (see `chat.ts` mock / fixtures,
//   which ship a fully-formed `CHAT_THREADS` array). Megaui sets
//   `Thread.id === Thread.rootMessageId`: the first reply to any message
//   implicitly starts its thread, so `getChatThread` / `listChatThreads` /
//   `replyToChatThread` all key off the root message id and no separate
//   thread-creation step is needed.
// - Thread lookup uses a single `mega_content` JSONB query
//   (`bodyJson ->> 'threadId'`) instead of upstream's full
//   `mega_messages` table scan + one `readContentBody` per row
//   (`threadRows` in `chat-repo.ts`) — a GC-10 improvement, not a
//   functional difference.
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { megaContent, megaContentContainerTypes, megaMessages, type Database } from "@megaui/database";
import type { ChatMessage, Thread } from "@megaui/core";
import { MegaForbiddenError, MegaNotFoundError } from "../../errors";
import type { MembersService } from "../members";
import { readChatContent, writeChatContent } from "./content";
import { validateChatSegments } from "./limits";
import { parseReactionRows, projectReactions } from "./reactions";
import type { EditChatMessageInput, ReplyToThreadInput, SendChatMessageInput } from "./types";
import { resolveUser } from "./users";

type MessageRow = typeof megaMessages.$inferSelect;

function newMessageId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export async function loadChatMessage(
  database: Database,
  row: MessageRow,
  actorUserId: string | null | undefined,
): Promise<ChatMessage> {
  const envelope = await readChatContent(database, row.id);
  const author = await resolveUser(database, row.authorId);
  return {
    id: row.id,
    channelId: row.channelId,
    threadId: envelope.threadId,
    author,
    segments: envelope.segments,
    reactions: projectReactions(parseReactionRows(row.reactions), actorUserId),
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : undefined,
  };
}

/** Every row for a channel, top-level and thread replies alike (unread-math needs both). */
export async function listAllChannelMessagesFlat(
  database: Database,
  channelId: string,
): Promise<ChatMessage[]> {
  const rows = await database
    .select()
    .from(megaMessages)
    .where(eq(megaMessages.channelId, channelId));
  return Promise.all(rows.map((row) => loadChatMessage(database, row, undefined)));
}

async function findThreadMessageIds(database: Database, rootMessageId: string): Promise<string[]> {
  const rows = await database
    .select({ containerId: megaContent.containerId })
    .from(megaContent)
    .where(
      and(
        eq(megaContent.containerType, megaContentContainerTypes.CHAT_MESSAGE),
        sql`${megaContent.bodyJson} ->> 'threadId' = ${rootMessageId}`,
      ),
    );
  return rows.map((row) => row.containerId);
}

interface ThreadContext {
  channelId: string;
  replyIds: string[];
  participantIds: string[];
}

async function loadThreadContext(
  database: Database,
  rootMessageId: string,
): Promise<ThreadContext | undefined> {
  const [rootRow] = await database
    .select()
    .from(megaMessages)
    .where(eq(megaMessages.id, rootMessageId))
    .limit(1);
  if (!rootRow) return undefined;

  const replyIds = await findThreadMessageIds(database, rootMessageId);
  const replyRows = replyIds.length
    ? await database
        .select()
        .from(megaMessages)
        .where(inArray(megaMessages.id, replyIds))
        .orderBy(asc(megaMessages.createdAt))
    : [];
  const envelopes = await Promise.all(replyRows.map((row) => readChatContent(database, row.id)));

  const participantIds = new Set<string>([rootRow.authorId]);
  replyRows.forEach((row, index) => {
    participantIds.add(row.authorId);
    for (const id of envelopes[index]?.participantIds ?? []) participantIds.add(id);
  });

  return {
    channelId: rootRow.channelId,
    replyIds: replyRows.map((row) => row.id),
    participantIds: [...participantIds],
  };
}

export function createMessagesRepo(database: Database, members: MembersService) {
  async function listChatMessages(
    channelId: string,
    actorUserId: string | null | undefined,
  ): Promise<ChatMessage[]> {
    await members.assertCanAccessChannel(channelId, actorUserId);
    const rows = await database
      .select()
      .from(megaMessages)
      .where(eq(megaMessages.channelId, channelId))
      .orderBy(asc(megaMessages.createdAt));
    const messages = await Promise.all(rows.map((row) => loadChatMessage(database, row, actorUserId)));
    return messages.filter((message) => !message.threadId);
  }

  async function sendChatMessage(
    input: SendChatMessageInput,
    actorUserId: string | null | undefined,
  ): Promise<ChatMessage> {
    await members.assertCanAccessChannel(input.channelId, actorUserId);
    validateChatSegments(input.segments);
    const authorId = actorUserId!.trim();

    const id = newMessageId("message");
    const now = new Date();
    await database.transaction(async (tx) => {
      await tx.insert(megaMessages).values({
        id,
        channelId: input.channelId,
        authorId,
        reactions: [],
        createdAt: now,
        updatedAt: now,
      });
      await writeChatContent(tx, id, { segments: [...input.segments] }, now);
    });

    const [row] = await database.select().from(megaMessages).where(eq(megaMessages.id, id)).limit(1);
    if (!row) throw new MegaNotFoundError("Chat message", id);
    return loadChatMessage(database, row, actorUserId);
  }

  async function editChatMessage(
    messageId: string,
    input: EditChatMessageInput,
    actorUserId: string | null | undefined,
  ): Promise<ChatMessage> {
    const [row] = await database.select().from(megaMessages).where(eq(megaMessages.id, messageId)).limit(1);
    if (!row) throw new MegaNotFoundError("Chat message", messageId);
    await members.assertCanAccessChannel(row.channelId, actorUserId);
    const editorId = actorUserId!.trim();
    if (row.authorId !== editorId) {
      throw new MegaForbiddenError("Only the message author can edit this message");
    }
    validateChatSegments(input.segments);

    const existing = await readChatContent(database, messageId);
    const now = new Date();
    await database.transaction(async (tx) => {
      await writeChatContent(tx, messageId, { ...existing, segments: [...input.segments] }, now);
      await tx
        .update(megaMessages)
        .set({ editedAt: now, updatedAt: now })
        .where(eq(megaMessages.id, messageId));
    });

    const [updated] = await database.select().from(megaMessages).where(eq(megaMessages.id, messageId)).limit(1);
    if (!updated) throw new MegaNotFoundError("Chat message", messageId);
    return loadChatMessage(database, updated, actorUserId);
  }

  async function getChatThread(
    rootMessageId: string,
    actorUserId: string | null | undefined,
  ): Promise<Thread> {
    const context = await loadThreadContext(database, rootMessageId);
    if (!context) throw new MegaNotFoundError("Chat thread", rootMessageId);
    await members.assertCanAccessChannel(context.channelId, actorUserId);
    if (context.replyIds.length === 0) throw new MegaNotFoundError("Chat thread", rootMessageId);

    const replyRows = await database
      .select()
      .from(megaMessages)
      .where(inArray(megaMessages.id, context.replyIds))
      .orderBy(asc(megaMessages.createdAt));
    const messages = await Promise.all(replyRows.map((row) => loadChatMessage(database, row, actorUserId)));

    return {
      id: rootMessageId,
      rootMessageId,
      channelId: context.channelId,
      messages,
      participantIds: context.participantIds,
    };
  }

  async function listChatThreads(
    channelId: string,
    actorUserId: string | null | undefined,
  ): Promise<Thread[]> {
    await members.assertCanAccessChannel(channelId, actorUserId);
    const rows = await database
      .select({ rootMessageId: sql<string>`${megaContent.bodyJson} ->> 'rootMessageId'` })
      .from(megaContent)
      .innerJoin(megaMessages, eq(megaMessages.id, megaContent.containerId))
      .where(
        and(
          eq(megaContent.containerType, megaContentContainerTypes.CHAT_MESSAGE),
          eq(megaMessages.channelId, channelId),
          sql`${megaContent.bodyJson} ->> 'rootMessageId' IS NOT NULL`,
        ),
      );
    const rootIds = [...new Set(rows.map((row) => row.rootMessageId).filter((id): id is string => Boolean(id)))];
    return Promise.all(rootIds.map((rootId) => getChatThread(rootId, actorUserId)));
  }

  async function replyToChatThread(
    rootMessageId: string,
    input: ReplyToThreadInput,
    actorUserId: string | null | undefined,
  ): Promise<ChatMessage> {
    const context = await loadThreadContext(database, rootMessageId);
    if (!context) throw new MegaNotFoundError("Chat message", rootMessageId);
    await members.assertCanAccessChannel(context.channelId, actorUserId);
    validateChatSegments(input.segments);
    const authorId = actorUserId!.trim();

    const participantIds = context.participantIds.includes(authorId)
      ? context.participantIds
      : [...context.participantIds, authorId];
    const now = new Date();
    const id = newMessageId("thread_message");
    await database.transaction(async (tx) => {
      await tx.insert(megaMessages).values({
        id,
        channelId: context.channelId,
        authorId,
        reactions: [],
        createdAt: now,
        updatedAt: now,
      });
      await writeChatContent(
        tx,
        id,
        { segments: [...input.segments], threadId: rootMessageId, rootMessageId, participantIds },
        now,
      );
    });

    const [row] = await database.select().from(megaMessages).where(eq(megaMessages.id, id)).limit(1);
    if (!row) throw new MegaNotFoundError("Chat message", id);
    return loadChatMessage(database, row, actorUserId);
  }

  return {
    listChatMessages,
    sendChatMessage,
    editChatMessage,
    listChatThreads,
    getChatThread,
    replyToChatThread,
  };
}

export type MessagesRepo = ReturnType<typeof createMessagesRepo>;
