// megaui:libs/mega/services/docs.ts@0ff3a9d
// megaui:libs/mega/services/repos/docs-repo.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on ADR-DC-01 / DC-01):
// - No mock/store backend (DEBT-04). Drizzle PG is the only implementation.
// - Body is plain text in `mega_content.body_json = { text }`
//   (`container_type=doc_comment`), not Lexical editor-state JSON
//   (DEBT-DC-01). No comment link/block index rebuild (DEFER-DC-04).
// - list/add both `acl.assert(docId, actor, "read")`. Viewer may add.
//   Soft-deleted docs are MegaNotFoundError after ACL, matching `getDoc`.
// - `commentCount` is COUNT, not a denormalized column. No
//   `mega_docs.updatedAt` bump. Reactions stay `[]`.
import { randomUUID } from "node:crypto";
import type { DocComment } from "@megaui/core";
import {
  megaContent,
  megaContentContainerTypes,
  megaDocComments,
  megaDocs,
  type Database,
} from "@megaui/database";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { MegaBadRequestError, MegaNotFoundError, MegaUnauthorizedError } from "../../errors";
import type { AclService } from "../acl";
import { fallbackPublicProfile, resolvePublicProfiles } from "../public-profile";

function newCommentId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function unpackPlainBody(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const text = (raw as { text?: unknown }).text;
  return typeof text === "string" && text.length > 0 ? text : undefined;
}

async function readPlainBody(
  database: Database,
  containerType: string,
  containerId: string,
): Promise<string | undefined> {
  const [row] = await database
    .select({ bodyJson: megaContent.bodyJson })
    .from(megaContent)
    .where(and(eq(megaContent.containerType, containerType), eq(megaContent.containerId, containerId)))
    .limit(1);
  return row ? unpackPlainBody(row.bodyJson) : undefined;
}

async function upsertPlainBody(
  tx: Database,
  containerType: string,
  containerId: string,
  text: string,
  now: Date,
): Promise<void> {
  await tx
    .insert(megaContent)
    .values({
      containerType,
      containerId,
      bodyJson: { text },
      bodyFormatVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [megaContent.containerType, megaContent.containerId],
      set: { bodyJson: { text }, updatedAt: now },
    });
}

async function assertLiveDocument(database: Database, docId: string): Promise<void> {
  const [row] = await database
    .select({ id: megaDocs.id })
    .from(megaDocs)
    .where(and(eq(megaDocs.id, docId), isNull(megaDocs.deletedAt)))
    .limit(1);
  if (!row) throw new MegaNotFoundError("Document", docId);
}

export async function countDocComments(database: Database, docId: string): Promise<number> {
  const [row] = await database
    .select({ value: count() })
    .from(megaDocComments)
    .where(eq(megaDocComments.docId, docId));
  return Number(row?.value ?? 0);
}

export async function listDocComments(
  database: Database,
  acl: AclService,
  docId: string,
  actorUserId: string | null | undefined,
): Promise<DocComment[]> {
  await acl.assert(docId, actorUserId, "read");
  await assertLiveDocument(database, docId);

  const rows = await database
    .select()
    .from(megaDocComments)
    .where(eq(megaDocComments.docId, docId))
    .orderBy(asc(megaDocComments.createdAt));

  return Promise.all(
    rows.map(async (row) => {
      const publicUsers = await resolvePublicProfiles(database, [row.authorId]);
      const author = publicUsers.get(row.authorId) ?? fallbackPublicProfile(row.authorId);
      const body = (await readPlainBody(database, megaContentContainerTypes.DOC_COMMENT, row.id)) ?? "";
      return {
        id: row.id,
        docId: row.docId,
        author,
        body,
        createdAt: row.createdAt.toISOString(),
        reactions: [],
      } satisfies DocComment;
    }),
  );
}

export async function addDocComment(
  database: Database,
  acl: AclService,
  docId: string,
  body: string,
  actorUserId: string | null | undefined,
): Promise<DocComment> {
  await acl.assert(docId, actorUserId, "read");
  await assertLiveDocument(database, docId);

  const trimmedBody = body.trim();
  if (!trimmedBody) throw new MegaBadRequestError("Document comment body is required");

  const authorId = actorUserId?.trim();
  if (!authorId) {
    // INVARIANT: acl.assert("read") already rejected anonymous/blank actors.
    throw new MegaUnauthorizedError("A signed-in session is required");
  }
  const now = new Date();
  const id = newCommentId("doc_comment");

  await database.transaction(async (tx) => {
    await tx.insert(megaDocComments).values({
      id,
      docId,
      authorId,
      reactions: [],
      createdAt: now,
    });
    await upsertPlainBody(tx, megaContentContainerTypes.DOC_COMMENT, id, trimmedBody, now);
  });

  const publicUsers = await resolvePublicProfiles(database, [authorId]);
  const author = publicUsers.get(authorId) ?? fallbackPublicProfile(authorId);

  return {
    id,
    docId,
    author,
    body: trimmedBody,
    createdAt: now.toISOString(),
    reactions: [],
  };
}
