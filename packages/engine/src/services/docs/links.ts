// megaui:libs/mega/services/links.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-03 task card):
// - No `MEGA_DOCS_DATA_BACKEND=mock` branch / links-mock store (DEBT-04).
// - No `filterTitleIndexByAcl` default-open shim — ACL is fail-closed
//   (GC-07) via `createAclService`; `getTitleIndex` / backlinks only apply
//   doc-scoped ACL filtering (issue/CL ACL do not exist yet — EG-04/EG-05).
// - Backlink/title-index target existence and presentation read `mega_docs`
//   / `mega_issues` / `mega_cls` directly instead of dynamically importing
//   sibling `issues.ts` / `cls.ts` services (which do not exist in this
//   package yet) — this avoids the upstream `await import()` cycle-break
//   entirely by depending only on `Database` + injected callbacks.
// - `resolveOrCreateDoc` takes the doc-creation capability as a parameter
//   (`createEmptyDoc`) instead of importing `./docs` — same reasoning.
// - Single PG dialect (ADR-ARCH-02): no sqlite/d1 transaction branch.
import { and, eq, isNull } from "drizzle-orm";
import {
  megaCls,
  megaClComments,
  megaContentContainerTypes,
  megaContentLinks,
  megaContentLinkTargetKinds,
  megaDocComments,
  megaDocs,
  megaIssueComments,
  megaIssues,
  type Database,
} from "@megaui/database";
import { buildTitleIndex, searchTitleIndex, type TitleIndexEntry } from "@megaui/core";
import { parseRoamEmbed } from "@megaui/content";
import { MegaBadRequestError, MegaConflictError, MegaNotFoundError, MegaTitleConflictError } from "../../errors";
import type { AclService } from "../acl";
import { listBlocksForDoc, type BlocksRepo } from "./blocks";
import type { BacklinkItem, BacklinkTargetKind, ResolveOrCreateResult, UnlinkedItem } from "./types";

const CONTEXT_SUMMARY_MAX = 120;
const LINKABLE_KINDS = new Set<string>([
  megaContentLinkTargetKinds.DOC,
  megaContentLinkTargetKinds.ISSUE,
  megaContentLinkTargetKinds.CL,
  megaContentLinkTargetKinds.BLOCK,
]);

export type ExtractedContentLink = {
  targetKind: (typeof megaContentLinkTargetKinds)[keyof typeof megaContentLinkTargetKinds];
  targetId: string;
  contextSummary: string;
};

type LexicalWalkNode = {
  type?: string;
  text?: string;
  targetDocId?: string;
  label?: string;
  blockId?: string;
  ref?: {
    kind?: string;
    targetTitle?: string;
    targetId?: string;
  };
  blockRef?: {
    targetDocId?: string;
    targetBlockId?: string;
    label?: string;
    sourcePath?: string;
    status?: string;
  };
  embed?: {
    targetDocId?: string;
    targetBlockId?: string;
  };
  children?: LexicalWalkNode[];
};

function collectPlainText(node: LexicalWalkNode): string {
  if (typeof node.text === "string") return node.text;
  if (node.type === "mega-ref" && typeof node.ref?.targetTitle === "string") {
    return node.ref.targetTitle;
  }
  return (node.children ?? []).map(collectPlainText).join("");
}

function truncateSummary(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, CONTEXT_SUMMARY_MAX);
}

function isLinkableKind(kind: string | undefined): kind is ExtractedContentLink["targetKind"] {
  return Boolean(kind && LINKABLE_KINDS.has(kind));
}

const BLOCK_TARGET_ID_SEPARATOR = ":";

/**
 * `mega_content_links.target_id` is a single text column with no dedicated
 * "target doc" column, so a bare `blockId` alone is not a stable identity —
 * the same `blockId` string can exist on two different docs, which used to
 * make `listDocBacklinks` attribute a backlink to the wrong document (P1).
 * BLOCK targets are persisted as `${targetDocId}${BLOCK_TARGET_ID_SEPARATOR}${targetBlockId}`;
 * decode with `decodeBlockTargetId`. Least-invasive fix given the existing
 * schema — see EG-03 ER-05 review.
 */
export function encodeBlockTargetId(targetDocId: string, targetBlockId: string): string {
  return `${targetDocId}${BLOCK_TARGET_ID_SEPARATOR}${targetBlockId}`;
}

export function decodeBlockTargetId(encoded: string): { targetDocId: string; targetBlockId: string } | null {
  const index = encoded.indexOf(BLOCK_TARGET_ID_SEPARATOR);
  if (index <= 0 || index === encoded.length - 1) return null;
  return { targetDocId: encoded.slice(0, index), targetBlockId: encoded.slice(index + 1) };
}

/**
 * Headless walk of Lexical EditorState JSON collecting resolved mega-ref /
 * mega-block-ref nodes. Unresolved refs (missing targetId) are skipped —
 * they are not indexed until `resolveOrCreateDoc`.
 */
export function extractRefsFromEditorState(editorStateJSON: string): ExtractedContentLink[] {
  let root: LexicalWalkNode;
  try {
    const parsed = JSON.parse(editorStateJSON) as { root?: LexicalWalkNode };
    root = parsed.root ?? {};
  } catch {
    return [];
  }

  const out: ExtractedContentLink[] = [];

  const walk = (node: LexicalWalkNode, blockSummary: string | null): void => {
    if (node.type === "mega-block") {
      const summary = truncateSummary(collectPlainText(node));
      for (const child of node.children ?? []) walk(child, summary || blockSummary);
      return;
    }

    if (node.type === "mega-ref" && node.ref?.targetId && isLinkableKind(node.ref.kind)) {
      // `kind: "block"` on mega-ref has no owning docId, so it cannot be
      // stored as an encoded `${docId}:${blockId}` identity. Clients must
      // use `mega-block-ref` (validated on write); skip legacy bare forms.
      if (node.ref.kind !== megaContentLinkTargetKinds.BLOCK) {
        out.push({
          targetKind: node.ref.kind,
          targetId: node.ref.targetId,
          contextSummary: blockSummary ?? truncateSummary(node.ref.targetTitle ?? node.ref.targetId),
        });
      }
    }

    if (
      node.type === "mega-block-ref" &&
      node.blockRef?.targetBlockId &&
      node.blockRef.targetDocId &&
      (!node.blockRef.status || node.blockRef.status === "ok")
    ) {
      out.push({
        targetKind: megaContentLinkTargetKinds.BLOCK,
        targetId: encodeBlockTargetId(node.blockRef.targetDocId, node.blockRef.targetBlockId),
        contextSummary:
          blockSummary ??
          truncateSummary(node.blockRef.label ?? node.blockRef.sourcePath ?? node.blockRef.targetBlockId),
      });
    }

    const embed = node.type === "mega-embed" && node.text && node.targetDocId
      ? parseRoamEmbed(node.text, node.targetDocId, node.label) : node.embed;
    if (node.type === "mega-embed" && embed?.targetDocId && embed.targetBlockId) {
      out.push({
        targetKind: megaContentLinkTargetKinds.BLOCK,
        targetId: encodeBlockTargetId(embed.targetDocId, embed.targetBlockId),
        contextSummary: blockSummary ?? embed.targetBlockId,
      });
    }

    for (const child of node.children ?? []) walk(child, blockSummary);
  };

  walk(root, null);

  return out
    .slice()
    .sort(
      (left, right) =>
        left.targetKind.localeCompare(right.targetKind) ||
        left.targetId.localeCompare(right.targetId) ||
        left.contextSummary.localeCompare(right.contextSummary),
    );
}

function stableLinkId(sourceType: string, sourceId: string, row: ExtractedContentLink, index: number): string {
  return `lnk_${sourceType}_${sourceId}_${index}_${row.targetKind}_${row.targetId}`;
}

export interface LinkTargetRow {
  sourceType: string;
  sourceId: string;
  contextSummary: string | null;
  createdAt: Date;
}

export interface LinkSourceRow {
  targetKind: string;
  targetId: string;
  contextSummary: string | null;
}

export interface LinksRepo {
  rebuildForSource(sourceType: string, sourceId: string, bodyJson: string): Promise<ExtractedContentLink[]>;
  listByTarget(targetKind: string, targetId: string): Promise<LinkTargetRow[]>;
  listBySource(sourceType: string, sourceId: string): Promise<LinkSourceRow[]>;
  deleteForSource(sourceType: string, sourceId: string): Promise<void>;
}

/**
 * Delete+insert link rows for one source on an already-open transaction.
 * Used by `createLinksRepo.rebuildForSource` and by docs' serialized
 * derived-index rebuild (advisory-locked with blocks in one tx).
 */
export async function replaceLinksForSourceOnTx(
  tx: Database,
  sourceType: string,
  sourceId: string,
  bodyJson: string,
): Promise<ExtractedContentLink[]> {
  const extracted = extractRefsFromEditorState(bodyJson);
  await tx
    .delete(megaContentLinks)
    .where(and(eq(megaContentLinks.sourceType, sourceType), eq(megaContentLinks.sourceId, sourceId)));

  if (extracted.length > 0) {
    const now = new Date();
    await tx.insert(megaContentLinks).values(
      extracted.map((row, index) => ({
        id: stableLinkId(sourceType, sourceId, row, index),
        sourceType,
        sourceId,
        targetKind: row.targetKind,
        targetId: row.targetId,
        contextSummary: row.contextSummary,
        createdAt: now,
      })),
    );
  }
  return extracted;
}

/**
 * GC-08 / ADR-CE-05: delete+insert link rows for one source container from
 * its body_json, run in its own transaction after the owning content write
 * commits (see `docs.ts` `afterDocBodyWrite`).
 */
export function createLinksRepo(database: Database): LinksRepo {
  return {
    async rebuildForSource(sourceType, sourceId, bodyJson) {
      return database.transaction(async (tx) => replaceLinksForSourceOnTx(tx, sourceType, sourceId, bodyJson));
    },

    async listByTarget(targetKind, targetId) {
      return database
        .select({
          sourceType: megaContentLinks.sourceType,
          sourceId: megaContentLinks.sourceId,
          contextSummary: megaContentLinks.contextSummary,
          createdAt: megaContentLinks.createdAt,
        })
        .from(megaContentLinks)
        .where(and(eq(megaContentLinks.targetKind, targetKind), eq(megaContentLinks.targetId, targetId)));
    },

    async listBySource(sourceType, sourceId) {
      return database
        .select({
          targetKind: megaContentLinks.targetKind,
          targetId: megaContentLinks.targetId,
          contextSummary: megaContentLinks.contextSummary,
        })
        .from(megaContentLinks)
        .where(and(eq(megaContentLinks.sourceType, sourceType), eq(megaContentLinks.sourceId, sourceId)));
    },

    async deleteForSource(sourceType, sourceId) {
      await database
        .delete(megaContentLinks)
        .where(and(eq(megaContentLinks.sourceType, sourceType), eq(megaContentLinks.sourceId, sourceId)));
    },
  };
}

export async function rebuildDocLinks(
  repo: LinksRepo,
  docId: string,
  bodyJson: string,
): Promise<ExtractedContentLink[]> {
  return repo.rebuildForSource(megaContentContainerTypes.DOC, docId, bodyJson);
}

export async function deleteLinksForDoc(repo: LinksRepo, docId: string): Promise<void> {
  await repo.deleteForSource(megaContentContainerTypes.DOC, docId);
}

/**
 * GET title index — doc + issue + CL titles (no soft-deleted docs), read
 * directly off domain tables. Doc entries are filtered fail-closed against
 * the actor's ACL read grant; issue/CL ACL do not exist yet (EG-04/EG-05).
 */
export async function getTitleIndex(
  database: Database,
  acl: AclService,
  actorUserId: string | null | undefined,
): Promise<TitleIndexEntry[]> {
  const docRows = await database
    .select({ id: megaDocs.id, title: megaDocs.title })
    .from(megaDocs)
    .where(isNull(megaDocs.deletedAt));
  const readableDocs = await Promise.all(
    docRows.map(async (doc) => ((await acl.canRead(doc.id, actorUserId)).allow ? doc : null)),
  );
  const issueRows = await database.select({ number: megaIssues.number, title: megaIssues.title }).from(megaIssues);
  const clRows = await database.select({ number: megaCls.number, title: megaCls.title }).from(megaCls);

  return buildTitleIndex({
    docs: readableDocs.filter((doc): doc is { id: string; title: string } => doc !== null),
    issues: issueRows,
    cls: clRows,
  });
}

export async function searchDocTitleIndex(
  database: Database,
  acl: AclService,
  actorUserId: string | null | undefined,
  query: string,
  limit = 8,
): Promise<TitleIndexEntry[]> {
  const index = await getTitleIndex(database, acl, actorUserId);
  return searchTitleIndex(index, query, limit);
}

export interface CreateEmptyDoc {
  (input: { title: string }, actorUserId: string): Promise<{ id: string; title: string; body: string }>;
}

/**
 * CE-41 wikilink resolve-or-create: find a live doc by title, or create it.
 * A live doc matching `title` is returned as "existing" when the signed-in
 * actor can read it under the workspace-default document policy.
 */
export async function resolveOrCreateDoc(
  database: Database,
  _linksRepo: LinksRepo,
  acl: AclService,
  createEmptyDoc: CreateEmptyDoc,
  titleInput: string,
  actorUserId: string,
): Promise<ResolveOrCreateResult> {
  const title = titleInput.trim();
  if (!title) throw new MegaBadRequestError("Document title is required");

  const lookupExisting = async (): Promise<ResolveOrCreateResult | null> => {
    const [hit] = await database
      .select({ id: megaDocs.id, title: megaDocs.title })
      .from(megaDocs)
      .where(and(eq(megaDocs.title, title), isNull(megaDocs.deletedAt)))
      .limit(1);
    if (!hit) return null;
    if (!(await acl.canRead(hit.id, actorUserId)).allow) return null;
    return { targetId: hit.id, title: hit.title, created: false };
  };

  const existing = await lookupExisting();
  if (existing) return existing;

  try {
    const created = await createEmptyDoc({ title }, actorUserId);
    // createDoc (and any injectee that mirrors it) rebuilds derived indexes
    // under the per-doc advisory lock — do not call rebuildDocLinks here with
    // the returned snapshot, or a concurrent body save can lose newer links.
    return { targetId: created.id, title: created.title, created: true };
  } catch (error) {
    // Concurrent create lost the title-unique race — return the winner when
    // the signed-in actor can read it, otherwise surface a generic conflict.
    if (error instanceof MegaTitleConflictError) {
      const winner = await lookupExisting();
      if (winner) return winner;
      throw new MegaConflictError("Unable to create document");
    }
    throw error;
  }
}

async function resolveSourcePresentation(
  database: Database,
  sourceType: string,
  sourceId: string,
): Promise<{ sourceTitle: string; href: string }> {
  switch (sourceType) {
    case megaContentContainerTypes.DOC: {
      const [doc] = await database
        .select({ id: megaDocs.id, title: megaDocs.title })
        .from(megaDocs)
        .where(eq(megaDocs.id, sourceId))
        .limit(1);
      return doc
        ? { sourceTitle: doc.title, href: `/docs/${encodeURIComponent(doc.id)}` }
        : { sourceTitle: sourceId, href: `/docs/${encodeURIComponent(sourceId)}` };
    }
    case megaContentContainerTypes.ISSUE: {
      const [byId] = await database
        .select({ number: megaIssues.number, title: megaIssues.title })
        .from(megaIssues)
        .where(eq(megaIssues.id, sourceId))
        .limit(1);
      if (byId) return { sourceTitle: byId.title, href: `/issues/${byId.number}` };
      const number = Number(sourceId);
      const [issue] = Number.isFinite(number)
        ? await database
            .select({ number: megaIssues.number, title: megaIssues.title })
            .from(megaIssues)
            .where(eq(megaIssues.number, number))
            .limit(1)
        : [];
      return issue
        ? { sourceTitle: issue.title, href: `/issues/${issue.number}` }
        : { sourceTitle: sourceId, href: "/issues" };
    }
    case megaContentContainerTypes.CL: {
      const [byId] = await database
        .select({ number: megaCls.number, title: megaCls.title })
        .from(megaCls)
        .where(eq(megaCls.id, sourceId))
        .limit(1);
      if (byId) return { sourceTitle: byId.title, href: `/cls/${byId.number}` };
      const number = Number(sourceId);
      const [cl] = Number.isFinite(number)
        ? await database
            .select({ number: megaCls.number, title: megaCls.title })
            .from(megaCls)
            .where(eq(megaCls.number, number))
            .limit(1)
        : [];
      return cl
        ? { sourceTitle: cl.title, href: `/cls/${cl.number}` }
        : { sourceTitle: sourceId, href: "/cls" };
    }
    case megaContentContainerTypes.ISSUE_COMMENT: {
      const [comment] = await database
        .select({ issueNumber: megaIssueComments.issueNumber })
        .from(megaIssueComments)
        .where(eq(megaIssueComments.id, sourceId))
        .limit(1);
      if (!comment) return { sourceTitle: sourceId, href: "/issues" };
      const [issue] = await database
        .select({ title: megaIssues.title })
        .from(megaIssues)
        .where(eq(megaIssues.number, comment.issueNumber))
        .limit(1);
      const href = `/issues/${comment.issueNumber}#comment-${encodeURIComponent(sourceId)}`;
      return { sourceTitle: issue?.title ?? `#${comment.issueNumber}`, href };
    }
    case megaContentContainerTypes.CL_COMMENT: {
      const [comment] = await database
        .select({ clNumber: megaClComments.clNumber })
        .from(megaClComments)
        .where(eq(megaClComments.id, sourceId))
        .limit(1);
      if (!comment) return { sourceTitle: sourceId, href: "/cls" };
      const [cl] = await database
        .select({ title: megaCls.title })
        .from(megaCls)
        .where(eq(megaCls.number, comment.clNumber))
        .limit(1);
      const href = `/cls/${comment.clNumber}#comment-${encodeURIComponent(sourceId)}`;
      return { sourceTitle: cl?.title ?? `!${comment.clNumber}`, href };
    }
    case megaContentContainerTypes.DOC_COMMENT: {
      const [comment] = await database
        .select({ docId: megaDocComments.docId })
        .from(megaDocComments)
        .where(eq(megaDocComments.id, sourceId))
        .limit(1);
      if (!comment) return { sourceTitle: sourceId, href: "/docs" };
      const [doc] = await database
        .select({ title: megaDocs.title })
        .from(megaDocs)
        .where(eq(megaDocs.id, comment.docId))
        .limit(1);
      const href = `/docs/${encodeURIComponent(comment.docId)}#comment-${encodeURIComponent(sourceId)}`;
      return { sourceTitle: doc?.title ?? comment.docId, href };
    }
    default:
      return { sourceTitle: sourceId, href: "/docs" };
  }
}

type BacklinkRow = LinkTargetRow & { targetBlockId?: string; targetBlockSummary?: string };

async function assertBacklinkTargetExists(
  database: Database,
  kind: BacklinkTargetKind,
  id: string,
): Promise<void> {
  switch (kind) {
    case "doc": {
      const [row] = await database
        .select({ id: megaDocs.id })
        .from(megaDocs)
        .where(and(eq(megaDocs.id, id), isNull(megaDocs.deletedAt)))
        .limit(1);
      if (!row) throw new MegaNotFoundError("Document", id);
      return;
    }
    case "issue": {
      const number = Number(id);
      const [row] = Number.isFinite(number)
        ? await database.select({ number: megaIssues.number }).from(megaIssues).where(eq(megaIssues.number, number)).limit(1)
        : [];
      if (!row) throw new MegaNotFoundError("Issue", id);
      return;
    }
    case "cl": {
      const number = Number(id);
      const [row] = Number.isFinite(number)
        ? await database.select({ number: megaCls.number }).from(megaCls).where(eq(megaCls.number, number)).limit(1)
        : [];
      if (!row) throw new MegaNotFoundError("CL", id);
      return;
    }
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function targetKindFor(kind: BacklinkTargetKind): ExtractedContentLink["targetKind"] {
  switch (kind) {
    case "doc":
      return megaContentLinkTargetKinds.DOC;
    case "issue":
      return megaContentLinkTargetKinds.ISSUE;
    case "cl":
      return megaContentLinkTargetKinds.CL;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

async function presentBacklinks(database: Database, rows: readonly BacklinkRow[]): Promise<{ items: BacklinkItem[] }> {
  const items: BacklinkItem[] = [];
  for (const row of rows) {
    const presentation = await resolveSourcePresentation(database, row.sourceType, row.sourceId);
    items.push({
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      sourceTitle: presentation.sourceTitle,
      contextSummary: row.contextSummary,
      createdAt: row.createdAt.toISOString(),
      href: presentation.href,
      targetBlockId: row.targetBlockId,
      targetBlockSummary: row.targetBlockSummary,
    });
  }
  return { items };
}

/**
 * P1 fix: backlink source rows attached to a doc (`sourceType === "doc"`)
 * are ACL-filtered fail-closed against the actor's read grant before being
 * presented — a private source doc must not leak its title/existence via
 * someone else's backlinks list. Issue/CL sources stay unfiltered (no ACL
 * model for those domains yet — EG-04/EG-05, registered omission).
 */
async function filterReadableSources<T extends { sourceType: string; sourceId: string }>(
  database: Database,
  acl: AclService,
  actorUserId: string | null | undefined,
  rows: readonly T[],
): Promise<T[]> {
  const out: T[] = [];
  const readableDocs = new Map<string, boolean>();
  const canReadDoc = async (docId: string): Promise<boolean> => {
    const cached = readableDocs.get(docId);
    if (cached !== undefined) return cached;
    let allowed: boolean;
    try {
      allowed = (await acl.canRead(docId, actorUserId)).allow;
    } catch (error) {
      if (!(error instanceof MegaNotFoundError)) throw error;
      // A source can disappear between link-index lookup and permission check.
      allowed = false;
    }
    readableDocs.set(docId, allowed);
    return allowed;
  };
  for (const row of rows) {
    if (row.sourceType === megaContentContainerTypes.DOC) {
      if (await canReadDoc(row.sourceId)) out.push(row);
      continue;
    }
    if (row.sourceType === megaContentContainerTypes.DOC_COMMENT) {
      // Doc comments inherit the parent document's ACL — never surface a
      // private doc's title/comment URL via an issue/CL backlinks list.
      const [comment] = await database
        .select({ docId: megaDocComments.docId })
        .from(megaDocComments)
        .where(eq(megaDocComments.id, row.sourceId))
        .limit(1);
      if (comment && await canReadDoc(comment.docId)) out.push(row);
      continue;
    }
    // Issue/CL sources stay unfiltered (no ACL model yet — EG-04/EG-05).
    out.push(row);
  }
  return out;
}

/** Count only readable references to one block; hidden source docs never affect the visible number. */
export async function countReadableBlockReferences(
  database: Database,
  linksRepo: LinksRepo,
  acl: AclService,
  docId: string,
  blockId: string,
  actorUserId: string | null | undefined,
): Promise<number> {
  await acl.assert(docId, actorUserId, "read");
  const rows = await linksRepo.listByTarget(megaContentLinkTargetKinds.BLOCK, encodeBlockTargetId(docId, blockId));
  return (await filterReadableSources(database, acl, actorUserId, rows)).length;
}

/** General backlinks lookup for document, issue, and CL targets. */
export async function listBacklinks(
  database: Database,
  linksRepo: LinksRepo,
  blocksRepo: BlocksRepo,
  acl: AclService,
  kind: BacklinkTargetKind,
  id: string,
  actorUserId: string | null | undefined,
): Promise<{ items: BacklinkItem[] }> {
  await assertBacklinkTargetExists(database, kind, id);
  if (kind === "doc") {
    return listDocBacklinks(database, linksRepo, blocksRepo, acl, id, actorUserId);
  }
  const rows = await linksRepo.listByTarget(targetKindFor(kind), id);
  const readableRows = await filterReadableSources(database, acl, actorUserId, rows);
  return presentBacklinks(database, readableRows);
}

/**
 * Page- and block-scoped backlinks for a document. Always asserts the actor
 * can read `docId` — there is no public ACL-bypass flag (a prior
 * `targetAlreadyChecked` shortcut was removed after ER-05: callers could
 * pass `true` and read private-target relationships).
 */
export async function listDocBacklinks(
  database: Database,
  linksRepo: LinksRepo,
  blocksRepo: BlocksRepo,
  acl: AclService,
  docId: string,
  actorUserId: string | null | undefined,
): Promise<{ items: BacklinkItem[] }> {
  await assertBacklinkTargetExists(database, "doc", docId);
  await acl.assert(docId, actorUserId, "read");
  const docLinkRows = await linksRepo.listByTarget(megaContentLinkTargetKinds.DOC, docId);

  const ownedBlocks = await listBlocksForDoc(blocksRepo, docId);
  const summaryById = new Map(ownedBlocks.map((row) => [row.blockId, row.textSummary ?? ""]));

  const blockLinkRows: BacklinkRow[] = [];
  for (const blockId of ownedBlocks.map((row) => row.blockId)) {
    // Query using the encoded `${docId}:${blockId}` identity (see
    // `encodeBlockTargetId`) so a same-named blockId on a different doc
    // never surfaces here.
    const rows = await linksRepo.listByTarget(megaContentLinkTargetKinds.BLOCK, encodeBlockTargetId(docId, blockId));
    for (const row of rows) {
      blockLinkRows.push({
        ...row,
        targetBlockId: blockId,
        targetBlockSummary: summaryById.get(blockId),
      });
    }
  }

  const readableRows = await filterReadableSources(database, acl, actorUserId, [...docLinkRows, ...blockLinkRows]);
  return presentBacklinks(database, readableRows);
}

function bodyPlainText(editorStateJSON: string): string {
  try {
    const parsed = JSON.parse(editorStateJSON) as { root?: LexicalWalkNode };
    return collectPlainText(parsed.root ?? {}).toLowerCase();
  } catch {
    return "";
  }
}

/** CE-42: entities mentioned in a doc's plain text but not yet `[[linked]]`. */
export async function listDocUnlinked(
  database: Database,
  acl: AclService,
  docBody: string,
  docId: string,
  actorUserId: string | null | undefined,
): Promise<{ items: UnlinkedItem[] }> {
  const plain = bodyPlainText(docBody);
  const index = await getTitleIndex(database, acl, actorUserId);

  const linkedTargetIds = new Set<string>();
  for (const ref of extractRefsFromEditorState(docBody)) {
    linkedTargetIds.add(`${ref.targetKind}:${ref.targetId}`);
  }

  const items: UnlinkedItem[] = [];
  for (const entry of index) {
    if (entry.kind === "user") continue;
    if (entry.kind === "doc" && entry.targetId === docId) continue;
    const key = `${entry.kind}:${entry.targetId}`;
    if (linkedTargetIds.has(key)) continue;
    const needle = entry.targetTitle.trim().toLowerCase();
    if (needle.length < 2) continue;
    if (!plain.includes(needle)) continue;
    items.push({ kind: entry.kind, targetTitle: entry.targetTitle, targetId: entry.targetId });
  }
  return { items };
}
