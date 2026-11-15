// megaui:libs/mega/services/docs.ts@0ff3a9d
// megaui:libs/mega/services/repos/docs-repo.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-03 task card):
// - Publication is an atomic status transition plus a version snapshot;
//   legacy adopted records read as published. Permissions remain unchanged.
// - No `MEGA_DOCS_DATA_BACKEND` mock/database switch or `store.ts` fixture
//   backend (DEBT-04) — this is the only (drizzle PG) implementation.
// - Repo layer is drizzle Postgres, not sqlite/d1 — single dialect
//   (ADR-ARCH-02), so no `withDocsTx` dialect branch.
// - Every read/write asserts through the injected fail-closed
//   `createAclService` (GC-07); upstream's mock backend had no ACL at all
//   and the DB backend used `filterByDefaultOpenAcl`.
// - `Database` (and the blocks/links repos) are injected constructor
//   arguments, not a process-wide singleton / dynamic `import()`.
// - GC-11: `validateDocBodyJson` / `validateDocTitle` / `validateDocSummary`
//   run before any write — illegal block payloads and oversized bodies are
//   rejected before they reach persistence (no upstream equivalent).
// - Doc tags are not modeled (`tags` is always `[]`); megaui has not ported
//   a tag catalog yet (see `types.ts`). Doc comments list+create live in
//   `comments.ts` (ADR-DC-01 / DC-01): plain-text body, read ACL, derived
//   COUNT for `commentCount`. Edit/delete/reactions and comment link/block
//   rebuilds remain omitted (no Lexical import pipeline).
// - `linkedCLs` / `linkedIssues` stay `[]` on the `Doc` shape, matching the
//   upstream `docs-repo.ts` behavior exactly (never derived from links).
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  megaContent,
  megaContentBlocks,
  megaContentContainerTypes,
  megaContentLinks,
  megaDocCollaboratorRoles,
  megaDocCollaborators,
  megaDocs,
  megaDocStars,
  megaDocStatus,
  megaDocVersions,
  type Database,
} from "@megaui/database";
import { createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import type { Doc, DocVersion } from "@megaui/core";
import {
  MegaConflictError,
  MegaNotFoundError,
  MegaTitleConflictError,
  MegaUnauthorizedError,
} from "../../errors";
import type { AclService } from "../acl";
import { fallbackPublicProfile, resolvePublicProfiles } from "../enterprise/public-profile";
import { replaceBlocksForSourceOnTx, type BlocksRepo } from "./blocks";
import {
  BODY_FORMAT_VERSION_BLOCK_TREE,
  normalizeDocBodyJson,
  prepareWritableDocBody,
} from "./body-format";
import { addDocComment, countDocComments, listDocComments } from "./comments";
import { replaceLinksForSourceOnTx, type LinksRepo } from "./links";
import type { CreateDocInput, SaveDocInput, UpdateDocMetaInput } from "./types";
import { validateDocBodyJson, validateDocSummary, validateDocTitle } from "./validation";

/** Advisory-lock namespace for per-doc derived index rebuilds (links + blocks). */
const DOC_DERIVED_INDEX_LOCK_NS = 1_296_386_881;

function newDocId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function isPgUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code: unknown }).code === "23505"
    ) {
      return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause: unknown }).cause
        : undefined;
  }
  return false;
}

function statusFromRow(status: string): Doc["status"] {
  if (status === megaDocStatus.PUBLISHED || status === "adopted") return "published";
  if (status === megaDocStatus.DRAFT) return "draft";
  return undefined;
}

export function createDocsService(
  database: Database,
  acl: AclService,
  // Kept for createDocsDomain wiring / call-site parity; derived-index
  // rebuilds go through `replace*ForSourceOnTx` under an advisory lock.
  _blocksRepo: BlocksRepo,
  _linksRepo: LinksRepo,
) {
  /**
   * Rebuild (or clear) derived link/block indexes for `docId` on an open
   * transaction that already holds `DOC_DERIVED_INDEX_LOCK_NS`. Callers must
   * perform content writes in the *same* transaction so a rebuild failure
   * rolls back the body write (GC-08 atomicity).
   */
  async function rebuildDerivedIndexesOnTx(tx: Database, docId: string, bodyJson: string | null): Promise<void> {
    if (bodyJson === null) {
      await tx
        .delete(megaContentLinks)
        .where(
          and(
            eq(megaContentLinks.sourceType, megaContentContainerTypes.DOC),
            eq(megaContentLinks.sourceId, docId),
          ),
        );
      await tx
        .delete(megaContentBlocks)
        .where(
          and(
            eq(megaContentBlocks.sourceType, megaContentContainerTypes.DOC),
            eq(megaContentBlocks.sourceId, docId),
          ),
        );
      return;
    }
    await replaceLinksForSourceOnTx(tx, megaContentContainerTypes.DOC, docId, bodyJson);
    await replaceBlocksForSourceOnTx(tx, megaContentContainerTypes.DOC, docId, bodyJson);
  }

  async function loadDoc(id: string, actorUserId: string | null | undefined): Promise<Doc> {
    const [row] = await database
      .select()
      .from(megaDocs)
      .where(and(eq(megaDocs.id, id), isNull(megaDocs.deletedAt)))
      .limit(1);
    if (!row) throw new MegaNotFoundError("Document", id);

    const [content] = await database
      .select({ bodyJson: megaContent.bodyJson, bodyFormatVersion: megaContent.bodyFormatVersion })
      .from(megaContent)
      .where(and(eq(megaContent.containerType, megaContentContainerTypes.DOC), eq(megaContent.containerId, id)))
      .limit(1);

    const rawBody = content ? JSON.stringify(content.bodyJson) : createEmptyMegaDocumentEditorStateJSON();
    const storedVersion = content?.bodyFormatVersion ?? BODY_FORMAT_VERSION_BLOCK_TREE;
    const initialNorm = normalizeDocBodyJson(rawBody);
    let body = initialNorm.editorStateJSON;

    // Lazy-migrate legacy/empty bodies under the same advisory lock as
    // create/save/delete, re-reading the current row so a concurrent write
    // cannot be overwritten by a stale pre-lock snapshot.
    if (initialNorm.migrated || storedVersion !== BODY_FORMAT_VERSION_BLOCK_TREE) {
      await database.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${DOC_DERIVED_INDEX_LOCK_NS}, hashtext(${id}))`);

        const [live] = await tx
          .select({ id: megaDocs.id })
          .from(megaDocs)
          .where(and(eq(megaDocs.id, id), isNull(megaDocs.deletedAt)))
          .limit(1);
        if (!live) {
          await rebuildDerivedIndexesOnTx(tx, id, null);
          throw new MegaNotFoundError("Document", id);
        }

        const [fresh] = await tx
          .select({ bodyJson: megaContent.bodyJson, bodyFormatVersion: megaContent.bodyFormatVersion })
          .from(megaContent)
          .where(and(eq(megaContent.containerType, megaContentContainerTypes.DOC), eq(megaContent.containerId, id)))
          .limit(1);
        const freshRaw = fresh ? JSON.stringify(fresh.bodyJson) : createEmptyMegaDocumentEditorStateJSON();
        const freshVersion = fresh?.bodyFormatVersion ?? BODY_FORMAT_VERSION_BLOCK_TREE;
        const freshNorm = normalizeDocBodyJson(freshRaw);
        body = freshNorm.editorStateJSON;

        if (!freshNorm.migrated && freshVersion === BODY_FORMAT_VERSION_BLOCK_TREE) {
          return;
        }

        const now = new Date();
        const bodyEnvelope = JSON.parse(body) as Record<string, unknown>;
        await tx
          .insert(megaContent)
          .values({
            containerType: megaContentContainerTypes.DOC,
            containerId: id,
            bodyJson: bodyEnvelope,
            bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [megaContent.containerType, megaContent.containerId],
            set: {
              bodyJson: bodyEnvelope,
              bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
              updatedAt: now,
            },
          });
        await rebuildDerivedIndexesOnTx(tx, id, body);
      });
    }

    const versionRows = await database
      .select()
      .from(megaDocVersions)
      .where(eq(megaDocVersions.docId, id))
      .orderBy(desc(megaDocVersions.version));
    const authorIds = [row.authorId, ...versionRows.map(version => version.authorId)];
    const collabRows = await database
      .select({ id: megaDocCollaborators.userId })
      .from(megaDocCollaborators)
      .where(eq(megaDocCollaborators.docId, id));
    const publicUsers = await resolvePublicProfiles(database, [...authorIds, ...collabRows.map(collaborator => collaborator.id)]);
    const author = publicUsers.get(row.authorId) ?? fallbackPublicProfile(row.authorId);

    const collaborators = collabRows.length > 0
      ? collabRows.map(collaborator => publicUsers.get(collaborator.id) ?? fallbackPublicProfile(collaborator.id))
      : [author];

    const versions: DocVersion[] = versionRows.map(version => ({
      id: version.id,
      version: version.version,
      author: publicUsers.get(version.authorId) ?? author,
      createdAt: version.createdAt.toISOString(),
      summary: version.summary ?? undefined,
      body: version.snapshotRef ?? undefined,
    }));

    const trimmedActor = actorUserId?.trim();
    let starred = false;
    if (trimmedActor) {
      const [star] = await database
        .select({ id: megaDocStars.id })
        .from(megaDocStars)
        .where(and(eq(megaDocStars.docId, id), eq(megaDocStars.userId, trimmedActor)))
        .limit(1);
      starred = Boolean(star);
    }

    const commentCount = await countDocComments(database, id);

    return {
      id: row.id,
      title: row.title,
      body,
      excerpt: row.excerpt ?? "",
      author,
      collaborators,
      tags: [],
      folderId: row.folderId ?? undefined,
      linkedCLs: [],
      linkedIssues: [],
      versions,
      starred,
      preview: [],
      status: statusFromRow(row.status),
      canEdit: (await acl.canWrite(id, actorUserId)).allow,
      viewCount: row.viewCount,
      commentCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function listDocs(actorUserId: string | null | undefined): Promise<Doc[]> {
    const rows = await database
      .select({ id: megaDocs.id })
      .from(megaDocs)
      .where(isNull(megaDocs.deletedAt))
      .orderBy(desc(megaDocs.updatedAt));
    const readableIds: string[] = [];
    for (const row of rows) {
      if ((await acl.canRead(row.id, actorUserId)).allow) readableIds.push(row.id);
    }
    return Promise.all(readableIds.map((id) => loadDoc(id, actorUserId)));
  }

  async function getDoc(id: string, actorUserId: string | null | undefined): Promise<Doc> {
    await acl.assert(id, actorUserId, "read");
    return loadDoc(id, actorUserId);
  }

  async function createDoc(input: CreateDocInput, actorUserId: string | null | undefined): Promise<Doc> {
    const author = actorUserId?.trim();
    if (!author) throw new MegaUnauthorizedError("A signed-in session is required");
    validateDocTitle(input.title);
    const normalizedBody = prepareWritableDocBody(input.body);
    validateDocBodyJson(normalizedBody);

    const title = input.title.trim();
    const excerpt = input.excerpt?.trim() ?? "";
    const now = new Date();
    const id = newDocId("doc");
    const versionId = newDocId("doc_version");
    const collabId = newDocId("doc_collab");
    const bodyEnvelope = JSON.parse(normalizedBody) as Record<string, unknown>;

    try {
      await database.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${DOC_DERIVED_INDEX_LOCK_NS}, hashtext(${id}))`);
        await tx.insert(megaDocs).values({
          id,
          title,
          folderId: input.folderId ?? null,
          excerpt,
          authorId: author,
          status: megaDocStatus.DRAFT,
          viewCount: 0,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(megaContent).values({
          containerType: megaContentContainerTypes.DOC,
          containerId: id,
          bodyJson: bodyEnvelope,
          bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(megaDocVersions).values({
          id: versionId,
          docId: id,
          version: 1,
          authorId: author,
          summary: "Created document",
          snapshotRef: normalizedBody,
          createdAt: now,
        });
        await tx.insert(megaDocCollaborators).values({
          id: collabId,
          docId: id,
          userId: author,
          role: megaDocCollaboratorRoles.OWNER,
          createdAt: now,
          updatedAt: now,
        });
        await rebuildDerivedIndexesOnTx(tx, id, normalizedBody);
      });
    } catch (error) {
      if (isPgUniqueViolation(error)) throw new MegaTitleConflictError(title);
      throw error;
    }

    return loadDoc(id, author);
  }

  /** CE-30 empty-doc create (used by `[[wikilink]]` resolve-or-create). */
  async function createEmptyDoc(
    input: Omit<CreateDocInput, "body">,
    actorUserId: string | null | undefined,
  ): Promise<Doc> {
    return createDoc({ ...input, body: createEmptyMegaDocumentEditorStateJSON() }, actorUserId);
  }

  /**
   * DC-03/DC-05 save split: without `summary` this is the debounced autosave
   * (content only, no version); with `summary` it snapshots a new version.
   * Concurrent saves that both supply `summary` race on the
   * `(doc_id, version)` unique index — the loser gets `MegaConflictError`,
   * never a silently dropped version.
   *
   * P0 lost-update fix: the `megaDocs` row is locked with `FOR UPDATE` before
   * anything is read or written, and every write only touches the fields the
   * caller actually supplied. A title-only save can no longer race a
   * concurrent body-only save and revert it (or vice versa) by rewriting a
   * pre-transaction snapshot of the field it didn't intend to change.
   */
  async function saveDoc(
    id: string,
    input: SaveDocInput,
    actorUserId: string | null | undefined,
    publicationStatus?: NonNullable<Doc["status"]>,
  ): Promise<Doc> {
    await acl.assert(id, actorUserId, "write");
    if (input.title !== undefined) validateDocTitle(input.title);
    const normalizedBody = input.body !== undefined ? prepareWritableDocBody(input.body) : undefined;
    if (normalizedBody !== undefined) validateDocBodyJson(normalizedBody);
    if (input.summary !== undefined) validateDocSummary(input.summary);

    const nextTitle = input.title !== undefined ? input.title.trim() : undefined;
    const nextExcerpt = input.excerpt !== undefined ? input.excerpt.trim() : undefined;
    const now = new Date();
    const bodyChanged = normalizedBody !== undefined;

    try {
      await database.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${DOC_DERIVED_INDEX_LOCK_NS}, hashtext(${id}))`);
        const [lockedDoc] = await tx
          .select({ id: megaDocs.id, status: megaDocs.status })
          .from(megaDocs)
          .where(and(eq(megaDocs.id, id), isNull(megaDocs.deletedAt)))
          .for("update")
          .limit(1);
        if (!lockedDoc) throw new MegaNotFoundError("Document", id);

        // Duplicate publication requests are idempotent under the same row lock.
        const summary = publicationStatus === "published" && statusFromRow(lockedDoc.status) !== "published"
          ? "Published document" : input.summary;
        const docUpdateSet: { updatedAt: Date; title?: string; excerpt?: string; status?: string } = { updatedAt: now };
        if (publicationStatus !== undefined) docUpdateSet.status = publicationStatus;
        if (nextTitle !== undefined) docUpdateSet.title = nextTitle;
        if (nextExcerpt !== undefined) docUpdateSet.excerpt = nextExcerpt;
        await tx
          .update(megaDocs)
          .set(docUpdateSet)
          .where(and(eq(megaDocs.id, id), isNull(megaDocs.deletedAt)));

        if (bodyChanged) {
          const bodyEnvelope = JSON.parse(normalizedBody as string) as Record<string, unknown>;
          await tx
            .insert(megaContent)
            .values({
              containerType: megaContentContainerTypes.DOC,
              containerId: id,
              bodyJson: bodyEnvelope,
              bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [megaContent.containerType, megaContent.containerId],
              set: {
                bodyJson: bodyEnvelope,
                bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
                updatedAt: now,
              },
            });
          await rebuildDerivedIndexesOnTx(tx, id, normalizedBody as string);
        }

        if (summary !== undefined) {
          // `summary` can be set without `body` (e.g. renaming a version's
          // label on the current content) — re-read the *current* body
          // inside the locked tx only to populate `snapshotRef`; never
          // rewrite `megaContent` with it.
          let snapshotRef = normalizedBody;
          if (snapshotRef === undefined) {
            const [currentContent] = await tx
              .select({ bodyJson: megaContent.bodyJson })
              .from(megaContent)
              .where(and(eq(megaContent.containerType, megaContentContainerTypes.DOC), eq(megaContent.containerId, id)))
              .limit(1);
            snapshotRef = currentContent
              ? JSON.stringify(currentContent.bodyJson)
              : createEmptyMegaDocumentEditorStateJSON();
          }

          const [maxRow] = await tx
            .select({ version: megaDocVersions.version })
            .from(megaDocVersions)
            .where(eq(megaDocVersions.docId, id))
            .orderBy(desc(megaDocVersions.version))
            .limit(1);
          const nextVersion = (maxRow?.version ?? 0) + 1;
          try {
            await tx.insert(megaDocVersions).values({
              id: newDocId("doc_version"),
              docId: id,
              version: nextVersion,
              authorId: (actorUserId as string).trim(),
              summary: summary.trim(),
              snapshotRef,
              createdAt: now,
            });
          } catch (error) {
            if (isPgUniqueViolation(error)) {
              throw new MegaConflictError(`Document version conflict: ${id}@${nextVersion}`);
            }
            throw error;
          }
        }
      });
    } catch (error) {
      if (error instanceof MegaConflictError || error instanceof MegaNotFoundError) throw error;
      if (isPgUniqueViolation(error)) throw new MegaTitleConflictError(nextTitle ?? id);
      throw error;
    }

    return loadDoc(id, actorUserId);
  }

  /** Rename is a title-only save; the `(doc_id)` title-unique index enforces conflicts. */
  async function renameDoc(id: string, title: string, actorUserId: string | null | undefined): Promise<Doc> {
    return saveDoc(id, { title }, actorUserId);
  }

  async function updateDocMeta(
    id: string,
    input: UpdateDocMetaInput,
    actorUserId: string | null | undefined,
  ): Promise<Doc> {
    await acl.assert(id, actorUserId, "write");
    if (input.status === undefined) return loadDoc(id, actorUserId);
    return saveDoc(id, {}, actorUserId, input.status);
  }

  /**
   * P2→fixed: the read-then-write toggle raced two concurrent calls for the
   * same (docId, userId) into a raw `mega_doc_stars_user_doc_uidx` violation.
   * Now the read/write pair runs in one transaction, and the insert uses
   * `onConflictDoNothing` (targeting that same unique index) so a concurrent
   * toggle that already created the star row is treated as toggle success —
   * the star exists either way — instead of leaking a raw PG unique
   * violation. (A `try`/`catch` around a plain `insert` would not work here:
   * once Postgres raises inside a transaction, every later statement in that
   * same transaction fails with "current transaction is aborted" even if the
   * error is caught in JS — `onConflictDoNothing` avoids the error entirely.)
   */
  async function toggleDocStar(id: string, actorUserId: string | null | undefined): Promise<Doc> {
    await acl.assert(id, actorUserId, "read");
    const uid = (actorUserId as string).trim();
    const now = new Date();

    await database.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: megaDocStars.id })
        .from(megaDocStars)
        .where(and(eq(megaDocStars.docId, id), eq(megaDocStars.userId, uid)))
        .limit(1);

      if (existing) {
        await tx.delete(megaDocStars).where(eq(megaDocStars.id, existing.id));
      } else {
        await tx
          .insert(megaDocStars)
          .values({ id: newDocId("doc_star"), docId: id, userId: uid, createdAt: now })
          .onConflictDoNothing({ target: [megaDocStars.userId, megaDocStars.docId] });
      }

      await tx
        .update(megaDocs)
        .set({ updatedAt: now })
        .where(and(eq(megaDocs.id, id), isNull(megaDocs.deletedAt)));
    });

    return loadDoc(id, actorUserId);
  }

  async function deleteDoc(id: string, actorUserId: string | null | undefined): Promise<void> {
    await acl.assert(id, actorUserId, "manage");
    // Soft-delete + index clear share the derived-index advisory lock so a
    // concurrent body save cannot re-insert rows for a deleted doc.
    await database.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${DOC_DERIVED_INDEX_LOCK_NS}, hashtext(${id}))`);
      const result = await tx
        .update(megaDocs)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(megaDocs.id, id), isNull(megaDocs.deletedAt)))
        .returning({ id: megaDocs.id });
      if (!result.length) throw new MegaNotFoundError("Document", id);
      await rebuildDerivedIndexesOnTx(tx, id, null);
    });
  }

  async function registerDocView(id: string, actorUserId: string | null | undefined): Promise<Doc> {
    await acl.assert(id, actorUserId, "read");
    await database
      .update(megaDocs)
      .set({ viewCount: sql`${megaDocs.viewCount} + 1`, updatedAt: new Date() })
      .where(and(eq(megaDocs.id, id), isNull(megaDocs.deletedAt)));
    return loadDoc(id, actorUserId);
  }

  return {
    listDocs,
    getDoc,
    createDoc,
    createEmptyDoc,
    saveDoc,
    renameDoc,
    updateDocMeta,
    toggleDocStar,
    deleteDoc,
    registerDocView,
    listDocComments: (docId: string, actorUserId: string | null | undefined) =>
      listDocComments(database, acl, docId, actorUserId),
    addDocComment: (docId: string, body: string, actorUserId: string | null | undefined) =>
      addDocComment(database, acl, docId, body, actorUserId),
  };
}

export type DocsService = ReturnType<typeof createDocsService>;
