// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (search segment)

import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { resolveActorUserId } from "../session";
import { searchWorkspace } from "../search-workspace";
import { invalidRoute, only, segmentText } from "./shared";
import { z } from "zod";

const positiveNumber = z.coerce.number().int().positive();

async function dispatchSearchGet(context: MegaDispatchContext): Promise<unknown> {
  const { segments, searchParams, headers } = context;
  const actorUserId = await resolveActorUserId(headers);

  if (only(segments, ["search"])) {
    const limitParam = searchParams.get("limit");
    const limit = limitParam === null ? undefined : positiveNumber.parse(limitParam);
    return searchWorkspace(
      segmentText(searchParams.get("q") ?? undefined),
      actorUserId,
      limit,
    );
  }

  return invalidRoute(segments);
}

registerMegaRoute({
  match: (method, segments) => method === "GET" && only(segments, ["search"]),
  handle: dispatchSearchGet,
});
