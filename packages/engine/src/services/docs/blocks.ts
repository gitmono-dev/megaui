// megaui:libs/mega/services/blocks.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-03 task card):
// - No `MEGA_DOCS_DATA_BACKEND=mock` branch / blocks-mock store (DEBT-04).
// - No FTS sync (`search-fts.ts` / `syncBlocksFtsForSource`) — the PG-FTS
//   search surface is EG-10 (ADR-FS-01), not this card.
// - No `filterBlockSearchByAcl` / `searchBlocks` — block search is EG-10;
//   this card only rebuilds/lists the flattened block index for backlinks
//   and embed-subtree resolution.
// - Single PG dialect (ADR-ARCH-02): no sqlite/d1 transaction branch.
// - Explicit `Database` injection; no process-wide repo singleton / test seam.
import { and, eq } from "drizzle-orm";
import {
  megaContentBlocks,
  megaContentBlockVariants,
  megaContentContainerTypes,
  type Database,
  type MegaContentBlockVariant,
} from "@megaui/database";

const TEXT_SUMMARY_MAX = 120;

export type ExtractedContentBlock = {
  blockId: string;
  parentBlockId: string | null;
  depth: number;
  variant: MegaContentBlockVariant;
  textSummary: string;
  /** Ancestor summaries (outer → inner) for search path display. */
  pathParts: string[];
};

type LexicalWalkNode = {
  type?: string;
  text?: string;
  blockId?: string;
  variant?: string;
  listKind?: string;
  children?: LexicalWalkNode[];
};

function collectPlainText(node: LexicalWalkNode): string {
  if (typeof node.text === "string") return node.text;
  return (node.children ?? []).map(collectPlainText).join("");
}

function truncateSummary(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TEXT_SUMMARY_MAX);
}

function mapVariant(node: LexicalWalkNode): MegaContentBlockVariant {
  if (node.type === "mega-code-block") return megaContentBlockVariants.CODE;
  if (node.children?.some(child => child.type === "mega-roam-macro" && /^\{\{\[\[(?:TODO|DONE)\]\]\}\}$/.test(child.text ?? ""))) return megaContentBlockVariants.TODO;
  if (node.listKind === "bullet") return megaContentBlockVariants.BULLET;
  if (node.listKind === "ordered") return megaContentBlockVariants.NUMBERED;
  switch (node.variant) {
    case "h1":
    case "h2":
    case "h3":
      return megaContentBlockVariants.HEADING;
    case "quote":
      return megaContentBlockVariants.QUOTE;
    case "todo":
      return megaContentBlockVariants.TODO;
    case "text":
      return megaContentBlockVariants.PARAGRAPH;
    default:
      return megaContentBlockVariants.PARAGRAPH;
  }
}

function isIndexableContainer(node: LexicalWalkNode): boolean {
  return Boolean(
    node.blockId &&
      (node.type === "mega-block" ||
        node.type === "mega-code-block" ||
        node.type === "mega-table-block" ||
        node.type === "mega-outline-table" ||
        node.type === "mega-hr-block"),
  );
}

/**
 * Headless walk of Lexical EditorState JSON collecting all nested mega-blocks
 * (depth ≥ 0) including leaf code/table/hr containers.
 */
export function extractBlocksFromEditorState(editorStateJSON: string): ExtractedContentBlock[] {
  let root: LexicalWalkNode;
  try {
    const parsed = JSON.parse(editorStateJSON) as { root?: LexicalWalkNode };
    root = parsed.root ?? {};
  } catch {
    return [];
  }

  const out: ExtractedContentBlock[] = [];

  const walk = (
    node: LexicalWalkNode,
    depth: number,
    parentBlockId: string | null,
    pathParts: string[],
  ): void => {
    if (isIndexableContainer(node) && node.blockId) {
      const textSummary = truncateSummary(collectPlainText(node));
      const nextPath = textSummary ? [...pathParts, textSummary] : pathParts;
      out.push({
        blockId: node.blockId,
        parentBlockId,
        depth,
        variant: mapVariant(node),
        textSummary,
        pathParts: pathParts.slice(),
      });
      for (const child of node.children ?? []) {
        walk(child, depth + 1, node.blockId, nextPath);
      }
      return;
    }

    for (const child of node.children ?? []) {
      walk(child, depth, parentBlockId, pathParts);
    }
  };

  walk(root, 0, null, []);

  return out
    .slice()
    .sort((left, right) => left.depth - right.depth || left.blockId.localeCompare(right.blockId));
}

function stableBlockRowId(sourceType: string, sourceId: string, blockId: string): string {
  return `blk_idx_${sourceType}_${sourceId}_${blockId}`;
}

export interface BlockIndexRow {
  blockId: string;
  parentBlockId: string | null;
  depth: number;
  variant: string;
  textSummary: string | null;
}

export interface BlocksRepo {
  rebuildForSource(
    sourceType: string,
    sourceId: string,
    bodyJson: string,
  ): Promise<ExtractedContentBlock[]>;
  deleteForSource(sourceType: string, sourceId: string): Promise<void>;
  listBySource(sourceType: string, sourceId: string): Promise<BlockIndexRow[]>;
}

/**
 * Delete+insert block index rows for one source on an already-open transaction.
 * Used by `createBlocksRepo.rebuildForSource` and by docs' serialized
 * derived-index rebuild (advisory-locked with links in one tx).
 */
export async function replaceBlocksForSourceOnTx(
  tx: Database,
  sourceType: string,
  sourceId: string,
  bodyJson: string,
): Promise<ExtractedContentBlock[]> {
  const extracted = extractBlocksFromEditorState(bodyJson);
  await tx
    .delete(megaContentBlocks)
    .where(and(eq(megaContentBlocks.sourceType, sourceType), eq(megaContentBlocks.sourceId, sourceId)));

  if (extracted.length > 0) {
    const now = new Date();
    await tx.insert(megaContentBlocks).values(
      extracted.map((row) => ({
        id: stableBlockRowId(sourceType, sourceId, row.blockId),
        sourceType,
        sourceId,
        blockId: row.blockId,
        parentBlockId: row.parentBlockId,
        depth: row.depth,
        variant: row.variant,
        textSummary: row.textSummary || null,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }
  return extracted;
}

/**
 * GC-08: block rebuild is a delete+insert full replace keyed by
 * (sourceType, sourceId), run in its own transaction after the owning
 * content write commits (see `docs.ts` `afterDocBodyWrite`).
 */
export function createBlocksRepo(database: Database): BlocksRepo {
  return {
    async rebuildForSource(sourceType, sourceId, bodyJson) {
      return database.transaction(async (tx) => replaceBlocksForSourceOnTx(tx, sourceType, sourceId, bodyJson));
    },

    async deleteForSource(sourceType, sourceId) {
      await database
        .delete(megaContentBlocks)
        .where(
          and(eq(megaContentBlocks.sourceType, sourceType), eq(megaContentBlocks.sourceId, sourceId)),
        );
    },

    async listBySource(sourceType, sourceId) {
      return database
        .select({
          blockId: megaContentBlocks.blockId,
          parentBlockId: megaContentBlocks.parentBlockId,
          depth: megaContentBlocks.depth,
          variant: megaContentBlocks.variant,
          textSummary: megaContentBlocks.textSummary,
        })
        .from(megaContentBlocks)
        .where(
          and(eq(megaContentBlocks.sourceType, sourceType), eq(megaContentBlocks.sourceId, sourceId)),
        );
    },
  };
}

export async function rebuildDocBlocks(
  repo: BlocksRepo,
  docId: string,
  bodyJson: string,
): Promise<ExtractedContentBlock[]> {
  return repo.rebuildForSource(megaContentContainerTypes.DOC, docId, bodyJson);
}

export async function deleteBlocksForDoc(repo: BlocksRepo, docId: string): Promise<void> {
  await repo.deleteForSource(megaContentContainerTypes.DOC, docId);
}

/** List indexed blocks for a doc (CE-51 backlinks block-context join). */
export async function listBlocksForDoc(repo: BlocksRepo, docId: string): Promise<BlockIndexRow[]> {
  return repo.listBySource(megaContentContainerTypes.DOC, docId);
}
