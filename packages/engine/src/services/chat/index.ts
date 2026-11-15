import type { Database } from "@megaui/database";
import {
  createCollabInternalBridge,
  type CollabInternalBridge,
} from "../collab/internal-bridge";
import { createMembersService, type MembersService } from "../members";
import { createChatService, type ChatService } from "./chat";

export { createChatService, type ChatService } from "./chat";
export {
  MAX_CHAT_MESSAGE_BYTES,
  MAX_CHAT_MESSAGE_REACTIONS,
  MAX_CHAT_MESSAGE_SEGMENTS,
  MAX_CHAT_MESSAGE_TEXT_LENGTH,
  assertReactionCapacity,
  validateChatSegments,
} from "./limits";
export {
  parseReactionRows,
  projectReactions,
  toggleReactionRow,
  type ReactionRow,
} from "./reactions";
export {
  aggregateUnreadCounts,
  computeChannelUnread,
  ensureMemberRowForWatermark,
  advanceMemberWatermark,
  projectChannelUnread,
  type ChannelUnreadFields,
  type ChannelUnreadProjection,
} from "./unread";
export { loadChatMessage, listAllChannelMessagesFlat } from "./messages";
export { getPeerLastReadMessageId, loadChannel } from "./channels";
export type { ChatContentEnvelope } from "./content";
export type { EditChatMessageInput, ReplyToThreadInput, SendChatMessageInput } from "./types";

export interface ChatDomain {
  members: MembersService;
  chat: ChatService;
}

/**
 * Wires the chat-domain service against one `Database` (EG-07): reuses
 * EG-02's `createMembersService` for channel/member CRUD + access control
 * (task card instruction — not forked) and composes it with this card's
 * message/thread/reaction/closure implementation.
 */
export function createChatDomain(
  database: Database,
  options?: { collabBridge?: CollabInternalBridge },
): ChatDomain {
  const members = createMembersService(database);
  const chat = createChatService(database, members, {
    collabBridge:
      options?.collabBridge ??
      createCollabInternalBridge({ retry: { maxAttempts: 1 }, timeoutMs: 750 }),
  });
  return { members, chat };
}
