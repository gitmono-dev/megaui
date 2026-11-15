// megaui-only: two views of one document, with one collaboration/save/history owner.
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "@lexical/utils";
import {
  $addUpdateTag, $getNodeByKey, $getSelection, $isElementNode, $isRangeSelection, $isTextNode,
  COMMAND_PRIORITY_CRITICAL, REDO_COMMAND, SKIP_DOM_SELECTION_TAG, UNDO_COMMAND,
  type EditorState, type LexicalEditor,
} from "lexical";
import { MegaContentEditor } from "../editor";

const MIRROR_SYNC = "mega-mirror-sync";

function applyState(target: LexicalEditor, incoming: EditorState) {
  if (incoming.isEmpty()) return;
  // Preserve an active view's caret during remote changes, validating points
  // against the incoming tree (a remote delete can remove either endpoint).
  let selection = null;
  if (target.getRootElement()?.contains(document.activeElement)) {
    selection = target.getEditorState().read(() => $getSelection()?.clone() ?? null);
    if ($isRangeSelection(selection)) {
      const range = selection;
      const valid = incoming.read(() => [range.anchor, range.focus].every((point) => {
        const node = $getNodeByKey(point.key);
        if (point.type === "text" && $isTextNode(node)) {
          point.offset = Math.min(point.offset, node.getTextContentSize());
          return true;
        }
        if (point.type === "element" && $isElementNode(node)) {
          point.offset = Math.min(point.offset, node.getChildrenSize());
          return true;
        }
        return false;
      }));
      if (!valid) selection = null;
    } else {
      selection = null;
    }
  }
  target.update(() => {
    target.setEditorState(incoming.clone(selection), { tag: MIRROR_SYNC });
    $addUpdateTag(SKIP_DOM_SELECTION_TAG);
  }, { discrete: true });
}

/** Both editors use the same node registrations and immutable Lexical state keys. */
export function EditorMirrorBinding({ source }: { source: LexicalEditor }) {
  const [mirror] = useLexicalComposerContext();
  useEffect(() => {
    applyState(mirror, source.getEditorState());
    mirror.setEditable(source.isEditable());
    return mergeRegister(
      source.registerEditableListener((editable) => mirror.setEditable(editable)),
      source.registerUpdateListener(({ editorState, tags, dirtyElements, dirtyLeaves }) => {
        if (!tags.has(MIRROR_SYNC) && (dirtyElements.size || dirtyLeaves.size)) applyState(mirror, editorState);
      }),
      mirror.registerUpdateListener(({ editorState, tags, dirtyElements, dirtyLeaves }) => {
        if (!tags.has(MIRROR_SYNC) && source.isEditable() && (dirtyElements.size || dirtyLeaves.size)) applyState(source, editorState);
      }),
      ...[UNDO_COMMAND, REDO_COMMAND].map((command) => mirror.registerCommand(command, () => {
        // Leave the mirror command context before changing the owner history.
        queueMicrotask(() => source.dispatchCommand(command, undefined));
        return true;
      }, COMMAND_PRIORITY_CRITICAL)),
    );
  }, [mirror, source]);
  return null;
}

/** Mount inside the owning editor; portal supplies a separate editable DOM root. */
export function EditorMirrorPlugin({ target, placeholder, children }: {
  target: HTMLElement;
  placeholder: string;
  children?: ReactNode;
}) {
  const [source] = useLexicalComposerContext();
  const [initialStateJSON, setInitialStateJSON] = useState<string | null>(() => {
    const state = source.getEditorState();
    return state.isEmpty() ? null : JSON.stringify(state.toJSON());
  });
  useEffect(() => {
    if (initialStateJSON !== null) return;
    const initialize = () => {
      const state = source.getEditorState();
      if (!state.isEmpty()) setInitialStateJSON(JSON.stringify(state.toJSON()));
    };
    initialize();
    return source.registerUpdateListener(initialize);
  }, [initialStateJSON, source]);
  // A freshly mounted collaboration owner is empty until its first room sync.
  if (initialStateJSON === null) return null;
  return createPortal(
    <MegaContentEditor history={false} initialStateJSON={initialStateJSON}
      placeholder={placeholder} preset="document">
      <EditorMirrorBinding source={source} />
      {children}
    </MegaContentEditor>, target,
  );
}
