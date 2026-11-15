// megaui-only (FIX-RO-02): Lexical's stock placeholder only recognizes empty
// paragraph roots. Document preset roots contain custom mega-block nodes instead.
"use client";

import { useEffect } from "react";
import { $getRoot, $isTextNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isMegaBlockNode } from "@megaui/content";

export interface DocumentEmptyStatePluginProps {
  onEmptyChange: (isEmpty: boolean) => void;
}

function hasBlankStarterBlock(): boolean {
  const root = $getRoot();
  if (root.getChildrenSize() !== 1) return false;
  const block = root.getFirstChild();
  if (!$isMegaBlockNode(block) || block.getVariant() !== "text" || block.getListKind() !== null) return false;
  return block.getChildren().every((child) => $isTextNode(child) && child.getTextContent().trim().length === 0);
}

/** Shows the document hint only for its single blank, unformatted starter block. */
export function DocumentEmptyStatePlugin({ onEmptyChange }: DocumentEmptyStatePluginProps): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let previousValue: boolean | undefined;
    const publish = () => {
      editor.getEditorState().read(() => {
        const isEmpty = hasBlankStarterBlock();
        if (isEmpty === previousValue) return;
        previousValue = isEmpty;
        onEmptyChange(isEmpty);
      });
    };

    publish();
    return editor.registerUpdateListener(() => publish());
  }, [editor, onEmptyChange]);

  return null;
}
