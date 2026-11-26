// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (home + workspace GET)

import type { Workspace } from "@megaui/core";
import { fetchWorkspace } from "@megaui/engine";

import { getHomeDashboard } from "@/lib/adapter/home";
import { getSiteName } from "@/lib/site-name";
import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { resolveActorUserId } from "../session";
import { only } from "./shared";

function localWorkspace(): Workspace {
  return {
    id: "mega",
    name: getSiteName(),
    description: "",
    defaultBranch: "main",
    headSha: "",
    starred: false,
    packages: [],
  };
}

registerMegaRoute({
  match: (method, segments) => method === "GET" && only(segments, ["home"]),
  handle: async (context: MegaDispatchContext) => {
    const actorUserId = await resolveActorUserId(context.headers);
    return getHomeDashboard(actorUserId, context.headers);
  },
});

registerMegaRoute({
  match: (method, segments) => method === "GET" && only(segments, ["workspace"]),
  handle: async (context: MegaDispatchContext) => {
    try {
      return await fetchWorkspace({ headers: context.headers });
    } catch {
      // Home shell needs a workspace name without live mega2 (WA-08 owns code fail-closed).
      return localWorkspace();
    }
  },
});
