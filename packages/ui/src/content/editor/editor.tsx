/**
 * megaui:libs/react-shared/components/mega/content/editor.tsx@0ff3a9d
 *
 * Ported with reductions to fit this card's write set (`packages/ui/src/content/editor/**`)
 * and reference source (`content/{editor*,plugins/**,preset*,commands*}` +
 * `collab/**` — not the sibling `content/{block-hover-*,zoom.ts,embed-context.tsx,
 * embed-live.tsx,embed-renderer.tsx,block-side-panel.tsx,use-block-deep-link.ts,reader.tsx}`
 * files, which are UI-07 reader / later-card concerns):
 * - Dropped: slash menu, block hover menu, zoom, block-interaction, focus-block-awareness,
 *   Shiki code highlighting theme wiring (`code-view`/`doc-editor` theme files are outside
 *   this card's copy paths). `BlockStructurePlugin` (Tab/Enter/Backspace/⌥↑↓ + invariants)
 *   is kept — without it, Lexical's default RichText paragraph-splitting on Enter would
 *   try to insert an unregistered `ParagraphNode` into the mega block tree.
 * - `isSafeHref` inlined (upstream imports `@libs/validators/safe-href`, a different repo's
 *   package not in this workspace): rejects `javascript:`/`data:` schemes, same intent.
 * - AC2/AC4 fail-closed collab gating: upstream's `collabEnabled` only ever meant "all three
 *   of url/token/documentName present"; this port routes through `resolveCollabMode` so a
 *   configured `collab.url` with a missing token goes **read-only** (not silently editable
 *   local mode — see `plugins/collab.tsx` header) while an unset `collab.url` stays plain
 *   local/editable (autosave + HistoryPlugin, matching upstream's fallback exactly).
 */
"use client";

import * as React from "react";
import { useEffect, useMemo, useRef } from "react";
import { COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from "lexical";
import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { AutoLinkPlugin } from "@lexical/react/LexicalAutoLinkPlugin";
import { autoLinkEmailMatcher, autoLinkUrlMatcher } from "@lexical/link";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { getContentPresetConfig, type ContentPreset } from "./preset";
import { BlockStructurePlugin } from "./plugins/block-structure";
import { RoamSyntaxPlugin } from "./plugins/roam-syntax";
import { RoamTableRenderer } from "./plugins/roam-table-renderer";
import { TagReferencesPlugin } from "../tag-references";
import { EditorRefNode } from "./nodes";
import { WikilinksPlugin, type WikilinkCandidate, type WikilinksPluginLabels } from "./plugins/wikilinks";
import { BlockRefsPlugin, type BlockRefCandidate, type BlockRefsPluginLabels } from "./plugins/block-refs";
import { EmbedsPlugin, type EmbedCandidate, type EmbedsPluginLabels } from "./plugins/embeds";
import { MegaDocCollabPlugin, MegaDocCollabRoot, resolveCollabMode, type MegaDocCollabConfig } from "./plugins/collab";

const AUTOSAVE_DEBOUNCE_MS = 2_000;
// Re-registering AutoLink's transforms dirties the document and restores its
// selection. Keep this stable when a sibling field (e.g. comments) rerenders.
const DOCUMENT_AUTO_LINK_MATCHERS = [autoLinkUrlMatcher, autoLinkEmailMatcher];
/** Rejects `javascript:`/`data:`/etc. schemes; allows relative, `https:`, `mailto:`, … */
const UNSAFE_HREF_SCHEME = /^\s*(javascript|data|vbscript):/i;

function isSafeHref(url: string): boolean {
  return !UNSAFE_HREF_SCHEME.test(url);
}

function MegaContentEditable({
  editable,
  onAutoSave,
  placeholder,
}: {
  editable: boolean;
  onAutoSave?: (bodyJSON: string) => void;
  placeholder: string;
}) {
  const [editor] = useLexicalComposerContext();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onAutoSaveRef = useRef(onAutoSave);
  onAutoSaveRef.current = onAutoSave;
  const scheduleSave = () => {
    if (!onAutoSaveRef.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      try {
        onAutoSaveRef.current?.(JSON.stringify(editor.getEditorState().toJSON()));
      } catch {
        // Container-level readers (e.g. issue body) fall back to DOM text when export fails.
      }
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (!onAutoSaveRef.current) return undefined;
    return editor.registerUpdateListener(scheduleSave);
  }, [editor]);

  useEffect(
    () => () => {
      // Flush pending debounce so panel/unmount paths do not drop the last edit.
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
        timer.current = undefined;
        try {
          onAutoSaveRef.current?.(JSON.stringify(editor.getEditorState().toJSON()));
        } catch {
          // Ignore export failures on teardown.
        }
      }
    },
    [editor],
  );

  return (
    <div onInputCapture={scheduleSave} onKeyUpCapture={scheduleSave}>
      <ContentEditable
        aria-label={placeholder}
        aria-readonly={!editable}
        className="mega-doc-edit-surface"
        data-mega-content="content-editable"
        style={{ minHeight: 240 }}
      />
    </div>
  );
}

function EditorStateReaderPlugin({ register }: { register?: (readStateJSON: () => string) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    register?.(() => JSON.stringify(editor.getEditorState().toJSON()));
  }, [editor, register]);
  return null;
}

function EditorChangePlugin({ onChange }: { onChange: (body: string) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
    if (dirtyElements.size || dirtyLeaves.size) onChange(JSON.stringify(editorState.toJSON()));
  }), [editor, onChange]);
  return null;
}

/** ADR-CE-07: chat preset sends on Cmd/Ctrl+Enter instead of splitting blocks. */
function ChatSendPlugin({ onSend }: { onSend: (bodyJSON: string) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!event?.metaKey && !event?.ctrlKey) {
          return false;
        }
        event.preventDefault();
        onSend(JSON.stringify(editor.getEditorState().toJSON()));
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onSend]);
  return null;
}

/**
 * Pulse typing on Lexical updates (matches upstream's collection-awareness idle clear of 5s).
 */
function TypingActivityPlugin({ onTypingChange }: { onTypingChange: (typing: boolean) => void }): null {
  const [editor] = useLexicalComposerContext();
  const onTypingChangeRef = useRef(onTypingChange);
  onTypingChangeRef.current = onTypingChange;

  useEffect(() => {
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, tags }) => {
      if (tags.has("historic") || (dirtyElements.size === 0 && dirtyLeaves.size === 0)) return;
      onTypingChangeRef.current(true);
    });
  }, [editor]);

  return null;
}

export interface MegaContentEditorProps {
  preset: ContentPreset;
  initialStateJSON: string;
  placeholder: string;
  onAutoSave?: (bodyJSON: string) => void;
  /** Immediate document changes; persistence still uses the debounced callback. */
  onChange?: (bodyJSON: string) => void;
  /** A mirrored view delegates undo/redo to its owning editor. */
  history?: boolean;
  /** Exposes a stable state reader for container-level input orchestration. */
  registerStateReader?: (readStateJSON: () => string) => void;
  onSend?: (bodyJSON: string) => void;
  /**
   * When set, resolved via `resolveCollabMode`: `url` unset → local/editable (AC4); `url`
   * set but `token`/`documentName` missing → read-only, fail-closed (AC2); all three
   * present → live Hocuspocus collaboration (autosave + HistoryPlugin are skipped —
   * CollaborationPlugin owns editor state per Lexical's docs).
   */
  collab?: MegaDocCollabConfig;
  /** Pulse collection-room typing awareness on content updates. */
  onTypingChange?: (typing: boolean) => void;
  /** `[[` wikilink typeahead. */
  wikilinks?: {
    labels: WikilinksPluginLabels;
    search(query: string): Promise<readonly WikilinkCandidate[]>;
    allowCreate?: boolean;
  };
  /** `((` block-ref typeahead. */
  blockRefs?: {
    labels: BlockRefsPluginLabels;
    search(query: string): Promise<readonly BlockRefCandidate[]>;
  };
  /** `{{` embed typeahead (document preset). */
  embeds?: {
    labels: EmbedsPluginLabels;
    search(query: string): Promise<readonly EmbedCandidate[]>;
  };
  children?: React.ReactNode;
}

/** CE-32: preset-driven block-tree editor. */
export function MegaContentEditor({
  children,
  collab,
  initialStateJSON,
  onAutoSave,
  onChange,
  history = true,
  onTypingChange,
  registerStateReader,
  onSend,
  placeholder,
  preset,
  wikilinks,
  blockRefs,
  embeds,
}: MegaContentEditorProps) {
  const config = useMemo(() => getContentPresetConfig(preset), [preset]);
  const collabMode = useMemo(() => resolveCollabMode(collab), [collab]);
  const collabActive = collabMode === "collab";
  const readOnly = collabMode === "readonly";

  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      // CollaborationPlugin owns editor state when collab is on (Lexical docs requirement).
      editorState: collabActive ? null : initialStateJSON,
      editable: !readOnly,
      namespace: `mega-content-editor-${preset}`,
      nodes: config.nodes,
      onError: (error: Error) => {
        throw error;
      },
      theme: {},
    }),
    [collabActive, config.nodes, initialStateJSON, preset, readOnly],
  );

  const editorTree = (
    <LexicalComposer key={`mega-content-editor-${preset}-${collabMode}-${collabActive ? collab?.documentName : ""}`} initialConfig={initialConfig}>
      <div
        className="mega-doc-typography"
        data-mega-content="editor"
        data-mega-content-preset={preset}
        data-mega-content-collab-mode={collabMode}
      >
        <RichTextPlugin
          contentEditable={
            <MegaContentEditable editable={!readOnly} onAutoSave={readOnly ? undefined : onAutoSave} placeholder={placeholder} />
          }
          ErrorBoundary={LexicalErrorBoundary}
          placeholder={<div aria-hidden="true">{placeholder}</div>}
        />
        {collabActive || readOnly || !history ? null : <HistoryPlugin />}
        <TagReferencesPlugin nodeClass={EditorRefNode} />
        {collabActive && collab ? (
          <MegaDocCollabPlugin
            config={{
              ...collab,
              initialEditorStateJSON: collab.initialEditorStateJSON ?? initialStateJSON,
            }}
          />
        ) : null}
        {onTypingChange && !readOnly ? <TypingActivityPlugin onTypingChange={onTypingChange} /> : null}
        {config.features.links ? <LinkPlugin validateUrl={isSafeHref} /> : null}
        {preset === "document" ? <AutoLinkPlugin matchers={DOCUMENT_AUTO_LINK_MATCHERS} /> : null}
        {config.features.tableBlocks ? <TablePlugin hasCellMerge={false} /> : null}
        {config.features.blockStructure && !readOnly ? <BlockStructurePlugin allowNesting={config.features.nestedBlocks} registerInvariants={preset === "document"} /> : null}
        {preset === "document" && !readOnly ? <RoamSyntaxPlugin /> : null}
        {preset === "document" ? <RoamTableRenderer /> : null}
        {wikilinks && !readOnly ? <WikilinksPlugin allowCreate={wikilinks.allowCreate} labels={wikilinks.labels} search={wikilinks.search} /> : null}
        {blockRefs && !readOnly ? <BlockRefsPlugin labels={blockRefs.labels} search={blockRefs.search} /> : null}
        {embeds && !readOnly ? <EmbedsPlugin labels={embeds.labels} search={embeds.search} /> : null}
        {registerStateReader ? <EditorStateReaderPlugin register={registerStateReader} /> : null}
        {onChange ? <EditorChangePlugin onChange={onChange} /> : null}
        {onSend && !readOnly ? <ChatSendPlugin onSend={onSend} /> : null}
        {children}
      </div>
    </LexicalComposer>
  );

  if (collabActive) {
    return <MegaDocCollabRoot>{editorTree}</MegaDocCollabRoot>;
  }
  return editorTree;
}
