export interface TocEntry {
  index: number;
  level: 1 | 2 | 3;
  text: string;
}

type SerializedNode = {
  type?: string;
  tag?: string;
  variant?: string;
  text?: string;
  children?: SerializedNode[];
};

function nodeText(node: SerializedNode): string {
  if (node.type === "mega-roam-macro") return "";
  if (typeof node.text === "string") return node.text;
  return (node.children ?? []).map(nodeText).join("");
}

function headingLabelText(node: SerializedNode): string {
  if (typeof node.text === "string") return node.text;
  return (node.children ?? [])
    .filter(
      (child) =>
        child.type !== "mega-block" &&
        child.type !== "mega-code-block" &&
        child.type !== "mega-table-block" &&
        child.type !== "mega-outline-table" &&
        child.type !== "mega-hr-block",
    )
    .map(headingLabelText)
    .join("");
}

function headingLevel(node: SerializedNode): 1 | 2 | 3 | null {
  if (node.type === "heading") {
    return node.tag === "h1" ? 1 : node.tag === "h2" ? 2 : 3;
  }
  if (node.type === "mega-block" && (node.variant === "h1" || node.variant === "h2" || node.variant === "h3")) {
    return node.variant === "h1" ? 1 : node.variant === "h2" ? 2 : 3;
  }
  return null;
}

/** Heading TOC from Lexical / mega-block heading nodes (no Lexical import). */
export function tocFromBody(body: string): TocEntry[] {
  try {
    const state = JSON.parse(body) as { root?: SerializedNode };
    const entries: TocEntry[] = [];
    let order = 0;
    const walk = (nodes: SerializedNode[]) => {
      for (const child of nodes) {
        const level = headingLevel(child);
        if (level) {
          entries.push({ index: order, level, text: headingLabelText(child).trim() });
          order += 1;
        }
        if (child.children?.length) walk(child.children);
      }
    };
    walk(state.root?.children ?? []);
    return entries.filter((entry) => entry.text.length > 0);
  } catch {
    return [];
  }
}

export function bodyPlainText(body: string): string {
  try {
    const state = JSON.parse(body) as { root?: SerializedNode };
    return nodeText(state.root ?? {}).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

/** A media node or empty TODO is visible even when it contributes no plain text. */
export function bodyHasVisibleContent(body: string): boolean {
  try {
    const state = JSON.parse(body) as { root?: SerializedNode };
    const visible = (node: SerializedNode): boolean => {
      if (typeof node.text === "string" && node.text.trim().length > 0) return true;
      if (["mega-image", "mega-embed", "mega-table-block", "mega-outline-table", "mega-hr-block"].includes(node.type ?? "")) return true;
      if (node.type === "mega-block" && node.variant === "todo") return true;
      return (node.children ?? []).some(visible);
    };
    return visible(state.root ?? {});
  } catch {
    return false;
  }
}

/** ~400 CJK chars / minute over the serialized text content. */
export function readingMinutes(body: string): number {
  try {
    const state = JSON.parse(body) as { root?: SerializedNode };
    const chars = nodeText(state.root ?? {}).length;
    return Math.max(1, Math.round(chars / 400));
  } catch {
    return 1;
  }
}
