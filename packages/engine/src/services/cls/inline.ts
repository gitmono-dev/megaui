// megaui:libs/mega/services/repos/cls-repo.ts@0ff3a9d (parseFiles / inline comment CRUD)
//
// Diff vs upstream (registered on the EG-06 task card):
// - Upstream's `addInlineComment` only checks
//   `Number.isSafeInteger(line) && line >= 1` and that `filePath` exists on
//   the CL — no upper bound, so a comment can anchor past the end of the
//   diff, and no `revision` validation at all. This port additionally
//   rejects a `line` beyond the file's own diff length
//   (`MegaBadRequestError`, AC2 "OOB line ... reject") and, when an explicit
//   `revision` is supplied, requires it to match an existing
//   `mega_cls.revisions` entry (`MegaBadRequestError`, AC2 "invalid
//   revision ... reject"). Upstream never validates `revision` on add
//   (only `replyInlineComment` reads one, and only ever the fixture-seeded
//   `revisions[0]`).
// - `TypeError` / `RangeError` (upstream) become `MegaBadRequestError` /
//   `MegaNotFoundError` (GC-11: no raw JS errors on a write path); every
//   mutation is gated by `assertWorkspaceMember` (GC-07 fail-closed —
//   upstream's mock backend has no actor concept at all).
import { and, asc, eq } from "drizzle-orm";
import {
  megaCls,
  megaContent,
  megaContentContainerTypes,
  megaInlineComments,
  type Database,
} from "@megaui/database";
import type { CLFile, InlineComment, InlineCommentReply } from "@megaui/core";
import { BODY_FORMAT_VERSION_BLOCK_TREE } from "../docs/body-format";
import { replaceBlocksForSourceOnTx } from "../docs/blocks";
import { replaceLinksForSourceOnTx } from "../docs/links";
import { MegaBadRequestError, MegaNotFoundError } from "../../errors";
import { assertWorkspaceMember } from "./authz";
import { isEmptyCommentBody, normalizeCommentBodyJson } from "./comment-body";
import { newClId } from "./ids";
import { parseRevisions } from "./revisions";
import { fallbackUser, resolveUsers } from "./users";

export interface AddInlineCommentInput {
  filePath: string;
  line: number;
  side?: "additions" | "deletions";
  body: string;
  /** CL revision number the anchor is pinned to; defaults to the latest revision. */
  revision?: number;
}

/** Shared with `cls.ts` (GC-02: one `mega_cls.files` JSON parser, not a per-module copy). */
export function parseFiles(raw: unknown): CLFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string") return [];
    const status =
      file.status === "added" || file.status === "deleted" || file.status === "modified" ? file.status : "modified";
    return [
      {
        path: file.path,
        status,
        additions: typeof file.additions === "number" ? file.additions : 0,
        deletions: typeof file.deletions === "number" ? file.deletions : 0,
        patch: typeof file.patch === "string" ? file.patch : "",
        viewed: Boolean(file.viewed),
        commentCount: typeof file.commentCount === "number" ? file.commentCount : 0,
      },
    ];
  });
}

/**
 * Upper bound for an inline-comment anchor line (AC2 "OOB line ... reject").
 * `CLFile` carries no explicit line count — `patch` is the unified-diff
 * text actually rendered by the Files tab, so its line count is the
 * anchorable range; `additions + deletions` is a floor for files whose
 * patch text was stripped/omitted (e.g. binary or over-size diffs).
 */
function maxAnchorLine(file: CLFile): number {
  const patchLines = file.patch.length > 0 ? file.patch.split("\n").length : 0;
  return Math.max(patchLines, file.additions + file.deletions, 1);
}

interface ClAnchorRow {
  id: string;
  files: Array<Record<string, unknown>>;
}

async function loadClAnchorRow(database: Database, number: number): Promise<ClAnchorRow> {
  const [row] = await database
    .select({ id: megaCls.id, files: megaCls.files, revisions: megaCls.revisions })
    .from(megaCls)
    .where(eq(megaCls.number, number))
    .limit(1);
  if (!row) throw new MegaNotFoundError("CL", number);
  return { id: row.id, files: row.files };
}

interface ClAnchorState {
  id: string;
  files: CLFile[];
  rawFiles: Array<Record<string, unknown>>;
  revisionNumbers: readonly number[];
}

function shapeClAnchorState(row: { id: string; files: Array<Record<string, unknown>>; revisions: unknown }): ClAnchorState {
  return {
    id: row.id,
    files: parseFiles(row.files),
    rawFiles: row.files,
    revisionNumbers: parseRevisions(row.revisions).map((revision) => revision.number),
  };
}

async function loadClAnchorState(database: Database, number: number): Promise<ClAnchorState> {
  const [row] = await database
    .select({ id: megaCls.id, files: megaCls.files, revisions: megaCls.revisions })
    .from(megaCls)
    .where(eq(megaCls.number, number))
    .limit(1);
  if (!row) throw new MegaNotFoundError("CL", number);
  return shapeClAnchorState(row);
}

/** Same read as `loadClAnchorState`, but `FOR UPDATE`-locked — call only inside the transaction that also writes `mega_cls.files` (mirrors `checks.ts`). */
async function loadClAnchorStateForUpdate(tx: Database, number: number): Promise<ClAnchorState> {
  const [row] = await tx
    .select({ id: megaCls.id, files: megaCls.files, revisions: megaCls.revisions })
    .from(megaCls)
    .where(eq(megaCls.number, number))
    .for("update")
    .limit(1);
  if (!row) throw new MegaNotFoundError("CL", number);
  return shapeClAnchorState(row);
}

async function rebuildDerivedIndexesOnTx(
  tx: Database,
  sourceType: string,
  sourceId: string,
  bodyJson: string,
): Promise<void> {
  await replaceLinksForSourceOnTx(tx, sourceType, sourceId, bodyJson);
  await replaceBlocksForSourceOnTx(tx, sourceType, sourceId, bodyJson);
}

interface InlineReplyRow {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
  revision?: number;
}

function parseInlineReplyRows(raw: unknown): InlineReplyRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.authorId !== "string" ||
      typeof record.body !== "string" ||
      typeof record.createdAt !== "string"
    ) {
      return [];
    }
    return [
      {
        id: record.id,
        authorId: record.authorId,
        body: record.body,
        createdAt: record.createdAt,
        revision: typeof record.revision === "number" ? record.revision : undefined,
      },
    ];
  });
}

async function loadInlineComment(database: Database, id: string): Promise<InlineComment> {
  const [row] = await database.select().from(megaInlineComments).where(eq(megaInlineComments.id, id)).limit(1);
  if (!row) throw new MegaNotFoundError("Inline comment", id);

  const replies = parseInlineReplyRows(row.replies);
  const usersById = await resolveUsers(database, [row.authorId, ...replies.map((reply) => reply.authorId)]);

  const [content] = await database
    .select({ bodyJson: megaContent.bodyJson })
    .from(megaContent)
    .where(and(eq(megaContent.containerType, megaContentContainerTypes.INLINE_COMMENT), eq(megaContent.containerId, row.id)))
    .limit(1);

  return {
    id: row.id,
    clNumber: row.clNumber,
    filePath: row.filePath,
    side: row.side === "deletions" ? "deletions" : "additions",
    line: row.line,
    author: usersById.get(row.authorId) ?? fallbackUser(row.authorId),
    body: normalizeCommentBodyJson(content?.bodyJson),
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : undefined,
    replies: replies.map((reply) => ({
      id: reply.id,
      author: usersById.get(reply.authorId) ?? fallbackUser(reply.authorId),
      body: normalizeCommentBodyJson(reply.body),
      createdAt: reply.createdAt,
      revision: reply.revision,
    })),
  };
}

export async function listInlineComments(database: Database, clNumber: number): Promise<InlineComment[]> {
  await loadClAnchorRow(database, clNumber);
  const rows = await database
    .select({ id: megaInlineComments.id })
    .from(megaInlineComments)
    .where(eq(megaInlineComments.clNumber, clNumber))
    .orderBy(asc(megaInlineComments.createdAt));
  return Promise.all(rows.map((row) => loadInlineComment(database, row.id)));
}

export async function addInlineComment(
  database: Database,
  clNumber: number,
  input: AddInlineCommentInput,
  actorUserId: string | null | undefined,
): Promise<InlineComment> {
  const authorId = await assertWorkspaceMember(database, actorUserId);
  const lexical = normalizeCommentBodyJson(input.body);
  if (isEmptyCommentBody(lexical)) throw new MegaBadRequestError("Inline comment body is required");
  if (!Number.isSafeInteger(input.line) || input.line < 1) {
    throw new MegaBadRequestError("Inline comment line must be a positive integer");
  }

  const now = new Date();
  const id = newClId("inline");
  const bodyJson = JSON.parse(lexical) as Record<string, unknown>;
  const side = input.side ?? "additions";

  await database.transaction(async (tx) => {
    // Lock the CL row and re-read `files`/`revisions` under that lock so a
    // concurrent `addInlineComment`/`setCLFileViewed` on the same CL cannot
    // race the read-modify-write of `commentCount` (mirrors `checks.ts`).
    const cl = await loadClAnchorStateForUpdate(tx, clNumber);
    const file = cl.files.find((candidate) => candidate.path === input.filePath);
    if (!file) throw new MegaNotFoundError("CL file", input.filePath);
    const bound = maxAnchorLine(file);
    if (input.line > bound) {
      throw new MegaBadRequestError(
        `Inline comment line ${input.line} is out of bounds for ${input.filePath} (max ${bound})`,
      );
    }

    // `InlineComment` has no top-level `revision` field (only replies carry
    // one, ported as-is from upstream) — an explicit `revision` here is
    // validated but not persisted, purely to satisfy AC2 "invalid revision
    // ... reject".
    if (input.revision !== undefined && !cl.revisionNumbers.includes(input.revision)) {
      throw new MegaBadRequestError(`CL !${clNumber} has no revision ${input.revision}`);
    }

    const nextRawFiles = cl.rawFiles.map((raw) => {
      if (raw.path !== input.filePath) return raw;
      const commentCount = typeof raw.commentCount === "number" ? raw.commentCount : 0;
      return { ...raw, commentCount: commentCount + 1 };
    });

    await tx.insert(megaInlineComments).values({
      id,
      clNumber,
      filePath: input.filePath,
      side,
      line: input.line,
      authorId,
      replies: [],
      resolvedAt: null,
      createdAt: now,
    });
    await tx.insert(megaContent).values({
      containerType: megaContentContainerTypes.INLINE_COMMENT,
      containerId: id,
      bodyJson,
      bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
      createdAt: now,
      updatedAt: now,
    });
    await rebuildDerivedIndexesOnTx(tx, megaContentContainerTypes.INLINE_COMMENT, id, lexical);
    await tx.update(megaCls).set({ files: nextRawFiles, updatedAt: now }).where(eq(megaCls.id, cl.id));
  });

  return loadInlineComment(database, id);
}

export async function replyInlineComment(
  database: Database,
  commentId: string,
  body: string,
  actorUserId: string | null | undefined,
): Promise<InlineCommentReply> {
  const authorId = await assertWorkspaceMember(database, actorUserId);
  const lexical = normalizeCommentBodyJson(body);
  if (isEmptyCommentBody(lexical)) throw new MegaBadRequestError("Inline comment reply body is required");

  const now = new Date();
  const replyId = newClId("inline_reply");
  const createdAt = now.toISOString();
  let revision: number | undefined;
  const bodyJson = JSON.parse(lexical) as Record<string, unknown>;

  await database.transaction(async (tx) => {
    const [row] = await tx.select().from(megaInlineComments).where(eq(megaInlineComments.id, commentId)).for("update").limit(1);
    if (!row) throw new MegaNotFoundError("Inline comment", commentId);
    const cl = await loadClAnchorState(tx, row.clNumber);
    revision = cl.revisionNumbers[0];
    const nextReplies = [...row.replies, { id: replyId, authorId, body: lexical, createdAt, revision }];
    await tx.update(megaInlineComments).set({ replies: nextReplies }).where(eq(megaInlineComments.id, commentId));
    await tx.insert(megaContent).values({
      containerType: megaContentContainerTypes.REPLY,
      containerId: replyId,
      bodyJson,
      bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
      createdAt: now,
      updatedAt: now,
    });
    await rebuildDerivedIndexesOnTx(tx, megaContentContainerTypes.REPLY, replyId, lexical);
  });

  const usersById = await resolveUsers(database, [authorId]);
  return {
    id: replyId,
    author: usersById.get(authorId) ?? fallbackUser(authorId),
    body: lexical,
    createdAt,
    revision,
  };
}

export async function resolveInlineComment(
  database: Database,
  commentId: string,
  actorUserId: string | null | undefined,
): Promise<InlineComment> {
  await assertWorkspaceMember(database, actorUserId);
  await database.transaction(async (tx) => {
    const [row] = await tx
      .select({ resolvedAt: megaInlineComments.resolvedAt })
      .from(megaInlineComments)
      .where(eq(megaInlineComments.id, commentId))
      .for("update")
      .limit(1);
    if (!row) throw new MegaNotFoundError("Inline comment", commentId);
    await tx
      .update(megaInlineComments)
      .set({ resolvedAt: row.resolvedAt ? null : new Date() })
      .where(eq(megaInlineComments.id, commentId));
  });
  return loadInlineComment(database, commentId);
}

export async function setCLFileViewed(
  database: Database,
  number: number,
  path: string,
  viewed: boolean,
  actorUserId: string | null | undefined,
): Promise<CLFile> {
  await assertWorkspaceMember(database, actorUserId);
  let nextFile: CLFile | undefined;
  await database.transaction(async (tx) => {
    // Lock + re-read `files` under the lock so a concurrent
    // `addInlineComment`/`setCLFileViewed` on the same CL cannot clobber
    // each other's read-modify-write of `mega_cls.files`.
    const cl = await loadClAnchorStateForUpdate(tx, number);
    const updated = cl.files.find((file) => file.path === path);
    if (!updated) throw new MegaNotFoundError("CL file", path);
    nextFile = { ...updated, viewed };
    const nextRawFiles = cl.rawFiles.map((raw) => (raw.path === path ? { ...raw, viewed } : raw));
    await tx.update(megaCls).set({ files: nextRawFiles, updatedAt: new Date() }).where(eq(megaCls.id, cl.id));
  });
  if (!nextFile) throw new MegaNotFoundError("CL file", path);
  return nextFile;
}
