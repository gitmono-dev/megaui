// megaui:libs/mega/services/types.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-03 task card):
// - Scoped to the docs-domain input/output shapes this card implements
//   (CRUD/rename/versions/stars/backlinks/embeds/blocks). The home/search/
//   agent/chat shapes from the upstream `types.ts` barrel belong to later
//   EG-* cards.
// - `CreateDocInput` / `UpdateDocMetaInput` drop `tagIds`: megaui has not
//   ported a doc-tag catalog (upstream `DOC_TAGS` fixture) yet, so tags
//   stay unmodeled until that lands (registered omission on this card).
export interface CreateDocInput {
  title: string;
  /** Serialized Lexical EditorState JSON (`@megaui/content` empty-doc shape). */
  body: string;
  excerpt?: string;
  folderId?: string;
}

export interface SaveDocInput {
  title?: string;
  body?: string;
  excerpt?: string;
  /** Presence of `summary` is the DC-03/DC-05 signal to snapshot a new version. */
  summary?: string;
}

export interface UpdateDocMetaInput {
  status?: "draft" | "published";
}

export type BacklinkTargetKind = "doc" | "issue" | "cl";

export interface BacklinkItem {
  sourceType: string;
  sourceId: string;
  sourceTitle: string;
  contextSummary: string | null;
  createdAt: string;
  href: string;
  /** CE-51: set when this backlink targets a block on the current doc. */
  targetBlockId?: string;
  targetBlockSummary?: string;
}

export type UnlinkedTargetKind = "doc" | "issue" | "cl";

export interface UnlinkedItem {
  kind: UnlinkedTargetKind;
  targetTitle: string;
  targetId: string;
}

export interface ResolveOrCreateResult {
  targetId: string;
  title: string;
  created: boolean;
}
