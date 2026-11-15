/** UI-06 public surface for `@megaui/ui/content/editor` (megaui-only barrel, no upstream file). */

export { MegaContentEditor, type MegaContentEditorProps } from "./editor";
export { EditorMirrorPlugin } from "./plugins/editor-mirror";
export { DocumentEmptyStatePlugin, type DocumentEmptyStatePluginProps } from "./plugins/document-empty-state";
export { TrailingMediaBlockPlugin } from "./plugins/trailing-media-block";
export {
  contentPresetIncludesNode,
  getContentPresetConfig,
  getContentPresetNodeTypes,
  type ContentPreset,
  type ContentPresetConfig,
  type ContentPresetFeatures,
} from "./preset";
export * from "./commands";
export {
  $createEditorBlockRefNode,
  $createEditorEmbedNode,
  $createEditorRefNode,
  $isAnyBlockRefNode,
  $isAnyEmbedNode,
  $isAnyRefNode,
  $isEditorBlockRefNode,
  $isEditorEmbedNode,
  $isEditorRefNode,
  EditorBlockRefNode,
  EditorEmbedNode,
  EditorRefNode,
} from "./nodes";
export { BlockStructurePlugin } from "./plugins/block-structure";
export { BlockCollapsePlugin, type BlockCollapseLabels } from "./plugins/block-collapse";
export { TodoCheckboxPlugin, type TodoCheckboxLabels } from "./plugins/todo-checkbox";
export { BlockContextMenuPlugin, type BlockContextMenuLabels, type BlockContextMenuPluginProps } from "./plugins/block-context-menu";
export { BlockEmbedPastePlugin } from "./plugins/block-embed-paste";
export { BlockReferenceSyntaxPlugin } from "./plugins/block-reference-syntax";
export type { BlockRefValue } from "@megaui/content";
export { BlockFocusPlugin, type BlockFocusPluginProps } from "./plugins/block-focus";
export { CompletedPageReferencesPlugin, type CompletedPageReference, type CompletedPageReferencesPluginProps } from "./plugins/completed-page-references";
export { WikilinksPlugin, type WikilinkCandidate, type WikilinksPluginLabels, type WikilinksPluginProps } from "./plugins/wikilinks";
export { EmbedsPlugin, type EmbedCandidate, type EmbedCandidateKind, type EmbedsPluginLabels, type EmbedsPluginProps } from "./plugins/embeds";
export { BlockRefsPlugin, type BlockRefCandidate, type BlockRefsPluginLabels, type BlockRefsPluginProps } from "./plugins/block-refs";
export { QuickCommandsPlugin, type QuickCommandsPluginLabels } from "./plugins/quick-commands";
export { ImagePlugin, type ImagePluginLabels } from "./plugins/images";
export { TableControlsPlugin, type TableControlsLabels } from "./plugins/table-controls";
export {
  createBoundedReconnectScheduler,
  createLexicalHocuspocusProvider,
  MegaDocCollabPlugin,
  MegaDocCollabRoot,
  resolveCollabMode,
  resolveCollabPublicUrl,
  type BoundedReconnectScheduler,
  type CollabMode,
  type DocCollabConnectionStatus,
  type LexicalHocuspocusProviderHandle,
  type MegaDocCollabConfig,
} from "./plugins/collab";
export { buildCollabAwarenessUser, colorFromUserId, listDocPresencePeers, publishLocalCaretAwareness, type CollabAwarenessUser, type DocPresencePeer } from "./plugins/caret";
export { useDocPresenceRoom, type UseDocPresenceOptions } from "./collab/use-doc-presence";
export {
  useChannelCollectionRoom,
  useCollectionRoom,
  useDocCollectionRoom,
  useInboxIndicatorsRoom,
  readCollectionRevision,
  type CollectionPeerLastRead,
  type CollectionRevision,
  type CollectionTypingPeer,
  type UseCollectionRoomOptions,
} from "./collab/use-collection-room";
