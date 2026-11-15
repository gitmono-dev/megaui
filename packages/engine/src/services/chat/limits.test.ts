import { describe, expect, it } from "vitest";
import type { ChatSegment } from "@megaui/core";
import { MegaBadRequestError } from "../../errors";
import {
  MAX_CHAT_MESSAGE_BYTES,
  MAX_CHAT_MESSAGE_REACTIONS,
  MAX_CHAT_MESSAGE_REACTION_EMOJI_LENGTH,
  MAX_CHAT_MESSAGE_SEGMENTS,
  MAX_CHAT_MESSAGE_TEXT_LENGTH,
  assertReactionCapacity,
  validateChatSegments,
} from "./limits";

describe("validateChatSegments (EG-07, GC-10 长消息边界, pure)", () => {
  it("rejects an empty segments array", () => {
    expect(() => validateChatSegments([])).toThrow(MegaBadRequestError);
  });

  it("accepts a single short text segment", () => {
    expect(() => validateChatSegments([{ type: "text", text: "hello" }])).not.toThrow();
  });

  it("rejects more than MAX_CHAT_MESSAGE_SEGMENTS entries", () => {
    const segments: ChatSegment[] = Array.from({ length: MAX_CHAT_MESSAGE_SEGMENTS + 1 }, () => ({
      type: "text",
      text: "x",
    }));
    expect(() => validateChatSegments(segments)).toThrow(MegaBadRequestError);
  });

  it("accepts exactly MAX_CHAT_MESSAGE_SEGMENTS entries", () => {
    const segments: ChatSegment[] = Array.from({ length: MAX_CHAT_MESSAGE_SEGMENTS }, () => ({
      type: "text",
      text: "x",
    }));
    expect(() => validateChatSegments(segments)).not.toThrow();
  });

  it("rejects combined text length over MAX_CHAT_MESSAGE_TEXT_LENGTH (long message)", () => {
    const segments: ChatSegment[] = [{ type: "text", text: "x".repeat(MAX_CHAT_MESSAGE_TEXT_LENGTH + 1) }];
    expect(() => validateChatSegments(segments)).toThrow(MegaBadRequestError);
  });

  it("accepts exactly MAX_CHAT_MESSAGE_TEXT_LENGTH characters", () => {
    const segments: ChatSegment[] = [{ type: "text", text: "x".repeat(MAX_CHAT_MESSAGE_TEXT_LENGTH) }];
    expect(() => validateChatSegments(segments)).not.toThrow();
  });

  it("ignores cl-ref/issue-ref segments toward the text-length ceiling", () => {
    const segments: ChatSegment[] = [
      { type: "text", text: "See " },
      { type: "cl-ref", number: 999999 },
      { type: "issue-ref", number: 999999 },
    ];
    expect(() => validateChatSegments(segments)).not.toThrow();
  });

  it("rejects a serialized payload over MAX_CHAT_MESSAGE_BYTES even when text length is small (link url is not counted as text)", () => {
    // 60 link segments * ~600-byte url each ≈ 36KB JSON, but `text` per segment
    // is tiny — this must trip the byte ceiling, not the text-length one.
    const segments: ChatSegment[] = Array.from({ length: 60 }, (_, index) => ({
      type: "link" as const,
      url: `https://example.test/${"a".repeat(600)}/${index}`,
      text: "link",
    }));
    const byteLength = Buffer.byteLength(JSON.stringify(segments), "utf8");
    expect(byteLength).toBeGreaterThan(MAX_CHAT_MESSAGE_BYTES);
    expect(segments.length).toBeLessThanOrEqual(MAX_CHAT_MESSAGE_SEGMENTS);
    expect(() => validateChatSegments(segments)).toThrow(MegaBadRequestError);
  });
});

describe("assertReactionCapacity (EG-07, GC-10 超量 reactions 边界, pure)", () => {
  it("allows adding a distinct emoji under the cap", () => {
    expect(() => assertReactionCapacity([], "👍")).not.toThrow();
    expect(() => assertReactionCapacity(["👍"], "🎉")).not.toThrow();
  });

  it("allows re-toggling an emoji that is already present, even at the cap", () => {
    const atCap = Array.from({ length: MAX_CHAT_MESSAGE_REACTIONS }, (_, index) => `emoji-${index}`);
    expect(() => assertReactionCapacity(atCap, "emoji-0")).not.toThrow();
  });

  it("rejects a brand-new distinct emoji once the cap is reached", () => {
    const atCap = Array.from({ length: MAX_CHAT_MESSAGE_REACTIONS }, (_, index) => `emoji-${index}`);
    expect(() => assertReactionCapacity(atCap, "one-too-many")).toThrow(MegaBadRequestError);
  });

  it("ER-05 P1: rejects an emoji string longer than MAX_CHAT_MESSAGE_REACTION_EMOJI_LENGTH", () => {
    const oversize = "x".repeat(MAX_CHAT_MESSAGE_REACTION_EMOJI_LENGTH + 1);
    expect(() => assertReactionCapacity([], oversize)).toThrow(MegaBadRequestError);
  });

  it("accepts an emoji exactly at MAX_CHAT_MESSAGE_REACTION_EMOJI_LENGTH", () => {
    const atLimit = "x".repeat(MAX_CHAT_MESSAGE_REACTION_EMOJI_LENGTH);
    expect(() => assertReactionCapacity([], atLimit)).not.toThrow();
  });
});
