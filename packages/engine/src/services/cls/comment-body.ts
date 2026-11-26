// megaui:libs/mega/import/plain-text.ts@0ff3a9d
//
// Diff vs upstream (registered on the EG-05 task card):
// - Scoped to CL comment (and, via `description.ts`, CL description) bodies.
//   `PendingRefPlaceholder` bookkeeping (upstream's editor-side "pending
//   ref" chips for issue/CL/thread/sha tokens) is dropped — this port only
//   needs the persisted Lexical JSON, not incremental-typing UI state.
// - `promotePlainRefsInEditorState` (re-scanning an already-Lexical payload
//   for bare `#N`/`!N`/`@user` text tokens and promoting them to `mega-ref`
//   nodes) is not ported: this card's comment composer always submits
//   plain text, never pre-built Lexical JSON with embedded plain-text refs
//   to promote. Registered omission, not silent drift — a body that
//   arrives as `{ root: ... }` is passed through unchanged (see
//   `normalizeCommentBodyJson` below).
import { generateBlockId } from "@megaui/content";
import { parseRefs, type RefToken } from "@megaui/core";

type SerializedInline =
  | {
      detail: number;
      format: number;
      mode: string;
      style: string;
      text: string;
      type: "text";
      version: number;
    }
  | {
      type: "mega-ref";
      version: number;
      ref: {
        kind: "issue" | "cl" | "user";
        targetId?: string;
        targetTitle: string;
      };
    };

function tokenToInline(token: RefToken): SerializedInline {
  if (token.kind === "plain") {
    return { detail: 0, format: 0, mode: "normal", style: "", text: token.raw, type: "text", version: 1 };
  }
  if (token.kind === "issue" || token.kind === "cl") {
    return {
      type: "mega-ref",
      version: 1,
      ref: { kind: token.kind, targetId: token.raw.slice(1), targetTitle: token.raw },
    };
  }
  if (token.kind === "user") {
    return {
      type: "mega-ref",
      version: 1,
      ref: { kind: "user", targetId: token.username, targetTitle: token.raw },
    };
  }
  // thread/sha stay as plain text until dedicated RefNode kinds land (upstream parity).
  return { detail: 0, format: 0, mode: "normal", style: "", text: token.raw, type: "text", version: 1 };
}

/**
 * Plain-text → mega block tree. Lines become text blocks; `#N`/`!publicId`/`!N`/`@user`
 * become `mega-ref` nodes.
 */
export function importPlainText(text: string): string {
  const lines = text.length === 0 ? [""] : text.replace(/\r\n/g, "\n").split("\n");

  const children = lines.map((line) => {
    const tokens = parseRefs(line);
    const inlineChildren = line ? tokens.map(tokenToInline) : [];
    return {
      children: inlineChildren,
      direction: null,
      format: "",
      indent: 0,
      type: "mega-block",
      version: 1,
      blockId: generateBlockId(),
      variant: "text",
      collapsed: false,
      todoChecked: false,
    };
  });

  return JSON.stringify({
    root: { children, direction: null, format: "", indent: 0, type: "root", version: 1 },
  });
}

/** Normalize comment body payloads (plain text or Lexical JSON) to Lexical editor-state JSON. */
export function normalizeCommentBodyJson(raw: unknown): string {
  if (raw == null) return importPlainText("");
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return importPlainText("");
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      // JSON.parse("123") / "true" / "null" succeeds but is not a Lexical
      // payload — keep the original string as plain text instead of recursing
      // into an empty document.
      if (parsed !== null && typeof parsed === "object") {
        return normalizeCommentBodyJson(parsed);
      }
      return importPlainText(trimmed);
    } catch {
      return importPlainText(trimmed);
    }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return importPlainText("");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.text === "string" && record.root === undefined) {
    return importPlainText(record.text);
  }
  if (record.root !== undefined) {
    return JSON.stringify({ root: record.root });
  }
  return importPlainText("");
}

type LexWalkNode = {
  type?: unknown;
  text?: unknown;
  children?: unknown;
  ref?: { targetTitle?: unknown };
};

/** `true` when a Lexical body has no visible text or ref content (blank comment guard). */
export function isEmptyCommentBody(bodyJson: string): boolean {
  try {
    const parsed = JSON.parse(bodyJson) as { root?: { children?: unknown[] } };
    if (!parsed.root?.children?.length) return true;
    const texts: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const record = node as LexWalkNode;
      if (record.type === "mega-ref") {
        texts.push(typeof record.ref?.targetTitle === "string" ? record.ref.targetTitle : "ref");
        return;
      }
      if (typeof record.text === "string" && record.text.trim()) texts.push(record.text);
      if (Array.isArray(record.children)) {
        for (const child of record.children) walk(child);
      }
    };
    walk(parsed.root);
    return texts.length === 0;
  } catch {
    return bodyJson.trim().length === 0;
  }
}

/** Flatten a Lexical comment body to a single plain-text projection (refs as their titles). */
export function plainTextFromCommentBody(bodyJson: string): string {
  try {
    const parsed = JSON.parse(bodyJson) as { root?: unknown };
    const parts: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const record = node as LexWalkNode;
      if (record.type === "mega-ref") {
        if (typeof record.ref?.targetTitle === "string") parts.push(record.ref.targetTitle);
        return;
      }
      if (typeof record.text === "string") parts.push(record.text);
      if (Array.isArray(record.children)) {
        for (const child of record.children) walk(child);
      }
    };
    walk(parsed.root);
    return parts.join("").trim();
  } catch {
    return bodyJson.trim();
  }
}
