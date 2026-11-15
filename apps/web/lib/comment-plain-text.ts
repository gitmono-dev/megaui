// megaui-only (WA-09): client-safe projection of Lexical comment bodies.
// Mirrors `@megaui/engine` `plainTextFromCommentBody` without importing the
// engine graph into client bundles (Next.js module boundary).

type LexWalkNode = {
  type?: unknown;
  text?: unknown;
  children?: unknown;
  ref?: { targetTitle?: unknown };
};

/** Flatten Lexical editor-state JSON (or raw plain text) to visible text. */
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
