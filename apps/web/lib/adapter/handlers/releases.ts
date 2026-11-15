// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (releases segments)

import { z } from "zod";

import { getReleasesDomain } from "@/lib/engine";
import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { resolveActorUserId } from "../session";
import { invalidRoute, only, segmentText } from "./shared";

async function dispatchReleasesGet(context: MegaDispatchContext): Promise<unknown> {
  const { segments } = context;
  const { releases } = getReleasesDomain();

  if (only(segments, ["releases"])) {
    return releases.listReleases();
  }
  if (segments[0] === "releases" && segments.length === 2) {
    return releases.getRelease(segmentText(segments[1]));
  }

  return invalidRoute(segments);
}

async function dispatchReleasesPost(context: MegaDispatchContext): Promise<unknown> {
  const { segments, body, headers } = context;
  const actorUserId = await resolveActorUserId(headers);
  const { releases } = getReleasesDomain();

  if (only(segments, ["releases"])) {
    const input = z.object({
      tag: z.string().trim().min(1),
      title: z.string().trim().min(1),
      targetSha: z.string().trim().min(1).optional(),
      notes: z.array(z.string()).optional(),
    }).parse(body);
    return releases.createDraftRelease(
      {
        tag: input.tag,
        title: input.title,
        targetSha: input.targetSha ?? "0000000",
        notes: input.notes,
      },
      actorUserId,
    );
  }

  if (segments[0] === "releases" && segments[2] === "publish" && segments.length === 3) {
    return releases.publishRelease(segmentText(segments[1]), actorUserId);
  }

  return invalidRoute(segments);
}

registerMegaRoute({
  match: (_method, segments) => segments[0] === "releases",
  handle: async (context) => {
    switch (context.method) {
      case "GET":
        return dispatchReleasesGet(context);
      case "POST":
        return dispatchReleasesPost(context);
      default:
        return invalidRoute(context.segments);
    }
  },
});
