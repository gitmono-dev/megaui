"use client";

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNodeByKey, $getRoot, $getSelection, $isRangeSelection, $isTextNode, COMMAND_PRIORITY_HIGH, PASTE_COMMAND, TextNode } from "lexical";
import { $createMegaBlock, $isMegaBlockNode, type EmbedValue } from "@megaui/content";
import { BLOCK_ID_SOURCE } from "@megaui/core";
import { $getSelectedMegaBlock, $selectFollowingMegaBlock } from "../commands";
import { $createEditorEmbedNode, $isEditorEmbedNode, showPastedEmbedMacro } from "../nodes";

const ROAM_BLOCK_EMBED = new RegExp(`^\\{\\{(?:\\[\\[embed\\]\\]|embed):\\s*\\(\\((${BLOCK_ID_SOURCE})\\)\\)\\}\\}$`);
const ROAM_PAGE_EMBED = /^\{\{(?:\[\[embed\]\]|embed):\s*\[\[([^\]\r\n]+)\]\]\}\}$/;

export type RoamEmbedTarget = { kind: "block"; blockId: string } | { kind: "page"; title: string };
export function parseRoamEmbedInput(text: string): RoamEmbedTarget | null {
  const block = ROAM_BLOCK_EMBED.exec(text);
  if (block?.[1]) return { kind: "block", blockId: block[1] };
  const page = ROAM_PAGE_EMBED.exec(text);
  return page?.[1]?.trim() ? { kind: "page", title: page[1].trim() } : null;
}

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
export function $insertBlockEmbedAtSelection(embed: EmbedValue, showMacro = false, onInserted?: (nodeKey: string) => void): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  const selectedBlock = $getSelectedMegaBlock();
  if (!selectedBlock) return false;

  const embedNode = $createEditorEmbedNode(embed);
  onInserted?.(embedNode.getKey());
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
export function BlockEmbedPastePlugin({ currentDocId, resolve }: {
  readonly currentDocId: string;
  readonly resolve?: (target: RoamEmbedTarget) => Promise<EmbedValue | null>;
}): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let disposed = false;
    const pending = new Set<string>();
    const unregisterSource = editor.registerNodeTransform(TextNode, node => {
      if (!resolve || !node.isSimpleText() || node.hasFormat("code") || node.getParents().some(parent => parent.getType() === "mega-code-block")) return;
      const source = node.getTextContent();
      const target = parseRoamEmbedInput(source);
      if (!target) return;
      const key = node.getKey();
      const signature = `${key}:${source}`;
      if (pending.has(signature)) return;
      pending.add(signature);
      queueMicrotask(() => {
        void resolve(target).then(embed => {
          if (!embed || disposed) return;
          editor.update(() => {
            const current = $getNodeByKey(key);
            if (!$isTextNode(current) || current.getTextContent() !== source) return;
            const selection = $getSelection();
            const wasSelected = $isRangeSelection(selection) && selection.anchor.key === key;
            const parent = current.getParent();
            current.replace($createEditorEmbedNode(embed));
            if (wasSelected && $isMegaBlockNode(parent)) $selectFollowingMegaBlock(parent);
          });
        }).catch(() => { /* Leave unresolved source editable. */ }).finally(() => pending.delete(signature));
      });
    });
    const unregisterPaste = editor.registerCommand(PASTE_COMMAND, (event) => {
      if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
      const html = event.clipboardData.getData("text/html");
      const embed = parseBlockEmbedClipboard(event.clipboardData.getData("text/plain"), html, currentDocId);
      let nodeKey = "";
      if (!embed || !$insertBlockEmbedAtSelection(embed, true, key => { nodeKey = key; })) return false;
      event.preventDefault();
      const marker = html ? new DOMParser().parseFromString(html, "text/html")
        .querySelector<HTMLElement>("[data-mega-embed-doc][data-mega-embed-block]") : null;
      const markedDocId = marker?.dataset.megaEmbedDoc?.trim();
      const hasExactDoc = marker?.dataset.megaEmbedBlock === embed.targetBlockId && Boolean(markedDocId && markedDocId.length <= 256);
      if (resolve && embed.targetBlockId && !hasExactDoc) {
        const blockId = embed.targetBlockId;
        void resolve({ kind: "block", blockId }).then(resolved => {
          if (!resolved || disposed) return;
          editor.update(() => {
            const node = $getNodeByKey(nodeKey);
            if (!$isEditorEmbedNode(node)) return;
            const current = node.getEmbed();
            if (current.targetDocId === embed.targetDocId && current.targetBlockId === blockId) node.setEmbed(resolved);
          });
        }).catch(() => { /* Retain the current-document fallback. */ });
      }
      return true;
    }, COMMAND_PRIORITY_HIGH);
    const unregisterRepair = editor.registerUpdateListener(({ editorState }) => {
      const hasRootEmbed = editorState.read(() => $getRoot().getChildren().some($isEditorEmbedNode));
      if (hasRootEmbed) editor.update(() => { wrapRootEmbeds(); }, { tag: "root-embed-repair" });
    });
    editor.update(() => { wrapRootEmbeds(); });
    return () => {
      disposed = true;
      unregisterSource();
      unregisterPaste();
      unregisterRepair();
    };
  }, [currentDocId, editor, resolve]);

  return null;
}
