// megaui:libs/react-shared/components/mega/content/nodes-core.ts@0ff3a9d
//
// megaui-only additions (GC-11, registered on the EG-03 task card): upstream
// has no server-side payload guard — Lexical's own editor enforces node
// shapes client-side, and the mock/store backend never validated bytes on
// the way in. This card's write path is a real HTTP-reachable persistence
// boundary, so it needs an explicit fail-closed guard: reject oversized
// bodies and structurally illegal block payloads before they ever reach
// `mega_content` / the blocks-and-links rebuild pipeline.
import { MegaBadRequestError } from "../../errors";
import { isBlockId } from "@megaui/core";
import { parseRoamEmbed, parseRoamImageSource } from "@megaui/content";
import { isRootBlockType } from "./body-format";

/** Serialized EditorState JSON byte ceiling for one document body (GC-11). */
export const MAX_DOC_BODY_BYTES = 500_000;

/** Doc title length ceiling — generous, but not unbounded (GC-11). */
export const MAX_DOC_TITLE_LENGTH = 500;

/** Version summary length ceiling (GC-11). */
export const MAX_DOC_SUMMARY_LENGTH = 2_000;

const MEGA_BLOCK_VARIANTS = new Set(["text", "h1", "h2", "h3", "quote", "todo"]);
const MEGA_LIST_KINDS = new Set(["bullet", "ordered"]);
const REF_KINDS = new Set(["doc", "issue", "cl", "user", "block"]);
const LEAF_BLOCK_TYPES = new Set(["mega-code-block", "mega-table-block", "mega-outline-table", "mega-hr-block"]);

type WalkNode = {
  type?: unknown;
  blockId?: unknown;
  variant?: unknown;
  listKind?: unknown;
  tableSource?: unknown;
  sourceBlockId?: unknown;
  language?: unknown;
  ref?: unknown;
  embed?: unknown;
  blockRef?: unknown;
  image?: unknown;
  text?: unknown;
  targetDocId?: unknown;
  label?: unknown;
  url?: unknown;
  children?: unknown;
};

function fail(message: string): never {
  throw new MegaBadRequestError(`Illegal document body: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEmbed(embed: unknown): void {
  if (!isPlainObject(embed)) fail("mega-embed node is missing an `embed` payload");
  const targetDocId = (embed as Record<string, unknown>).targetDocId;
  if (typeof targetDocId !== "string" || !targetDocId.trim()) {
    fail("mega-embed is missing targetDocId");
  }
  const targetBlockId = (embed as Record<string, unknown>).targetBlockId;
  if (
    targetBlockId !== undefined &&
    targetBlockId !== null &&
    targetBlockId !== "" &&
    !isBlockId(targetBlockId)
  ) {
    fail("mega-embed targetBlockId must be a 12-character URL-safe block ID");
  }
}

function validateRef(ref: unknown): void {
  if (!isPlainObject(ref)) fail("mega-ref node is missing a `ref` payload");
  const kind = (ref as Record<string, unknown>).kind;
  const targetTitle = (ref as Record<string, unknown>).targetTitle;
  const targetId = (ref as Record<string, unknown>).targetId;
  if (typeof kind !== "string" || !REF_KINDS.has(kind)) {
    fail(`mega-ref has an unknown kind: ${String(kind)}`);
  }
  // Bare `kind: "block"` cannot encode a stable `${docId}:${blockId}` link
  // target — clients must use `mega-block-ref` instead.
  if (kind === "block") {
    fail("mega-ref kind=block is not supported; use mega-block-ref");
  }
  if (typeof targetTitle !== "string" || !targetTitle.trim()) {
    fail("mega-ref is missing targetTitle");
  }
  // GC-11 P1: `targetId` marks a *resolved* ref (see `extractRefsFromEditorState`).
  // It may be omitted/empty (unresolved) or a non-empty string (resolved) —
  // any other truthy value (number/object/array/boolean) is malformed input.
  if (targetId !== undefined && targetId !== null && targetId !== "" && typeof targetId !== "string") {
    fail(`mega-ref targetId must be a string, got: ${typeof targetId}`);
  }
}

function validateBlockRef(blockRef: unknown): void {
  if (!isPlainObject(blockRef)) fail("mega-block-ref node is missing a `blockRef` payload");
  const record = blockRef as Record<string, unknown>;
  if (typeof record.targetDocId !== "string" || !record.targetDocId.trim()) {
    fail("mega-block-ref is missing targetDocId");
  }
  if (typeof record.targetBlockId !== "string" || !record.targetBlockId.trim()) {
    fail("mega-block-ref is missing targetBlockId");
  }
  if (!isBlockId(record.targetBlockId)) fail("mega-block-ref targetBlockId must be a 12-character URL-safe block ID");
  if (typeof record.label !== "string") {
    fail("mega-block-ref is missing a label");
  }
  if (record.binding !== undefined && record.binding !== "document" && record.binding !== "search") {
    fail("mega-block-ref binding must be document or search");
  }
}

function validateImage(image: unknown): void {
  if (!isPlainObject(image)) fail("mega-image node is missing an `image` payload");
  const { src, alt } = image;
  if (typeof src !== "string" || src.length > 2_048 || typeof alt !== "string" || alt.length > 500) {
    fail("mega-image requires a bounded src and alt");
  }
  try {
    const url = new URL(src);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      fail("mega-image src must be an HTTP(S) URL without credentials");
    }
  } catch {
    fail("mega-image src must be an absolute HTTP(S) URL");
  }
}

function validateExternalLink(urlValue: unknown): void {
  if (typeof urlValue !== "string" || urlValue.length > 2_048) fail("link URL must be a bounded string");
  try {
    const url = new URL(urlValue);
    if (!["http:", "https:", "mailto:"].includes(url.protocol) || url.username || url.password) {
      fail("link URL must use HTTP(S) or mailto without credentials");
    }
  } catch {
    fail("link URL must be an absolute HTTP(S) or mailto URL");
  }
}

function checkBlockIdUnique(blockId: string, seenBlockIds: Set<string>): void {
  if (!isBlockId(blockId)) fail("blockId must be a 12-character URL-safe block ID");
  if (seenBlockIds.has(blockId)) fail(`duplicate blockId: ${blockId}`);
  seenBlockIds.add(blockId);
}

function walk(node: unknown, depth: number, seenBlockIds: Set<string>, parentType: string | null): void {
  if (depth > 64) fail("block tree exceeds the maximum nesting depth");
  // GC-11 P1: a `children` entry that isn't a plain object (null/scalar/array)
  // is structurally illegal — fail closed instead of silently skipping it.
  if (!isPlainObject(node)) fail("node must be an object");
  const record = node as WalkNode;
  const nodeType = typeof record.type === "string" ? record.type : undefined;

  if (
    parentType &&
    LEAF_BLOCK_TYPES.has(parentType) &&
    nodeType &&
    (isRootBlockType(nodeType) || LEAF_BLOCK_TYPES.has(nodeType))
  ) {
    fail(`${parentType} cannot nest block containers (got ${nodeType})`);
  }

  switch (record.type) {
    case "mega-block": {
      if (typeof record.blockId !== "string" || !record.blockId.trim()) {
        fail("mega-block is missing a blockId");
      }
      checkBlockIdUnique(record.blockId, seenBlockIds);
      if (typeof record.variant !== "string" || !MEGA_BLOCK_VARIANTS.has(record.variant)) {
        fail(`mega-block has an unknown variant: ${String(record.variant)}`);
      }
      if (
        record.listKind !== undefined &&
        record.listKind !== null &&
        !MEGA_LIST_KINDS.has(record.listKind as string)
      ) {
        fail(`mega-block has an unknown listKind: ${String(record.listKind)}`);
      }
      if (record.tableSource !== undefined && typeof record.tableSource !== "boolean") {
        fail("mega-block tableSource must be a boolean");
      }
      break;
    }
    case "mega-code-block":
    case "mega-table-block":
    case "mega-hr-block": {
      if (typeof record.blockId !== "string" || !record.blockId.trim()) {
        fail(`${String(record.type)} is missing a blockId`);
      }
      checkBlockIdUnique(record.blockId, seenBlockIds);
      break;
    }
    case "mega-outline-table": {
      if (typeof record.blockId !== "string" || !record.blockId.trim()) fail("mega-outline-table is missing a blockId");
      if (typeof record.sourceBlockId !== "string" || !record.sourceBlockId.trim()) fail("mega-outline-table is missing a sourceBlockId");
      if (!isBlockId(record.sourceBlockId)) fail("mega-outline-table sourceBlockId must be a 12-character URL-safe block ID");
      checkBlockIdUnique(record.blockId, seenBlockIds);
      if (record.children !== undefined) fail("mega-outline-table cannot contain children");
      break;
    }
    case "mega-ref":
      validateRef(record.ref);
      break;
    case "mega-embed":
      if (typeof record.text === "string") {
        if (typeof record.targetDocId !== "string" || (record.label !== undefined && typeof record.label !== "string")) fail("mega-embed has invalid source metadata");
        validateEmbed(parseRoamEmbed(record.text, record.targetDocId, record.label as string | undefined));
      } else validateEmbed(record.embed);
      break;
    case "mega-block-ref":
      validateBlockRef(record.blockRef);
      break;
    case "mega-image":
      validateImage(typeof record.text === "string" ? parseRoamImageSource(record.text) : record.image);
      break;
    case "mega-roam-macro":
      if (parentType !== "mega-block" || !["{{[[TODO]]}}", "{{[[DONE]]}}", "{{[[table]]}}"].includes(String(record.text))) {
        fail("mega-roam-macro must be a supported block macro");
      }
      break;
    case "link":
    case "autolink":
      validateExternalLink(record.url);
      break;
    default:
      break;
  }

  const children = record.children;
  if (children === undefined) return;
  if (!Array.isArray(children)) fail("node `children` must be an array");
  for (const child of children) walk(child, depth + 1, seenBlockIds, nodeType ?? parentType);
}

/**
 * GC-11 fail-closed guard for the docs write path: rejects oversized bodies
 * and structurally illegal mega block/ref/embed/block-ref payloads before
 * they reach persistence or the blocks/links rebuild pipeline.
 */
export function validateDocBodyJson(bodyJson: string): void {
  const byteLength = Buffer.byteLength(bodyJson, "utf8");
  if (byteLength > MAX_DOC_BODY_BYTES) {
    fail(`body exceeds ${MAX_DOC_BODY_BYTES} bytes (got ${byteLength})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJson);
  } catch {
    fail("body is not valid JSON");
  }

  if (!isPlainObject(parsed) || !("root" in parsed)) {
    fail("body must be an object with a `root` node");
  }
  const root = (parsed as Record<string, unknown>).root;
  if (!isPlainObject(root) || (root.type !== undefined && root.type !== "root")) {
    fail("body root node is malformed");
  }

  const rootChildren = (root as WalkNode).children;
  if (!Array.isArray(rootChildren) || rootChildren.length === 0) {
    fail("body root must contain at least one mega block");
  }
  for (const child of rootChildren) {
    if (!isPlainObject(child) || !isRootBlockType(typeof child.type === "string" ? child.type : undefined)) {
      fail("body root children must be mega block containers");
    }
  }

  walk(root, 0, new Set<string>(), null);
}

export function validateDocTitle(title: string): void {
  if (!title.trim()) fail("title is required");
  if (title.length > MAX_DOC_TITLE_LENGTH) {
    fail(`title exceeds ${MAX_DOC_TITLE_LENGTH} characters`);
  }
}

export function validateDocSummary(summary: string): void {
  if (!summary.trim()) fail("version summary is required");
  if (summary.length > MAX_DOC_SUMMARY_LENGTH) {
    fail(`version summary exceeds ${MAX_DOC_SUMMARY_LENGTH} characters`);
  }
}
