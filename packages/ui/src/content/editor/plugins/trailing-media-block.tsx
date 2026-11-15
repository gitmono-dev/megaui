"use client";

import { useEffect } from "react";
import { $getRoot, $isLineBreakNode, $isTextNode, type LexicalNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createMegaBlock,
  $isEmbedNode,
  $isMegaBlockNode,
  $isMegaImageNode,
  generateBlockId,
  type MegaBlockNode,
} from "@megaui/content";

/** Find the last block a reader reaches, including the final nested child. */
function $lastVisibleBlock(): MegaBlockNode | null {
  const rootLast = $getRoot().getLastChild();
  if (!$isMegaBlockNode(rootLast)) return null;
  let block: MegaBlockNode = rootLast;
  while (true) {
    const lastChild: LexicalNode | null = block.getLastChild();
    if (!$isMegaBlockNode(lastChild)) return block;
    block = lastChild;
  }
}

function $endsWithMedia(block: MegaBlockNode): boolean {
  for (let child = block.getLastChild(); child; child = child.getPreviousSibling()) {
    // Empty text after a decorator still belongs to the same bullet, so it does
    // not provide the separate outliner row needed to continue writing.
    if ($isLineBreakNode(child) || ($isTextNode(child) && child.getTextContent().trim().length === 0)) continue;
    return $isMegaImageNode(child) || $isEmbedNode(child);
  }
  return false;
}

/** Repair saved documents whose final image/embed has no editable row below it. */
export function $ensureTrailingMediaBlock(): boolean {
  const block = $lastVisibleBlock();
  if (!block || !$endsWithMedia(block)) return false;
  block.insertAfter($createMegaBlock("text", generateBlockId()));
  return true;
}

export function TrailingMediaBlockPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const ensure = () => {
      if (!editor.isEditable()) return;
      let needsBlock = false;
      editor.getEditorState().read(() => {
        const block = $lastVisibleBlock();
        needsBlock = Boolean(block && $endsWithMedia(block));
      });
      if (!needsBlock) return;
      // Recheck in the write transaction: another update may already have
      // inserted the next block between this read and the scheduled repair.
      editor.update(() => { $ensureTrailingMediaBlock(); });
    };

    ensure();
    return editor.registerUpdateListener(ensure);
  }, [editor]);

  return null;
}
