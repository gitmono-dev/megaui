// megaui:libs/mega/services/repos/cls-repo.ts@0ff3a9d (loadClContent / writeClEnvelope / asEnvelope)
//
// Shared read/write helper for the CL content envelope
// (`mega_content(container_type='cl')`). EG-05's `saveCLDescription`
// (`cls.ts`) already preserves unrecognized envelope keys — namely the
// `checksView` / `dependencyView` keys this module's callers (checks.ts /
// deps.ts) own — on every description write. This module is the
// counterpart used by those two attachment files so neither duplicates the
// `mega_content` upsert dance.
import { and, eq } from "drizzle-orm";
import { megaContent, megaContentContainerTypes, type Database } from "@megaui/database";
import { BODY_FORMAT_VERSION_BLOCK_TREE } from "../docs/body-format";

export function asEnvelope(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export async function loadClEnvelope(database: Database, clId: string): Promise<Record<string, unknown>> {
  const [content] = await database
    .select({ bodyJson: megaContent.bodyJson })
    .from(megaContent)
    .where(and(eq(megaContent.containerType, megaContentContainerTypes.CL), eq(megaContent.containerId, clId)))
    .limit(1);
  return asEnvelope(content?.bodyJson);
}

export async function writeClEnvelope(
  database: Database,
  clId: string,
  envelope: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await database
    .insert(megaContent)
    .values({
      containerType: megaContentContainerTypes.CL,
      containerId: clId,
      bodyJson: envelope,
      bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [megaContent.containerType, megaContent.containerId],
      set: { bodyJson: envelope, bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE, updatedAt: now },
    });
}
