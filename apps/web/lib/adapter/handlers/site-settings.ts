// megaui-only: workspace settings managed from the admin settings page.
//
// Routes (all behind the BFF session guard):
// - GET  code-readme        → the Code root README for every signed-in reader.
// - GET  admin/me           → whether mega2 lists the caller in its admin group.
// - PUT  admin/code-readme  → admin-only write of the Code root README.
//
// The README lives in megaui's own database: mega2 never lands product writes on
// `/`, so a root README.md in the monorepo could not be edited (ADR-FU-06).

import { MegaUnauthorizedError } from "@megaui/engine";
import { z } from "zod";

import { resolveWebActor } from "@/lib/enterprise-session";
import { getSiteSettingsDomain } from "@/lib/engine";
import { markdownToProseBlocks } from "../markdown-to-prose";
import { getMega2AdminStatus, requireMega2Admin } from "../mega2/admin";
import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { only } from "./shared";

const updateCodeReadmeSchema = z.object({ markdown: z.string() }).strict();

async function readCodeReadme() {
  const setting = await getSiteSettingsDomain().siteSettings.getCodeReadme();
  return { ...setting, blocks: markdownToProseBlocks(setting.markdown) };
}

registerMegaRoute({
  match: (method, segments) => method === "GET" && only(segments, ["code-readme"]),
  handle: async () => readCodeReadme(),
});

registerMegaRoute({
  match: (method, segments) => method === "GET" && only(segments, ["admin", "me"]),
  handle: async (context: MegaDispatchContext) => getMega2AdminStatus(context.headers),
});

registerMegaRoute({
  match: (method, segments) => method === "PUT" && only(segments, ["admin", "code-readme"]),
  handle: async (context: MegaDispatchContext) => {
    const actor = await resolveWebActor(context.headers);
    if (!actor) throw new MegaUnauthorizedError("A signed-in session is required");
    // Validate the body before asking mega2, so malformed input never reaches it.
    const input = updateCodeReadmeSchema.parse(context.body ?? {});
    await requireMega2Admin(context.headers);
    await getSiteSettingsDomain().siteSettings.setCodeReadme({
      markdown: input.markdown,
      actorUserId: actor.userId,
    });
    return readCodeReadme();
  },
});
