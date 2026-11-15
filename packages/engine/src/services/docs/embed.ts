// megaui:libs/mega/services/embed.ts@0ff3a9d
// megaui:libs/mega/embed-subtree.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-03 task card):
// - `EmbedAccess`/`NO_ACCESS` is a real fail-closed ACL gate here
//   (`createAclService.canRead`), not a test-only stub (ADR-CE-11's
//   `default_open_editor` is not reproduced — GC-07).
// - Loads embed-chain hop bodies directly off `mega_docs` / `mega_content`
//   instead of dynamically importing `./docs` (`getDoc`) — avoids a
//   docs↔embed import cycle and keeps this file's DB surface to exactly
//   the two tables it needs.
// - `EMBED_MAX_DEPTH` / `extractBlockSubtreeJSON` are re-exported from
//   `@megaui/core` (ported there under PK-01/PK-02) rather than owned here.
import { and, eq, isNull } from "drizzle-orm";
import { megaContent, megaContentContainerTypes, megaDocs, type Database } from "@megaui/database";
import { EMBED_MAX_DEPTH, extractBlockSubtreeJSON } from "@megaui/core";
import { MegaNotFoundError } from "../../errors";
import type { AclService } from "../acl";

export { EMBED_MAX_DEPTH, extractBlockSubtreeJSON } from "@megaui/core";

export type EmbedAccess = "ok" | "NO_ACCESS";
export type EmbedResolveStatus = "ok" | "unresolved" | "cycle" | "too_deep";

export interface EmbedChainEntry {
  docId: string;
  blockId: string | null;
}

export interface EmbedResolveResult {
  access: EmbedAccess;
  status: EmbedResolveStatus;
  docId: string;
  blockId: string | null;
  title: string;
  /** Full or block-filtered Lexical JSON for the CE-53 snapshot path. */
  snapshotBody: string | null;
  /** Always the full target container body (CE-54 live seed). */
  containerBody: string | null;
  /** Path from the resolve target through outbound embeds (target first). */
  ancestorChain: EmbedChainEntry[];
  depth: number;
  cycle: boolean;
  tooDeep: boolean;
}

type LexicalWalkNode = {
  type?: string;
  blockId?: string;
  children?: LexicalWalkNode[];
  embed?: {
    targetDocId?: string;
    targetBlockId?: string;
  };
};

export function extractEmbedsFromEditorState(
  editorStateJSON: string,
): Array<{ targetDocId: string; targetBlockId: string | null }> {
  let root: LexicalWalkNode;
  try {
    const parsed = JSON.parse(editorStateJSON) as { root?: LexicalWalkNode };
    root = parsed.root ?? {};
  } catch {
    return [];
  }

  const out: Array<{ targetDocId: string; targetBlockId: string | null }> = [];
  const walk = (node: LexicalWalkNode): void => {
    if (node.type === "mega-embed" && node.embed?.targetDocId) {
      out.push({
        targetDocId: node.embed.targetDocId,
        targetBlockId: node.embed.targetBlockId ?? null,
      });
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return out;
}

interface WalkOutcome {
  cycle: boolean;
  tooDeep: boolean;
  depth: number;
  chain: EmbedChainEntry[];
}

/** True when following `next` would re-enter an already-open container on `path`. */
function wouldCycle(path: EmbedChainEntry[], nextDocId: string, nextBlockId: string | null): boolean {
  if (nextBlockId) {
    return path.some(
      (entry) => entry.docId === nextDocId && (entry.blockId === null || entry.blockId === nextBlockId),
    );
  }
  return path.some((entry) => entry.docId === nextDocId);
}

/**
 * DFS from the resolve target body (page or block-scoped snapshot). Nested
 * block embeds continue from that block's subtree only. Cycle if re-entering
 * a page/block already on the current path; depth counts edges from start.
 */
async function walkEmbedGraph(
  startDocId: string,
  startBlockId: string | null,
  startBodyJSON: string,
  loadBody: (docId: string) => Promise<{ title: string; body: string } | null>,
): Promise<WalkOutcome> {
  let cycle = false;
  let tooDeep = false;
  let maxDepth = 0;
  let bestChain: EmbedChainEntry[] = [{ docId: startDocId, blockId: startBlockId }];

  const visit = async (bodyJSON: string, path: EmbedChainEntry[], depth: number): Promise<void> => {
    if (cycle) return;
    maxDepth = Math.max(maxDepth, depth);
    if (path.length >= bestChain.length) bestChain = [...path];

    const embeds = extractEmbedsFromEditorState(bodyJSON);
    for (const embed of embeds) {
      const nextEntry: EmbedChainEntry = { docId: embed.targetDocId, blockId: embed.targetBlockId };
      if (wouldCycle(path, embed.targetDocId, embed.targetBlockId)) {
        cycle = true;
        bestChain = [...path, nextEntry];
        return;
      }
      if (depth + 1 > EMBED_MAX_DEPTH) {
        tooDeep = true;
        continue;
      }
      const loaded = await loadBody(embed.targetDocId);
      if (!loaded) continue;

      let nextBody = loaded.body;
      if (embed.targetBlockId) {
        const subtree = extractBlockSubtreeJSON(loaded.body, embed.targetBlockId);
        if (!subtree) continue;
        nextBody = subtree;
      }
      await visit(nextBody, [...path, nextEntry], depth + 1);
      if (cycle) return;
    }
  };

  await visit(startBodyJSON, [{ docId: startDocId, blockId: startBlockId }], 0);
  return { cycle, tooDeep, depth: maxDepth, chain: bestChain };
}

async function loadDocSnapshot(
  database: Database,
  docId: string,
): Promise<{ id: string; title: string; body: string } | null> {
  const [doc] = await database
    .select({ id: megaDocs.id, title: megaDocs.title })
    .from(megaDocs)
    .where(and(eq(megaDocs.id, docId), isNull(megaDocs.deletedAt)))
    .limit(1);
  if (!doc) return null;
  const [content] = await database
    .select({ bodyJson: megaContent.bodyJson })
    .from(megaContent)
    .where(and(eq(megaContent.containerType, megaContentContainerTypes.DOC), eq(megaContent.containerId, docId)))
    .limit(1);
  const body = content ? JSON.stringify(content.bodyJson) : '{"root":{"children":[]}}';
  return { id: doc.id, title: doc.title, body };
}

/**
 * `AclService.canRead` throws `MegaNotFoundError` for a doc id that does not
 * exist at all (EG-02 behavior). Embed resolution walks arbitrary
 * `{{doc-id}}` targets that may be stale or typo'd, so a missing target is
 * just "no read access" here, not a thrown error.
 */
async function canReadDocSoft(acl: AclService, docId: string, actorUserId: string | null | undefined): Promise<boolean> {
  try {
    return (await acl.canRead(docId, actorUserId)).allow;
  } catch (error) {
    if (error instanceof MegaNotFoundError) return false;
    throw error;
  }
}

function emptyResult(
  docId: string,
  blockId: string | null,
  status: EmbedResolveStatus,
  access: EmbedAccess = "ok",
  title = "",
): EmbedResolveResult {
  return {
    access,
    status,
    docId,
    blockId,
    title,
    snapshotBody: null,
    containerBody: null,
    ancestorChain: [],
    depth: 0,
    cycle: status === "cycle",
    tooDeep: status === "too_deep",
  };
}

/**
 * CE-52: embed resolve — target snapshot + ancestor/embed chain + cycle/depth
 * flags. Depth cap `EMBED_MAX_DEPTH`. ACL is fail-closed: an actor who
 * cannot read the target doc gets `NO_ACCESS` (never a thrown error, since
 * embed resolution walks many docs and a denied hop should just stop).
 */
export async function resolveEmbed(
  database: Database,
  acl: AclService,
  docId: string,
  blockId: string | null | undefined,
  actorUserId: string | null | undefined,
): Promise<EmbedResolveResult> {
  const normalizedDocId = docId.trim();
  const normalizedBlockId = blockId?.trim() ? blockId.trim() : null;

  if (!normalizedDocId) return emptyResult(normalizedDocId, normalizedBlockId, "unresolved");

  const doc = await loadDocSnapshot(database, normalizedDocId);
  if (!doc) return emptyResult(normalizedDocId, normalizedBlockId, "unresolved");

  if (!(await canReadDocSoft(acl, normalizedDocId, actorUserId))) {
    return emptyResult(normalizedDocId, normalizedBlockId, "unresolved", "NO_ACCESS");
  }

  let snapshotBody = doc.body;
  if (normalizedBlockId) {
    const subtree = extractBlockSubtreeJSON(doc.body, normalizedBlockId);
    if (!subtree) return emptyResult(normalizedDocId, normalizedBlockId, "unresolved", "ok", doc.title);
    snapshotBody = subtree;
  }

  const cache = new Map<string, { id: string; title: string; body: string } | null>();
  cache.set(doc.id, doc);
  const loadBody = async (id: string) => {
    if (cache.has(id)) return cache.get(id) ?? null;
    if (!(await canReadDocSoft(acl, id, actorUserId))) {
      cache.set(id, null);
      return null;
    }
    const next = await loadDocSnapshot(database, id);
    cache.set(id, next);
    return next;
  };

  const walk = await walkEmbedGraph(normalizedDocId, normalizedBlockId, snapshotBody, loadBody);

  let status: EmbedResolveStatus = "ok";
  if (walk.cycle) status = "cycle";
  else if (walk.tooDeep) status = "too_deep";

  return {
    access: "ok",
    status,
    docId: normalizedDocId,
    blockId: normalizedBlockId,
    title: doc.title,
    snapshotBody,
    containerBody: doc.body,
    ancestorChain: walk.chain,
    depth: walk.depth,
    cycle: walk.cycle,
    tooDeep: walk.tooDeep,
  };
}
