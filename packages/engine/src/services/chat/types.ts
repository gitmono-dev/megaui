// megaui:libs/mega/services/types.ts@0ff3a9d (chat-shaped input/output slice)
//
// Diff vs upstream (GC-03, registered on the EG-07 task card):
// - No Lexical body: `libs/mega/import/chat-segments.ts` (normalizeChatBody
//   / editor-state import/export) is not ported — out of the declared
//   Reference source (`chat.ts` + `repos/chat-repo.ts` only). Messages
//   persist `segments: ChatSegment[]` only, matching the EG-01 seed's
//   chat-segment envelope; `ChatMessage.body` is always left `undefined`.
// - `SendChatMessageInput` / `EditChatMessageInput` / `ReplyToThreadInput`
//   take a required, non-empty `segments` array instead of upstream's
//   optional `body?: string`.
import type { ChatSegment } from "@megaui/core";

export interface SendChatMessageInput {
  channelId: string;
  segments: readonly ChatSegment[];
}

export interface EditChatMessageInput {
  segments: readonly ChatSegment[];
}

export interface ReplyToThreadInput {
  segments: readonly ChatSegment[];
}
