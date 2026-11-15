// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (cls segments)
//
// Diff vs upstream (GC-03 / WA-04 + WA-09):
// - Attachments/revisions/checks via `createClsDomain` (EG-06).
// - WA-09: `GET cls/[n]/commits` resolves `mega_cls.link` → EG-11 `fetchClCommits`
//   (empty array when link is unset; 404 when CL number missing).

import { eq } from "drizzle-orm";
import { getDb, megaCls } from "@megaui/database";
import { fetchClCommits } from "@megaui/engine";
import { z } from "zod";

import { getClsDomain } from "@/lib/engine";
import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { resolveActorUserId } from "../session";
import {
  clStateSchema,
  filterSchema,
  invalidRoute,
  only,
  readJsonQuery,
  segmentNumber,
  segmentText,
} from "./shared";

async function dispatchClsGet(context: MegaDispatchContext): Promise<unknown> {
  const { segments, searchParams, headers } = context;
  const actorUserId = await resolveActorUserId(headers);
  const { cls } = getClsDomain();

  if (only(segments, ["cls"])) {
    return cls.listCLs(
      filterSchema.parse(readJsonQuery(searchParams.get("filter"), {})),
      actorUserId,
    );
  }
  if (segments[0] === "cls" && segments[2] === "description" && segments.length === 3) {
    return cls.getCLDescription(segmentNumber(segments[1]));
  }
  if (segments[0] === "cls" && segments[2] === "commits" && segments.length === 3) {
    const number = segmentNumber(segments[1]);
    // Ensure the CL exists (404) before looking up the mega2 link.
    await cls.getCL(number);
    const database = getDb();
    const [row] = await database
      .select({ link: megaCls.link })
      .from(megaCls)
      .where(eq(megaCls.number, number))
      .limit(1);
    const link = row?.link?.trim();
    if (!link) return [];
    return fetchClCommits(link, { headers });
  }
  if (segments[0] === "cls" && segments.length === 2) {
    return cls.getCL(segmentNumber(segments[1]));
  }
  if (segments[0] === "cls" && segments[2] === "inline-comments" && segments.length === 3) {
    return cls.listInlineComments(segmentNumber(segments[1]));
  }
  if (segments[0] === "cls" && segments[2] === "comments" && segments.length === 3) {
    return cls.listCLComments(segmentNumber(segments[1]));
  }
  if (segments[0] === "cls" && segments[2] === "checks" && segments.length === 3) {
    return cls.getCLChecks(segmentNumber(segments[1]));
  }
  if (segments[0] === "cls" && segments[2] === "dependency-graph" && segments.length === 3) {
    return cls.getCLDependencyGraph(segmentNumber(segments[1]));
  }

  return invalidRoute(segments);
}

async function dispatchClsPost(context: MegaDispatchContext): Promise<unknown> {
  const { segments, body, headers } = context;
  const actorUserId = await resolveActorUserId(headers);
  const { cls } = getClsDomain();

  if (segments[0] === "cls" && segments[2] === "viewed" && segments.length === 3) {
    const input = z
      .object({ path: z.string().trim().min(1), viewed: z.boolean() })
      .parse(body);
    return cls.setCLFileViewed(
      segmentNumber(segments[1]),
      input.path,
      input.viewed,
      actorUserId,
    );
  }
  if (segments[0] === "cls" && segments[2] === "description" && segments.length === 3) {
    const descriptionBody = z.object({ body: z.string().trim().min(1) }).parse(body).body;
    return cls.saveCLDescription(segmentNumber(segments[1]), descriptionBody, actorUserId);
  }
  if (segments[0] === "cls" && segments[2] === "inline-comments" && segments.length === 3) {
    const clNumber = segmentNumber(segments[1]);
    const input = z
      .object({
        filePath: z.string().trim().min(1),
        line: z.number().int().positive(),
        body: z.string().trim().min(1),
        side: z.enum(["additions", "deletions"]).optional(),
      })
      .parse(body);
    return cls.addInlineComment(clNumber, input, actorUserId);
  }
  if (
    segments[0] === "cls" &&
    segments[2] === "inline-comments" &&
    segments[4] === "reply" &&
    segments.length === 5
  ) {
    const parentId = segmentText(segments[3]);
    const replyBody = z.object({ body: z.string().trim().min(1) }).parse(body).body;
    return cls.replyInlineComment(parentId, replyBody, actorUserId);
  }
  if (
    segments[0] === "cls" &&
    segments[2] === "inline-comments" &&
    segments[4] === "resolve" &&
    segments.length === 5
  ) {
    return cls.resolveInlineComment(segmentText(segments[3]), actorUserId);
  }
  if (segments[0] === "cls" && segments[2] === "transition" && segments.length === 3) {
    const state = z.object({ state: clStateSchema }).parse(body).state;
    return cls.transitionCLState(segmentNumber(segments[1]), state, actorUserId);
  }
  if (only(segments, ["cls"])) {
    return cls.createCL(
      z
        .object({
          title: z.string().trim().min(1),
          packageId: z.string().trim().min(1),
          branch: z.string().trim().min(1),
        })
        .parse(body),
      actorUserId,
    );
  }
  if (segments[0] === "cls" && segments[2] === "subscribe" && segments.length === 3) {
    return cls.toggleCLSubscription(segmentNumber(segments[1]), actorUserId);
  }
  if (segments[0] === "cls" && segments[2] === "comments" && segments.length === 3) {
    const clNumber = segmentNumber(segments[1]);
    const commentBody = z.object({ body: z.string().trim().min(1) }).parse(body).body;
    return cls.addCLComment(clNumber, commentBody, actorUserId);
  }

  return invalidRoute(segments);
}

registerMegaRoute({
  match: (_method, segments) => segments[0] === "cls",
  handle: async (context) => {
    switch (context.method) {
      case "GET":
        return dispatchClsGet(context);
      case "POST":
        return dispatchClsPost(context);
      default:
        return invalidRoute(context.segments);
    }
  },
});
