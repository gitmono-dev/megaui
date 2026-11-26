/**
 * megaui:libs/react-shared/components/mega/content/commands.ts@0ff3a9d
 *
 * Ported pure Lexical `$`-prefixed command functions; the mega block vocabulary moves
 * to `@megaui/content`. Local extensions include outline tables and child placement
 * when splitting the root of a focused outline.
 */

import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  type LexicalNode,
} from "lexical";
import type { Transformer } from "@lexical/markdown";
import {
  $createMegaBlock,
  $createMegaCodeBlock,
  $createMegaHrBlock,
  $createRoamTable,
  $isMegaBlockNode,
  generateBlockId,
  type MegaBlockNode,
  type MegaBlockVariant,
} from "@megaui/content";

/** Returns the nearest MegaBlockNode owned by the outliner tree (root or nested). */
export function $getSelectedMegaBlock(): MegaBlockNode | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return null;
  }
  let node: LexicalNode | null = selection.anchor.getNode();
  while (node) {
    if ($isMegaBlockNode(node)) {
      const parent = node.getParent();
      if (parent && ($isMegaBlockNode(parent) || parent.getType() === "root")) {
        return node;
      }
    }
    node = node.getParent();
  }
  return null;
}

/** Collects direct nested MegaBlockNode children (preserves order). */
export function $getNestedMegaBlocks(block: MegaBlockNode): MegaBlockNode[] {
  return block.getChildren().filter($isMegaBlockNode);
}

/** Reads only direct TextNode children (excludes nested block text). */
export function $getMegaBlockInlineText(block: MegaBlockNode): string {
  return block
    .getChildren()
    .filter($isTextNode)
    .map((node) => node.getTextContent())
    .join("");
}

/** Select an empty sibling after non-text content, reusing one left by an earlier insertion. */
export function $selectFollowingMegaBlock(block: MegaBlockNode): MegaBlockNode {
  const sibling = block.getNextSibling();
  if ($isMegaBlockNode(sibling) && sibling.getVariant() === "text" && sibling.getChildrenSize() === 0) {
    sibling.selectStart();
    return sibling;
  }
  const next = $createMegaBlock("text", generateBlockId());
  block.insertAfter(next);
  next.selectStart();
  return next;
}

function $replaceInlineText(block: MegaBlockNode, text: string): void {
  const writable = block.getWritable();
  for (const child of writable.getChildren()) {
    if ($isTextNode(child)) {
      child.remove();
    }
  }
  if (text.length === 0) {
    return;
  }
  const textNode = $createTextNode(text);
  const firstNested = writable.getChildren().find($isMegaBlockNode);
  if (firstNested) {
    firstNested.insertBefore(textNode);
  } else {
    writable.append(textNode);
  }
}

/** Indents a block under its previous sibling; nested children follow automatically. */
export function $indentMegaBlock(block: MegaBlockNode): boolean {
  const previous = block.getPreviousSibling();
  if (!$isMegaBlockNode(previous)) {
    return false;
  }
  previous.append(block);
  return true;
}

/** Outdents a block to sit after its parent; nested children follow automatically. */
export function $outdentMegaBlock(block: MegaBlockNode): boolean {
  const parent = block.getParent();
  if (!$isMegaBlockNode(parent)) {
    return false;
  }
  parent.insertAfter(block);
  return true;
}

/** Moves a block up among MegaBlockNode siblings only (ignores inline text nodes). */
export function $moveMegaBlockUp(block: MegaBlockNode): boolean {
  const previous = block.getPreviousSibling();
  if (!$isMegaBlockNode(previous)) {
    return false;
  }
  previous.insertBefore(block);
  return true;
}

/** Moves a block down among MegaBlockNode siblings only (ignores inline text nodes). */
export function $moveMegaBlockDown(block: MegaBlockNode): boolean {
  const next = block.getNextSibling();
  if (!$isMegaBlockNode(next)) {
    return false;
  }
  next.insertAfter(block);
  return true;
}

/** Merges into previous sibling block, or into parent when this is the first nested child. */
export function $mergeMegaBlockWithPrevious(block: MegaBlockNode): boolean {
  const previous = block.getPreviousSibling();
  if ($isMegaBlockNode(previous)) {
    // Move every child (text, ref/embed chips, nested blocks) — never flatten to
    // text-only, which would drop decorator nodes.
    for (const child of [...block.getChildren()]) {
      previous.append(child);
    }
    block.remove();
    previous.selectEnd();
    return true;
  }

  const parent = block.getParent();
  if ($isMegaBlockNode(parent)) {
    for (const child of [...block.getChildren()]) {
      parent.append(child);
    }
    block.remove();
    parent.selectEnd();
    return true;
  }

  return false;
}

/**
 * Roam-style Enter: split inline text into a sibling, or a first child in a focused outline.
 * Existing nested children remain on the upper block.
 */
export function $splitMegaBlockAtSelection(placement: "sibling" | "child" = "sibling"): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return false;
  }
  const block = $getSelectedMegaBlock();
  if (!block) {
    return false;
  }

  const anchorNode = selection.anchor.getNode();
  const newBlock = $createMegaBlock("text", generateBlockId());
  if ($isTextNode(anchorNode)) {
    const fullText = anchorNode.getTextContent();
    const offset = selection.anchor.offset;
    anchorNode.setTextContent(fullText.slice(0, offset));
    const after = fullText.slice(offset);
    if (after.length > 0) newBlock.append($createTextNode(after));
  }
  if (placement === "child") {
    const firstChild = $getNestedMegaBlocks(block)[0];
    if (firstChild) firstChild.insertBefore(newBlock);
    else block.append(newBlock);
    block.setCollapsed(false);
  } else {
    block.insertAfter(newBlock);
  }
  newBlock.selectStart();
  return true;
}

/** Sets the variant on the selected block (slash menu / markdown shortcuts). */
export function $setSelectedMegaBlockVariant(variant: MegaBlockVariant): boolean {
  const block = $getSelectedMegaBlock();
  if (!block) {
    return false;
  }
  block.setVariant(variant);
  if (variant !== "todo") {
    block.setTodoChecked(false);
  }
  return true;
}

/** Inserts a nested list-style child block under the current block. */
export function $insertNestedMegaListItem(listKind: "bullet" | "ordered" = "bullet"): boolean {
  const block = $getSelectedMegaBlock();
  if (!block) {
    return false;
  }
  const storedKind = listKind === "ordered" ? "ordered" : "bullet";
  const child = $createMegaBlock("text", generateBlockId(), false, false, storedKind);
  child.append($createTextNode(storedKind === "ordered" ? "1. " : "\u2022 "));
  block.append(child);
  child.selectEnd();
  return true;
}

export function $insertMegaCodeBlockSibling(language = "rust"): boolean {
  const block = $getSelectedMegaBlock();
  if (!block) {
    return false;
  }
  const code = $createMegaCodeBlock(generateBlockId(), language);
  code.append($createTextNode(""));
  block.insertAfter(code);
  code.selectStart();
  return true;
}

export function $insertMegaTableBlockSibling(): boolean {
  const block = $getSelectedMegaBlock();
  if (!block) {
    return false;
  }
  const { source, firstCell } = $createRoamTable(2, 2);
  block.insertAfter(source);
  firstCell.selectStart();
  return true;
}

export function $insertMegaHrBlockSibling(): boolean {
  const block = $getSelectedMegaBlock();
  if (!block) {
    return false;
  }
  const hr = $createMegaHrBlock(generateBlockId());
  block.insertAfter(hr);
  const next = hr.getNextSibling();
  if ($isMegaBlockNode(next)) {
    next.selectStart();
  } else {
    const fallback = $createMegaBlock("text", generateBlockId());
    hr.insertAfter(fallback);
    fallback.selectStart();
  }
  return true;
}

/** Ensures the editor root only contains mega blocks (seed helper for tests). */
export function $ensureRootMegaBlockTree(): void {
  const root = $getRoot();
  if (root.getChildren().length === 0) {
    root.append($createMegaBlock("text", generateBlockId()));
  }
}

type MarkdownMatch = {
  variant?: MegaBlockVariant;
  strip: number;
};

function readLinePrefix(text: string, pendingSpace = false): MarkdownMatch | null {
  const probe = pendingSpace ? `${text} ` : text;
  if (/^#\s/.test(probe)) {
    return { variant: "h1", strip: 2 };
  }
  if (/^##\s/.test(probe)) {
    return { variant: "h2", strip: 3 };
  }
  if (/^###\s/.test(probe)) {
    return { variant: "h3", strip: 4 };
  }
  if (/^>\s/.test(probe)) {
    return { variant: "quote", strip: 2 };
  }
  if (/^- \[[ xX]\]\s/.test(probe)) {
    return { variant: "todo", strip: 6 };
  }
  if (pendingSpace) {
    if (text === "#") {
      return { variant: "h1", strip: 2 };
    }
    if (text === "##") {
      return { variant: "h2", strip: 3 };
    }
    if (text === "###") {
      return { variant: "h3", strip: 4 };
    }
    if (text === ">") {
      return { variant: "quote", strip: 2 };
    }
    if (/^- \[[ xX]\]$/.test(text)) {
      return { variant: "todo", strip: 6 };
    }
  }
  return null;
}

function stripMarkdownPrefix(text: string, match: MarkdownMatch, pendingSpace: boolean): string {
  if (pendingSpace) {
    if (match.variant === "todo" && /^- \[[ xX]\]$/.test(text)) {
      return "";
    }
    return text.slice(Math.max(0, match.strip - 1));
  }
  return text.slice(match.strip);
}

/** Applies markdown line prefixes (#, ##, >, - [ ]) to the owning mega block variant. */
export function $applyMegaBlockMarkdownPrefix(pendingSpace = false): boolean {
  const block = $getSelectedMegaBlock();
  if (!block) {
    return false;
  }
  const text = $getMegaBlockInlineText(block);
  const match = readLinePrefix(text, pendingSpace);
  if (!match?.variant) {
    return false;
  }
  block.setVariant(match.variant);
  if (match.variant === "todo") {
    const probe = pendingSpace ? `${text} ` : text;
    block.setTodoChecked(/^- \[[xX]\]\s/.test(probe) || /^- \[[xX]\]$/.test(text));
  } else {
    block.setTodoChecked(false);
  }
  $replaceInlineText(block, stripMarkdownPrefix(text, match, pendingSpace));
  return true;
}

/** Markdown shortcut transformers for MegaContentEditor (variant mapping). */
export const MEGA_CONTENT_MARKDOWN_TRANSFORMERS: Transformer[] = [];
