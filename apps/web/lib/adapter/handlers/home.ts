// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (home + workspace GET)

import type { Workspace } from "@megaui/core";
import { fetchWorkspace } from "@megaui/engine";

import { getHomeDashboard } from "@/lib/adapter/home";
import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { resolveActorUserId } from "../session";
import { only } from "./shared";

const LOCAL_WORKSPACE: Workspace = {
  id: "mega",
  name: "Mega",
  description: "",
  defaultBranch: "main",
  headSha: "",
  starred: false,
  packages: [],
};

registerMegaRoute({
  match: (method, segments) => method === "GET" && only(segments, ["home"]),
  handle: async (context: MegaDispatchContext) => {
    const actorUserId = await resolveActorUserId(context.headers);
    return getHomeDashboard(actorUserId);
  },
});

registerMegaRoute({
  match: (method, segments) => method === "GET" && only(segments, ["workspace"]),
  handle: async (context: MegaDispatchContext) => {
    try {
      return await fetchWorkspace({ headers: context.headers });
    } catch {
      // Home shell needs a workspace name without live mega2 (WA-08 owns code fail-closed).
      return LOCAL_WORKSPACE;
    }
  },
});
