// megaui:libs/mega/services/chat.ts@0ff3a9d
//
// megaui-only additions (GC-10, registered on the EG-07 task card): upstream
// `libs/mega/services/chat.ts` has no server-side input ceiling — the mock
// store and a single-process Lexical editor never needed one. A real
// multi-actor HTTP-reachable persistence boundary does: an unbounded
// message payload or an unbounded reaction fan-out is exactly the
// "unbounded memory" case GC-10's performance budget prohibits. This
// module is the card AC's fail-closed input gate ("长消息/超量 reactions
// 边界").
import type { ChatSegment } from "@megaui/core";
import { MegaBadRequestError } from "../../errors";

/** Max number of segments in one message/reply (GC-10). */
export const MAX_CHAT_MESSAGE_SEGMENTS = 200;

/** Max combined plain-text length across all text/code/link/ref segments (GC-10). */
export const MAX_CHAT_MESSAGE_TEXT_LENGTH = 4_000;

/** Serialized segment-array byte ceiling — catches pathological non-text segments (GC-10). */
export const MAX_CHAT_MESSAGE_BYTES = 20_000;

/** Max distinct emoji reaction entries per message (GC-10). */
export const MAX_CHAT_MESSAGE_REACTIONS = 50;

/**
 * Max length (UTF-16 code units) of one reaction's `emoji` string (ER-05
 * P1). `assertReactionCapacity` had a ceiling on the *count* of distinct
 * reactions but none on the length of an individual `emoji` string — an
 * unbounded string here is the same "unbounded memory" GC-10 class of bug
 * as an unbounded message, just smuggled through a field that looks like
 * it should always be one grapheme.
 */
export const MAX_CHAT_MESSAGE_REACTION_EMOJI_LENGTH = 64;

function segmentTextLength(segment: ChatSegment): number {
  switch (segment.type) {
    case "text":
    case "code":
      return segment.text.length;
    case "link":
      return segment.text.length;
    case "file-ref":
      return segment.path.length;
    case "user-ref":
      return segment.username.length;
    case "cl-ref":
    case "issue-ref":
      return 0;
    default:
      return 0;
  }
}

/**
 * Card AC "长消息边界" (GC-10): rejects empty input, oversized segment
 * arrays, oversized combined text, and oversized serialized payloads
 * before anything reaches `mega_content`.
 */
export function validateChatSegments(segments: readonly ChatSegment[]): void {
  if (segments.length === 0) {
    throw new MegaBadRequestError("Message segments are required");
  }
  if (segments.length > MAX_CHAT_MESSAGE_SEGMENTS) {
    throw new MegaBadRequestError(
      `Message exceeds ${MAX_CHAT_MESSAGE_SEGMENTS} segments (got ${segments.length})`,
    );
  }
  const textLength = segments.reduce((total, segment) => total + segmentTextLength(segment), 0);
  if (textLength > MAX_CHAT_MESSAGE_TEXT_LENGTH) {
    throw new MegaBadRequestError(
      `Message exceeds ${MAX_CHAT_MESSAGE_TEXT_LENGTH} characters (got ${textLength})`,
    );
  }
  const byteLength = Buffer.byteLength(JSON.stringify(segments), "utf8");
  if (byteLength > MAX_CHAT_MESSAGE_BYTES) {
    throw new MegaBadRequestError(
      `Message payload exceeds ${MAX_CHAT_MESSAGE_BYTES} bytes (got ${byteLength})`,
    );
  }
}

/**
 * Card AC "超量 reactions 边界" (GC-10): a brand-new distinct emoji cannot
 * be added once a message already holds the cap. Toggling an
 * already-present emoji (including removing the actor's own reaction)
 * never fails on capacity — only growth of the distinct-emoji set is
 * bounded. Also rejects an oversize `emoji` string (ER-05 P1) regardless of
 * whether it is already present, so an over-length reaction can never even
 * be toggled off through this gate — the write path validates the same
 * string on every call before it can reach `mega_messages.reactions`.
 */
export function assertReactionCapacity(existingEmoji: readonly string[], emoji: string): void {
  if (emoji.length > MAX_CHAT_MESSAGE_REACTION_EMOJI_LENGTH) {
    throw new MegaBadRequestError(
      `Reaction emoji exceeds ${MAX_CHAT_MESSAGE_REACTION_EMOJI_LENGTH} characters (got ${emoji.length})`,
    );
  }
  if (existingEmoji.includes(emoji)) return;
  if (existingEmoji.length >= MAX_CHAT_MESSAGE_REACTIONS) {
    throw new MegaBadRequestError(
      `Message already has ${MAX_CHAT_MESSAGE_REACTIONS} distinct reactions`,
    );
  }
}
