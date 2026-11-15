function segmentPlain(segment: { type: string; text?: string; number?: number; username?: string; path?: string }): string {
  switch (segment.type) {
    case "text":
    case "code":
    case "link":
      return segment.text ?? "";
    case "cl-ref":
      return `!${segment.number ?? ""}`;
    case "issue-ref":
      return `#${segment.number ?? ""}`;
    case "user-ref":
      return `@${segment.username ?? ""}`;
    case "file-ref":
      return segment.path ?? "";
    default:
      return "";
  }
}

export function agentMessagePlainText(message: {
  body?: string;
  segments: readonly { type: string; text?: string; number?: number; username?: string; path?: string }[];
}): string {
  if (message.segments.length > 0) {
    return message.segments.map(segmentPlain).join("");
  }
  return message.body ?? "";
}
