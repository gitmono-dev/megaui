// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (code-tree / root-entries / source-file / readme)
//
// Diff vs upstream (GC-03 / WA-08):
// - Fail-closed via EG-11 (no mock backend selector).
// - Workspace soft fallback stays in handlers/home.ts for the home shell only.

import { z } from "zod";

import {
  getCodeTree,
  getReadmeBlocks,
  getRootEntries,
  getSourceFile,
} from "@/lib/adapter/code";
import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { only } from "./shared";

const nonEmptyPath = z.string().trim().min(1);

registerMegaRoute({
  match: (method, segments) => method === "GET" && only(segments, ["root-entries"]),
  handle: async (context: MegaDispatchContext) => getRootEntries(context.headers),
});

registerMegaRoute({
  match: (method, segments) => method === "GET" && only(segments, ["code-tree"]),
  handle: async (context: MegaDispatchContext) => {
    const path = context.searchParams.get("path") ?? undefined;
    return getCodeTree(path || undefined, context.headers);
  },
});

registerMegaRoute({
  match: (method, segments) => method === "GET" && only(segments, ["source-file"]),
  handle: async (context: MegaDispatchContext) => {
    const path = nonEmptyPath.parse(context.searchParams.get("path") ?? "");
    return getSourceFile(path, context.headers);
  },
});

registerMegaRoute({
  match: (method, segments) => method === "GET" && only(segments, ["readme"]),
  handle: async (context: MegaDispatchContext) => {
    const path = context.searchParams.get("path") ?? undefined;
    return getReadmeBlocks(path || undefined, context.headers);
  },
});
