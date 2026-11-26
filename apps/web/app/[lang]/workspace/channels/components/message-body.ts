import type { ChatMessage, ChatSegment } from "@megaui/core";

function segmentText(segment: ChatSegment): string {
  switch (segment.type) {
    case "text":
    case "code":
    case "link":
      return segment.text;
    case "cl-ref":
      return `!${"publicId" in segment ? segment.publicId : segment.number}`;
    case "issue-ref":
      return `#${segment.number}`;
    case "user-ref":
      return `@${segment.username}`;
    case "file-ref":
      return segment.line !== undefined ? `${segment.path}:${segment.line}` : segment.path;
    default:
      return "";
  }
}

/** Flatten message segments (or legacy body) to plain text for lean chat rows. */
export function messagePlainText(message: Pick<ChatMessage, "body" | "segments">): string {
  if (message.segments.length > 0) {
    return message.segments.map(segmentText).join("");
  }
  return message.body ?? "";
}
