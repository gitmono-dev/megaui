import type { Database } from "@megaui/database";
import { createAclService, type AclService } from "../acl";
import { createBlocksRepo, type BlocksRepo } from "./blocks";
import { createDocsService, type DocsService } from "./docs";
import { createLinksRepo, type LinksRepo } from "./links";
export { resolveBlockReference } from "./block-reference";

export {
  BODY_FORMAT_VERSION_BLOCK_TREE,
  BODY_FORMAT_VERSION_LEGACY,
  normalizeDocBodyJson,
  prepareWritableDocBody,
  isRootBlockType,
  type NormalizeDocBodyResult,
} from "./body-format";
export type {
  BacklinkItem,
  BacklinkTargetKind,
  CreateDocInput,
  ResolveOrCreateResult,
  SaveDocInput,
  UnlinkedItem,
  UnlinkedTargetKind,
  UpdateDocMetaInput,
} from "./types";
export {
  MAX_DOC_BODY_BYTES,
  MAX_DOC_SUMMARY_LENGTH,
  MAX_DOC_TITLE_LENGTH,
  validateDocBodyJson,
  validateDocSummary,
  validateDocTitle,
} from "./validation";
export {
  createBlocksRepo,
  deleteBlocksForDoc,
  extractBlocksFromEditorState,
  listBlocksForDoc,
  rebuildDocBlocks,
  type BlockIndexRow,
  type BlocksRepo,
  type ExtractedContentBlock,
} from "./blocks";
export {
  createLinksRepo,
  decodeBlockTargetId,
  countReadableBlockReferences,
  deleteLinksForDoc,
  encodeBlockTargetId,
  extractRefsFromEditorState,
  getTitleIndex,
  listBacklinks,
  listDocBacklinks,
  listDocUnlinked,
  rebuildDocLinks,
  resolveOrCreateDoc,
  searchDocTitleIndex,
  type CreateEmptyDoc,
  type ExtractedContentLink,
  type LinksRepo,
  type LinkSourceRow,
  type LinkTargetRow,
} from "./links";
export {
  EMBED_MAX_DEPTH,
  extractBlockSubtreeJSON,
  extractEmbedsFromEditorState,
  resolveEmbed,
  type EmbedAccess,
  type EmbedChainEntry,
  type EmbedResolveResult,
  type EmbedResolveStatus,
} from "./embed";
export {
  getContentLinkGraph,
  type ContentGraphEdge,
  type ContentGraphEdgeKind,
  type ContentGraphNode,
  type ContentGraphNodeKind,
  type ContentLinkGraph,
} from "./content-link-graph";
export { createDocsService, type DocsService } from "./docs";

export interface DocsDomain {
  acl: AclService;
  blocksRepo: BlocksRepo;
  linksRepo: LinksRepo;
  docs: DocsService;
}

/**
 * Wires the docs-domain services against one `Database`: ACL, the
 * blocks/links repos, and the docs CRUD service (which rebuilds blocks +
 * links after every body write). `resolveOrCreateDoc` / `resolveEmbed` /
 * `getContentLinkGraph` are called directly with `(database, acl, ...)` —
 * they stay decoupled from `DocsService` to avoid a docs↔links/embed import
 * cycle (see `links.ts` / `embed.ts` header comments).
 */
export function createDocsDomain(database: Database): DocsDomain {
  const acl = createAclService(database);
  const blocksRepo = createBlocksRepo(database);
  const linksRepo = createLinksRepo(database);
  const docs = createDocsService(database, acl, blocksRepo, linksRepo);
  return { acl, blocksRepo, linksRepo, docs };
}
