// megaui-only (Roam inline block references): resolves through the ACL-protected
// embed service and block index; there is no corresponding upstream resolver.
import { and, eq } from "drizzle-orm";
import { megaContentBlocks, megaContentContainerTypes, type Database } from "@megaui/database";
import type { BlockRefValue } from "@megaui/content";
import type { AclService } from "../acl";
import { resolveEmbed } from "./embed";

type InlineNode = { type?: string; text?: string; children?: InlineNode[]; ref?: { targetTitle?: string }; blockRef?: { label?: string } };

function inlineText(node: InlineNode): string {
  if (node.type === "mega-block") return "";
  if (typeof node.text === "string") return node.text;
  if (node.ref?.targetTitle) return `[[${node.ref.targetTitle}]]`;
  if (node.blockRef?.label) return node.blockRef.label;
  return (node.children ?? []).map(inlineText).join("");
}

/** Plain ((ID)) can cross documents, but ambiguous IDs never choose an arbitrary source. */
export async function resolveBlockReference(
  database: Database, acl: AclService, blockId: string, docHint: string, actorUserId: string | null | undefined, exactDoc = false,
): Promise<BlockRefValue> {
  const unresolved: BlockRefValue = { targetDocId: docHint || "unresolved", targetBlockId: blockId, label: `((${blockId}))`, status: "unresolved" };
  const resolve = async (docId: string): Promise<BlockRefValue | null> => {
    const result = await resolveEmbed(database, acl, docId, blockId, actorUserId);
    if (result.access !== "ok" || result.status !== "ok" || !result.snapshotBody) return null;
    const body = JSON.parse(result.snapshotBody) as { root: { children: InlineNode[] } };
    const label = (body.root.children[0]?.children ?? []).map(inlineText).join("");
    return { targetDocId: docId, targetBlockId: blockId, label: label || `((${blockId}))`, status: "ok" };
  };
  if (docHint) {
    const preferred = await resolve(docHint);
    if (preferred) return preferred;
    if (exactDoc) return unresolved;
  }
  const candidates = await database.select({ docId: megaContentBlocks.sourceId }).from(megaContentBlocks)
    .where(and(eq(megaContentBlocks.sourceType, megaContentContainerTypes.DOC), eq(megaContentBlocks.blockId, blockId))).limit(33);
  if (candidates.length > 32) return unresolved;
  let found: BlockRefValue | null = null;
  for (const { docId } of candidates) {
    if (docId === docHint) continue;
    const candidate = await resolve(docId);
    if (!candidate) continue;
    if (found) return unresolved;
    found = candidate;
  }
  return found ?? unresolved;
}
