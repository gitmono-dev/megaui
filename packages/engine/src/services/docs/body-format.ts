// megaui:libs/mega/import/migrate-legacy.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-03 task card):
// - Full Lexical `buildMegaEditorStateJSON` / `appendTextBlock` legacy
//   paragraph→block migration is not ported (depends on the editor-state
//   import pipeline, which is outside this card's write set). Empty and
//   already-block-tree bodies are normalized here; non-empty legacy flat
//   trees collapse to a single text mega-block preserving plain text so
//   load never returns an unrenderable shape.
import { createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import { MegaBadRequestError } from "../../errors";

/** Legacy flat Lexical docs body (paragraph/heading/list). */
export const BODY_FORMAT_VERSION_LEGACY = 1;
/** Mega block-tree EditorState (CE-30+). */
export const BODY_FORMAT_VERSION_BLOCK_TREE = 2;

const ROOT_BLOCK_TYPES = new Set([
  "mega-block",
  "mega-code-block",
  "mega-table-block",
  "mega-outline-table",
  "mega-hr-block",
]);

export type NormalizeDocBodyResult = {
  editorStateJSON: string;
  bodyFormatVersion: number;
  migrated: boolean;
};

type WalkNode = {
  type?: string;
  text?: string;
  children?: WalkNode[];
};

function isBlockTreeState(rootChildren: WalkNode[]): boolean {
  return rootChildren.some((child) => typeof child.type === "string" && ROOT_BLOCK_TYPES.has(child.type));
}

function collectPlainText(node: WalkNode): string {
  if (typeof node.text === "string") return node.text;
  return (node.children ?? []).map(collectPlainText).join("");
}

function wrapPlainTextAsBlockTree(plain: string): string {
  const empty = JSON.parse(createEmptyMegaDocumentEditorStateJSON()) as {
    root: { children: Array<Record<string, unknown>> };
  };
  const block = empty.root.children[0];
  if (plain.trim() && block) {
    block.children = [
      {
        type: "text",
        text: plain,
        detail: 0,
        format: 0,
        mode: "normal",
        style: "",
        version: 1,
      },
    ];
  }
  return JSON.stringify(empty);
}

/**
 * Ensures a stored doc body is a CE-30 block-tree EditorState before the
 * editor (or index rebuild) sees it. Idempotent for already-migrated trees.
 */
export function normalizeDocBodyJson(editorStateJSON: string): NormalizeDocBodyResult {
  let parsed: { root?: WalkNode };
  try {
    parsed = JSON.parse(editorStateJSON) as { root?: WalkNode };
  } catch {
    return {
      editorStateJSON: createEmptyMegaDocumentEditorStateJSON(),
      bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
      migrated: true,
    };
  }

  const children = parsed.root?.children ?? [];
  if (children.length === 0) {
    return {
      editorStateJSON: createEmptyMegaDocumentEditorStateJSON(),
      bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
      migrated: true,
    };
  }

  if (isBlockTreeState(children)) {
    return {
      editorStateJSON,
      bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
      migrated: false,
    };
  }

  // Decorators/refs at the root are illegal block-tree shapes — leave them
  // untouched so `validateDocBodyJson` can reject them instead of silently
  // collapsing the payload into a plain-text mega-block.
  if (
    children.some(
      (child) =>
        child.type === "mega-embed" ||
        child.type === "mega-ref" ||
        child.type === "mega-block-ref" ||
        (typeof child.type === "string" && child.type.startsWith("mega-")),
    )
  ) {
    return {
      editorStateJSON,
      bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
      migrated: false,
    };
  }

  const plain = children.map(collectPlainText).join("\n").replace(/\s+/g, " ").trim();
  return {
    editorStateJSON: wrapPlainTextAsBlockTree(plain),
    bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
    migrated: true,
  };
}

export function isRootBlockType(type: string | undefined): boolean {
  return typeof type === "string" && ROOT_BLOCK_TYPES.has(type);
}

/**
 * Write-path body prep: fail-closed on unparseable/oversized/malformed
 * envelopes, upgrade empty roots to a real empty mega-block, collapse legacy
 * flat trees, then leave structural GC-11 checks to `validateDocBodyJson`.
 */
export function prepareWritableDocBody(bodyJson: string): string {
  const byteLength = Buffer.byteLength(bodyJson, "utf8");
  if (byteLength > 500_000) {
    throw new MegaBadRequestError(`Illegal document body: body exceeds 500000 bytes (got ${byteLength})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJson);
  } catch {
    throw new MegaBadRequestError("Illegal document body: body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("root" in parsed)) {
    throw new MegaBadRequestError("Illegal document body: body must be an object with a `root` node");
  }
  const root = (parsed as { root: unknown }).root;
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new MegaBadRequestError("Illegal document body: body root node is malformed");
  }
  const rootRecord = root as WalkNode & { type?: unknown };
  if (rootRecord.type !== undefined && rootRecord.type !== "root") {
    throw new MegaBadRequestError("Illegal document body: body root node is malformed");
  }
  const children = rootRecord.children;
  if (children === undefined || children === null) {
    return createEmptyMegaDocumentEditorStateJSON();
  }
  if (!Array.isArray(children)) {
    throw new MegaBadRequestError("Illegal document body: node `children` must be an array");
  }
  if (children.length === 0) {
    return createEmptyMegaDocumentEditorStateJSON();
  }
  for (const child of children) {
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      throw new MegaBadRequestError("Illegal document body: node must be an object");
    }
  }
  if (isBlockTreeState(children as WalkNode[])) {
    return bodyJson;
  }
  if (
    (children as WalkNode[]).some(
      (child) =>
        child.type === "mega-embed" ||
        child.type === "mega-ref" ||
        child.type === "mega-block-ref" ||
        (typeof child.type === "string" && child.type.startsWith("mega-")),
    )
  ) {
    return bodyJson;
  }
  return normalizeDocBodyJson(bodyJson).editorStateJSON;
}

