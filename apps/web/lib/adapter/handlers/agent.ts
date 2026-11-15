// megaui-only (WA-15): agent thread REST surface for pages (SSE stays in agent-stream).

import { z } from "zod";

import { getAgentDomain } from "@/lib/engine";
import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { resolveActorUserId } from "../session";
import { invalidRoute, only, segmentText } from "./shared";

async function dispatchAgentGet(context: MegaDispatchContext): Promise<unknown> {
  const { segments, searchParams } = context;
  const { agent } = getAgentDomain();

  if (only(segments, ["agent"])) {
    const limit = Number(searchParams.get("limit") ?? 20);
    const offset = Number(searchParams.get("offset") ?? 0);
    return agent.listThreads({
      pagination: {
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20,
        offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
      },
    });
  }

  if (segments[0] === "agent" && segments.length === 2) {
    return agent.getThread(segmentText(segments[1]));
  }

  return invalidRoute(segments);
}

async function dispatchAgentPost(context: MegaDispatchContext): Promise<unknown> {
  const { segments, body, headers } = context;
  const actorUserId = await resolveActorUserId(headers);
  const { agent } = getAgentDomain();

  if (only(segments, ["agent"])) {
    const input = z
      .object({
        title: z.string().trim().min(1).optional(),
        scopePackageId: z.string().trim().min(1).optional(),
      })
      .parse(body ?? {});
    return agent.createThread(
      { title: input.title ?? "New conversation", scopePackageId: input.scopePackageId },
      actorUserId,
    );
  }

  return invalidRoute(segments);
}

registerMegaRoute({
  match: (method, segments) =>
    segments[0] === "agent" &&
    // Leave POST agent/:id/{ask|regenerate} to maybeHandleAgentStreamPost.
    !(method === "POST" && segments.length === 3) &&
    (method === "GET" || method === "POST"),
  handle: async (context) => {
    switch (context.method) {
      case "GET":
        return dispatchAgentGet(context);
      case "POST":
        return dispatchAgentPost(context);
      default:
        return invalidRoute(context.segments);
    }
  },
});
