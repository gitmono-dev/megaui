// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (issues segments)
//
// Diff vs upstream (GC-03 / WA-04):
// - Issue/comment reaction POSTs persist ReactionRow via engine (RX-02 / ADR-RX-01).
// - GET getIssue / listIssueComments pass the session actor so reactedByMe matches listIssues.

import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { resolveActorUserId } from "../session";
import { getIssuesDomain } from "@/lib/engine";
import {
  createIssueSchema,
  filterSchema,
  invalidRoute,
  only,
  readJsonQuery,
  segmentNumber,
  segmentText,
} from "./shared";
import { z } from "zod";

const reactionEmojiSchema = z.object({ emoji: z.string().trim().min(1) });

async function dispatchIssuesGet(context: MegaDispatchContext): Promise<unknown> {
  const { segments, searchParams, headers } = context;
  const actorUserId = await resolveActorUserId(headers);
  const { issues } = getIssuesDomain();

  if (only(segments, ["issues"])) {
    const offsetRaw = searchParams.get("offset");
    const limitRaw = searchParams.get("limit");
    return issues.listIssues(
      {
        filter: filterSchema.parse(readJsonQuery(searchParams.get("filter"), {})),
        pagination: {
          offset: offsetRaw == null || offsetRaw === "" ? undefined : Number(offsetRaw),
          limit: limitRaw == null || limitRaw === "" ? undefined : Number(limitRaw),
        },
      },
      actorUserId,
    );
  }
  if (segments[0] === "issues" && segments.length === 2) {
    return issues.getIssue(segmentNumber(segments[1]), actorUserId);
  }
  if (segments[0] === "issues" && segments[2] === "body" && segments.length === 3) {
    return issues.getIssueBody(segmentNumber(segments[1]));
  }
  if (segments[0] === "issues" && segments[2] === "comments" && segments.length === 3) {
    return issues.listIssueComments(segmentNumber(segments[1]), actorUserId);
  }

  return invalidRoute(segments);
}

async function dispatchIssuesPost(context: MegaDispatchContext): Promise<unknown> {
  const { segments, body, headers } = context;
  const actorUserId = await resolveActorUserId(headers);
  const { issues } = getIssuesDomain();

  if (only(segments, ["issues"])) {
    return issues.createIssue(createIssueSchema.parse(body), actorUserId);
  }
  if (segments[0] === "issues" && segments[2] === "body" && segments.length === 3) {
    const issueNumber = segmentNumber(segments[1]);
    const savedBody = z.object({ body: z.string().trim().min(1) }).parse(body).body;
    return issues.saveIssueBody(issueNumber, savedBody, actorUserId);
  }
  if (segments[0] === "issues" && segments[2] === "comments" && segments.length === 3) {
    const issueNumber = segmentNumber(segments[1]);
    const commentBody = z.object({ body: z.string().trim().min(1) }).parse(body).body;
    return issues.addIssueComment(issueNumber, commentBody, actorUserId);
  }
  if (segments[0] === "issues" && segments[2] === "reactions" && segments.length === 3) {
    return issues.toggleIssueReaction(
      segmentNumber(segments[1]),
      reactionEmojiSchema.parse(body).emoji,
      actorUserId,
    );
  }
  if (segments[0] === "issue-comments" && segments[2] === "reactions" && segments.length === 3) {
    return issues.toggleIssueCommentReaction(
      segmentText(segments[1]),
      reactionEmojiSchema.parse(body).emoji,
      actorUserId,
    );
  }
  if (segments[0] === "issues" && segments[2] === "close" && segments.length === 3) {
    return issues.closeIssue(segmentNumber(segments[1]), actorUserId);
  }
  if (segments[0] === "issues" && segments[2] === "reopen" && segments.length === 3) {
    return issues.reopenIssue(segmentNumber(segments[1]), actorUserId);
  }
  if (segments[0] === "issues" && segments[2] === "watch" && segments.length === 3) {
    return issues.toggleIssueWatch(segmentNumber(segments[1]), actorUserId);
  }

  return invalidRoute(segments);
}

function matchesIssueRoutes(segments: readonly string[]): boolean {
  if (segments.length === 0) return false;
  const head = segments[0];
  return head === "issues" || head === "issue-comments";
}

registerMegaRoute({
  match: (_method, segments) => matchesIssueRoutes(segments),
  handle: async (context) => {
    switch (context.method) {
      case "GET":
        return dispatchIssuesGet(context);
      case "POST":
        return dispatchIssuesPost(context);
      default:
        return invalidRoute(context.segments);
    }
  },
});
