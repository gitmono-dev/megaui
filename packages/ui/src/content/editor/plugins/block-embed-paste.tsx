"use client";

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $getSelection, $isRangeSelection, COMMAND_PRIORITY_HIGH, PASTE_COMMAND } from "lexical";
import { $createMegaBlock, type EmbedValue } from "@megaui/content";
import { BLOCK_ID_SOURCE } from "@megaui/core";
import { $getSelectedMegaBlock, $selectFollowingMegaBlock } from "../commands";
import { $createEditorEmbedNode, $isEditorEmbedNode, showPastedEmbedMacro } from "../nodes";

const ROAM_BLOCK_EMBED = new RegExp(`^\\{\\{(?:\\[\\[embed\\]\\]|embed):\\s*\\(\\((${BLOCK_ID_SOURCE})\\)\\)\\}\\}$`);

/** Keep Roam's plain-text syntax while retaining the source doc in rich clipboard HTML. */
export function parseBlockEmbedClipboard(text: string, html: string, currentDocId: string): EmbedValue | null {
  const match = ROAM_BLOCK_EMBED.exec(text.trim());
  const blockId = match?.[1];
  if (!blockId) return null;

  const marker = html
    ? new DOMParser().parseFromString(html, "text/html")
      .querySelector<HTMLElement>("[data-mega-embed-doc][data-mega-embed-block]")
    : null;
  const markedDocId = marker?.dataset.megaEmbedBlock === blockId
    ? marker.dataset.megaEmbedDoc?.trim()
    : undefined;
  const targetDocId = markedDocId && markedDocId.length <= 256 ? markedDocId : currentDocId;
  return { targetDocId, targetBlockId: blockId };
}

/** Repair embeds pasted by older clients outside the document's block tree. */
export function wrapRootEmbeds(): boolean {
  let changed = false;
  for (const node of $getRoot().getChildren()) {
    if (!$isEditorEmbedNode(node)) continue;
    const block = $createMegaBlock("text");
    node.insertBefore(block);
    block.append(node);
    changed = true;
  }
  return changed;
}

/** Lexical's generic block insertion skips empty nested MegaBlockNode selections. */
export function $insertBlockEmbedAtSelection(embed: EmbedValue, showMacro = false): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  const selectedBlock = $getSelectedMegaBlock();
  if (!selectedBlock) return false;

  const embedNode = $createEditorEmbedNode(embed);
  if (showMacro) showPastedEmbedMacro(embedNode.getKey());
  if (selectedBlock.getChildrenSize() === 0) {
    selectedBlock.append(embedNode);
    $selectFollowingMegaBlock(selectedBlock);
    return true;
  }

  const embedBlock = $createMegaBlock("text");
  embedBlock.append(embedNode);
  selectedBlock.insertAfter(embedBlock);
  $selectFollowingMegaBlock(embedBlock);
  return true;
}

/** Converts a copied block embed into a real Lexical embed instead of raw macro text. */
export function BlockEmbedPastePlugin({ currentDocId }: { readonly currentDocId: string }): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterPaste = editor.registerCommand(PASTE_COMMAND, (event) => {
      if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
      const embed = parseBlockEmbedClipboard(
        event.clipboardData.getData("text/plain"),
        event.clipboardData.getData("text/html"),
        currentDocId,
      );
      if (!embed || !$insertBlockEmbedAtSelection(embed, true)) return false;
      event.preventDefault();
      return true;
    }, COMMAND_PRIORITY_HIGH);
    const unregisterRepair = editor.registerUpdateListener(({ editorState }) => {
      const hasRootEmbed = editorState.read(() => $getRoot().getChildren().some($isEditorEmbedNode));
      if (hasRootEmbed) editor.update(() => { wrapRootEmbeds(); }, { tag: "root-embed-repair" });
    });
    editor.update(() => { wrapRootEmbeds(); });
    return () => {
      unregisterPaste();
      unregisterRepair();
    };
  }, [currentDocId, editor]);

  return null;
}
