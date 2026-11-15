"use client";

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNodeByKey, $isTextNode, HISTORY_MERGE_TAG, type Klass, type NodeKey } from "lexical";
import { $isRefNode, type RefNode } from "@megaui/content";

function isLegacyTag(node: RefNode): boolean {
  const ref = node.getRef();
  return ref.kind === "doc" && ref.notation === "tag" && ref.tagPrefix !== "inline";
}

/** Upgrade the old separate hash + reference once, preserving surrounding text. */
function $normalizeTag(node: RefNode): void {
  if (!isLegacyTag(node)) return;
  const previous = node.getPreviousSibling();
  if ($isTextNode(previous) && previous.getTextContent().endsWith("#")) {
    if (previous.getTextContentSize() === 1) previous.remove();
    else previous.spliceText(previous.getTextContentSize() - 1, 1, "");
  }
  node.setRef({ ...node.getRef(), tagPrefix: "inline" });
}

/** Used by both the editor and snapshot/embed reader; includes Yjs skipTransforms updates. */
export function TagReferencesPlugin({ nodeClass }: { nodeClass: Klass<RefNode> }): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const unregisterTransform = editor.registerNodeTransform(nodeClass, $normalizeTag);
    const unregisterMutation = editor.registerMutationListener(nodeClass, (mutations) => {
      const pending: NodeKey[] = [];
      editor.getEditorState().read(() => {
        for (const [key, mutation] of mutations) {
          if (mutation === "destroyed") continue;
          const node = $getNodeByKey(key);
          if ($isRefNode(node) && isLegacyTag(node)) pending.push(key);
        }
      });
      if (pending.length === 0) return;
      editor.update(() => {
        for (const key of pending) {
          const node = $getNodeByKey(key);
          if ($isRefNode(node)) $normalizeTag(node);
        }
      }, { tag: HISTORY_MERGE_TAG });
    }, { skipInitialization: false });
    return () => {
      unregisterTransform();
      unregisterMutation();
    };
  }, [editor, nodeClass]);
  return null;
}
