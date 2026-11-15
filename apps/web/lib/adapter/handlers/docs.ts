// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (docs + links/embed/graph segments)
//
// Diff vs upstream (GC-03 / WA-04):
// - ACL enforced only in `@megaui/engine`; no route-layer `canRead`/`canWrite`.
// - Doc comments list+create via `domain.docs` (ADR-DC-01 / DC-02);
//   edit/delete/reactions, collaborators, and block search remain omitted.

import { getDb } from "@megaui/database";
import { BLOCK_ID_PATTERN } from "@megaui/core";
import {
  countReadableBlockReferences,
  getContentLinkGraph,
  getTitleIndex,
  listBacklinks,
  listDocBacklinks,
  listDocUnlinked,
  MegaUnauthorizedError,
  resolveEmbed,
  resolveBlockReference,
  resolveOrCreateDoc,
} from "@megaui/engine";
import { z } from "zod";

import { getDocsDomain } from "@/lib/engine";
import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { resolveActorUserId } from "../session";
import {
  backlinkTargetKindSchema,
  createDocSchema,
  invalidRoute,
  only,
  readJsonQuery,
  saveDocSchema,
  segmentText,
} from "./shared";

async function dispatchDocsGet(context: MegaDispatchContext): Promise<unknown> {
  const { segments, searchParams, headers } = context;
  const actorUserId = await resolveActorUserId(headers);
  const domain = getDocsDomain();
  const database = getDb();

  if (only(segments, ["docs"])) {
    return domain.docs.listDocs(actorUserId);
  }
  if (only(segments, ["docs", "title-index"])) {
    return getTitleIndex(database, domain.acl, actorUserId);
  }
  if (segments[0] === "docs" && segments[2] === "backlinks" && segments.length === 3) {
    const docId = segmentText(segments[1]);
    return listDocBacklinks(
      database,
      domain.linksRepo,
      domain.blocksRepo,
      domain.acl,
      docId,
      actorUserId,
    );
  }
  if (segments[0] === "docs" && segments[2] === "comments" && segments.length === 3) {
    return domain.docs.listDocComments(segmentText(segments[1]), actorUserId);
  }
  if (segments[0] === "docs" && segments[2] === "unlinked" && segments.length === 3) {
    const docId = segmentText(segments[1]);
    const doc = await domain.docs.getDoc(docId, actorUserId);
    return listDocUnlinked(database, domain.acl, doc.body, docId, actorUserId);
  }
  if (segments[0] === "docs" && segments.length === 2) {
    return domain.docs.getDoc(segmentText(segments[1]), actorUserId);
  }
  if (only(segments, ["links", "backlinks"])) {
    const kind = backlinkTargetKindSchema.parse(searchParams.get("kind"));
    const id = segmentText(searchParams.get("id") ?? undefined);
    return listBacklinks(
      database,
      domain.linksRepo,
      domain.blocksRepo,
      domain.acl,
      kind,
      id,
      actorUserId,
    );
  }
  if (only(segments, ["embed", "resolve"])) {
    const blockParam = searchParams.get("block");
    const docId = segmentText(searchParams.get("doc") ?? undefined);
    const resolved = await resolveEmbed(
      database,
      domain.acl,
      docId,
      blockParam && blockParam.trim() ? z.string().trim().regex(BLOCK_ID_PATTERN).parse(blockParam) : null,
      actorUserId,
    );
    if (resolved.status !== "ok" || !resolved.blockId) return resolved;
    const referenceCount = await countReadableBlockReferences(
      database, domain.linksRepo, domain.acl, resolved.docId, resolved.blockId, actorUserId,
    );
    return { ...resolved, referenceCount };
  }
  if (only(segments, ["blocks", "resolve"])) {
    const blockId = z.string().trim().regex(BLOCK_ID_PATTERN).parse(searchParams.get("block"));
    const docHint = z.string().trim().max(256).parse(searchParams.get("doc") ?? "");
    const exactDoc = z.enum(["true", "false"]).parse(searchParams.get("exact") ?? "false") === "true";
    return resolveBlockReference(database, domain.acl, blockId, docHint, actorUserId, exactDoc);
  }
  if (only(segments, ["graph"])) {
    return getContentLinkGraph(database, domain.acl, actorUserId);
  }

  return invalidRoute(segments);
}

async function dispatchDocsPost(context: MegaDispatchContext): Promise<unknown> {
  const { segments, body, headers } = context;
  const actorUserId = await resolveActorUserId(headers);
  const domain = getDocsDomain();
  const database = getDb();

  if (only(segments, ["docs", "resolve-or-create"])) {
    const input = z.object({ title: z.string().trim().min(1) }).parse(body);
    const authorId = actorUserId?.trim();
    if (!authorId) {
      throw new MegaUnauthorizedError("A signed-in session is required");
    }
    return resolveOrCreateDoc(
      database,
      domain.linksRepo,
      domain.acl,
      (createInput, userId) => domain.docs.createEmptyDoc(createInput, userId),
      input.title,
      authorId,
    );
  }
  if (only(segments, ["docs"])) {
    const { body: documentBody, ...documentInput } = createDocSchema.parse(body);
    if (documentBody === undefined) {
      return domain.docs.createEmptyDoc(documentInput, actorUserId);
    }
    return domain.docs.createDoc({ ...documentInput, body: documentBody }, actorUserId);
  }
  if (segments[0] === "docs" && segments[2] === "comments" && segments.length === 3) {
    const commentBody = z.object({ body: z.string().trim().min(1) }).parse(body).body;
    return domain.docs.addDocComment(segmentText(segments[1]), commentBody, actorUserId);
  }
  if (segments[0] === "docs" && segments[2] === "save" && segments.length === 3) {
    const docId = segmentText(segments[1]);
    return domain.docs.saveDoc(docId, saveDocSchema.parse(body), actorUserId);
  }
  if (segments[0] === "docs" && segments[2] === "rename" && segments.length === 3) {
    const input = z.object({ title: z.string().trim().min(1) }).parse(body);
    return domain.docs.renameDoc(segmentText(segments[1]), input.title, actorUserId);
  }
  if (segments[0] === "docs" && segments[2] === "toggle-star" && segments.length === 3) {
    return domain.docs.toggleDocStar(segmentText(segments[1]), actorUserId);
  }
  if (segments[0] === "docs" && segments[2] === "view" && segments.length === 3) {
    return domain.docs.registerDocView(segmentText(segments[1]), actorUserId);
  }
  if (segments[0] === "docs" && segments.length === 3 && (segments[2] === "publish" || segments[2] === "unpublish")) {
    return domain.docs.updateDocMeta(segmentText(segments[1]), {
      status: segments[2] === "publish" ? "published" : "draft",
    }, actorUserId);
  }
  if (segments[0] === "docs" && segments[2] === "meta" && segments.length === 3) {
    const input = z.object({
      tagIds: z.array(z.string().trim().min(1)).optional(),
      status: z.enum(["draft", "published"]).optional(),
    }).parse(body);
    return domain.docs.updateDocMeta(segmentText(segments[1]), input, actorUserId);
  }
  if (segments[0] === "docs" && segments[2] === "delete" && segments.length === 3) {
    await domain.docs.deleteDoc(segmentText(segments[1]), actorUserId);
    return { deleted: true };
  }

  return invalidRoute(segments);
}

function matchesDocsRoutes(method: string, segments: readonly string[]): boolean {
  if (segments.length === 0) return false;
  const head = segments[0];
  if (head === "docs") return true;
  if (method === "GET" && only(segments, ["links", "backlinks"])) return true;
  if (method === "GET" && only(segments, ["embed", "resolve"])) return true;
  if (method === "GET" && only(segments, ["blocks", "resolve"])) return true;
  if (method === "GET" && only(segments, ["graph"])) return true;
  return false;
}

registerMegaRoute({
  match: (method, segments) => matchesDocsRoutes(method, segments),
  handle: async (context) => {
    switch (context.method) {
      case "GET":
        return dispatchDocsGet(context);
      case "POST":
        return dispatchDocsPost(context);
      default:
        return invalidRoute(context.segments);
    }
  },
});
