/**
 * megaui:libs/react-shared/components/mega/content/preset.ts@0ff3a9d
 *
 * Ported with one intentional diff (ADR-ARCH-01 continuation): upstream's `document` preset
 * pulls its node list from a sibling `./nodes.ts` aggregator (`MEGA_CONTENT_NODES` = the four
 * mega block `ElementNode` classes + the three chip-less `RefNode`/`BlockRefNode`/`EmbedNode`
 * decorator classes); that aggregator lives outside this card's write set (`editor*` /
 * `plugins/**` / `preset*` / `commands*`). This port inlines the equivalent list directly,
 * swapping in `./nodes`'s `EditorRefNode` / `EditorEmbedNode` / `EditorBlockRefNode` — the
 * UI-06 chip subclasses — for the base (React-free) `@megaui/content` decorator classes, so
 * a mounted editor can actually render `[[wikilink]]` / `{{embed}}` / `((block-ref` content.
 */

import { AutoLinkNode, LinkNode } from "@lexical/link";
import type { Klass, LexicalNode } from "lexical";
import {
  MEGA_CONTENT_BLOCK_NODES,
  MegaBlockNode,
  MegaCodeBlockNode,
  createEmptyMegaDocumentEditorStateJSON,
} from "@megaui/content";
import { EditorBlockRefNode, EditorEmbedNode, EditorRefNode } from "./nodes";
import { EditorImageNode } from "./image-node";
import { EditorOutlineTableNode } from "./outline-table-node";

/** ADR-CE-07 preset tiers for the unified content engine. */
export type ContentPreset = "document" | "comment" | "chat";

/** Feature flags trimmed per preset (embed = document only; zoom/hover-menu are UI-07 concerns). */
export interface ContentPresetFeatures {
  blockStructure: boolean;
  tableBlocks: boolean;
  hrBlocks: boolean;
  nestedBlocks: boolean;
  markdownShortcuts: boolean;
  chatSendOnModEnter: boolean;
  /** CE-80: Autolink / TOGGLE_LINK_COMMAND require LinkNode + LinkPlugin. */
  links: boolean;
}

export interface ContentPresetConfig {
  preset: ContentPreset;
  nodes: Klass<LexicalNode>[];
  features: ContentPresetFeatures;
  createEmptyStateJSON: () => string;
}

/** Document: the full mega block vocabulary plus all three chip node kinds. */
const DOCUMENT_NODES: Klass<LexicalNode>[] = [
  ...MEGA_CONTENT_BLOCK_NODES.filter((node) => node.getType() !== "mega-outline-table"),
  EditorOutlineTableNode,
  EditorRefNode,
  EditorBlockRefNode,
  EditorEmbedNode,
  EditorImageNode,
  LinkNode,
  AutoLinkNode,
];

/** Comment/chat: MegaCodeBlockNode only — registering CodeNode alongside it breaks exportJSON/clone. */
const COMMENT_CHAT_NODES: Klass<LexicalNode>[] = [
  MegaBlockNode,
  MegaCodeBlockNode,
  EditorRefNode,
  EditorBlockRefNode,
  LinkNode,
];

const PRESET_CONFIGS: Record<ContentPreset, ContentPresetConfig> = {
  document: {
    preset: "document",
    nodes: DOCUMENT_NODES,
    features: {
      blockStructure: true,
      tableBlocks: true,
      hrBlocks: true,
      nestedBlocks: true,
      markdownShortcuts: true,
      chatSendOnModEnter: false,
      links: true,
    },
    createEmptyStateJSON: createEmptyMegaDocumentEditorStateJSON,
  },
  comment: {
    preset: "comment",
    nodes: COMMENT_CHAT_NODES,
    features: {
      blockStructure: true,
      tableBlocks: false,
      hrBlocks: false,
      nestedBlocks: true,
      markdownShortcuts: true,
      chatSendOnModEnter: false,
      links: true,
    },
    createEmptyStateJSON: createEmptyMegaDocumentEditorStateJSON,
  },
  chat: {
    preset: "chat",
    nodes: COMMENT_CHAT_NODES,
    features: {
      blockStructure: true,
      tableBlocks: false,
      hrBlocks: false,
      nestedBlocks: false,
      markdownShortcuts: true,
      chatSendOnModEnter: true,
      links: true,
    },
    createEmptyStateJSON: createEmptyMegaDocumentEditorStateJSON,
  },
};

/** Returns the node/plugin feature matrix for a content preset (ADR-CE-07). */
export function getContentPresetConfig(preset: ContentPreset): ContentPresetConfig {
  return PRESET_CONFIGS[preset];
}

/** Node type strings registered for a preset (stable for unit assertions). */
export function getContentPresetNodeTypes(preset: ContentPreset): string[] {
  return getContentPresetConfig(preset)
    .nodes.map((klass) => klass.getType())
    .sort();
}

/** True when `nodeType` is part of the preset node registration set. */
export function contentPresetIncludesNode(preset: ContentPreset, nodeType: string): boolean {
  return getContentPresetNodeTypes(preset).includes(nodeType);
}
