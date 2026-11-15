// megaui:libs/mega/services/monoengine/readme-markdown.ts@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-08): lives under DIR-03 adapter (page/BFF
// composition), not inside EG-11 code-backend. Typed for noUncheckedIndexedAccess.

import type { ProseBlock, ProseListItem } from "@megaui/core";

function parseListItem(line: string): ProseListItem {
  const match = line.match(/^[-*]\s+(.+?)(?:\s+—\s+(.+))?$/);
  if (!match?.[1]) {
    return { text: line.replace(/^[-*]\s+/, "") };
  }
  return match[2] ? { text: match[1], detail: match[2] } : { text: match[1] };
}

export function markdownToProseBlocks(content: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading?.[1] && heading[2]) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim() || "plaintext";
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ type: "code", language, text: codeLines.join("\n") });
      continue;
    }

    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("> ")) {
        quoteLines.push((lines[index] ?? "").slice(2));
        index += 1;
      }
      blocks.push({ type: "quote", text: quoteLines.join("\n") });
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: ProseListItem[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index] ?? "")) {
        items.push(parseListItem(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !(lines[index] ?? "").startsWith("#") &&
      !(lines[index] ?? "").startsWith("```") &&
      !(lines[index] ?? "").startsWith("> ") &&
      !/^[-*]\s+/.test(lines[index] ?? "")
    ) {
      paragraphLines.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join("\n") });
  }

  return blocks;
}
