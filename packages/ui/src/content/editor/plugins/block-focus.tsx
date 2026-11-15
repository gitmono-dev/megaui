"use client";

import { useCallback, useEffect } from "react";
import { $getRoot, COMMAND_PRIORITY_HIGH, COMMAND_PRIORITY_NORMAL, KEY_ENTER_COMMAND, KEY_ESCAPE_COMMAND, type LexicalNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isMegaBlockNode, type MegaBlockNode } from "@megaui/content";
import { $getSelectedMegaBlock, $splitMegaBlockAtSelection } from "../commands";

export interface BlockFocusPluginProps {
  readonly blockId: string | null;
  readonly onExit: () => void;
}

type BlockFocusMarker = "ancestor" | "descendant" | "target";

function findBlock(blockId: string, nodes: readonly LexicalNode[]): MegaBlockNode | null {
  for (const node of nodes) {
    if (!$isMegaBlockNode(node)) continue;
    if (node.getBlockId() === blockId) return node;
    const nested = findBlock(blockId, node.getChildren());
    if (nested) return nested;
  }
  return null;
}

function clearBlockFocus(root: HTMLElement): void {
  root.closest<HTMLElement>('[data-mega-content="outliner"]')?.removeAttribute("data-mega-block-focus");
  for (const block of root.querySelectorAll<HTMLElement>("[data-block-id]")) {
    block.removeAttribute("data-mega-block-focus");
  }
}

function focusMarker(candidate: HTMLElement, target: HTMLElement): BlockFocusMarker | null {
  if (candidate === target) return "target";
  if (candidate.contains(target)) return "ancestor";
  if (target.contains(candidate)) return "descendant";
  return null;
}

function syncBlockFocus(root: HTMLElement, blockId: string | null): boolean {
  clearBlockFocus(root);
  if (!blockId) return false;

  const blocks = [...root.querySelectorAll<HTMLElement>("[data-block-id]")];
  const target = blocks.find((candidate) => candidate.dataset.blockId === blockId);
  const outliner = root.closest<HTMLElement>('[data-mega-content="outliner"]');
  if (!target || !outliner) return false;

  outliner.dataset.megaBlockFocus = blockId;
  for (const candidate of blocks) {
    const marker = focusMarker(candidate, target);
    if (marker) candidate.dataset.megaBlockFocus = marker;
  }
  return true;
}

/** Turns a copied `?block=` URL into an editable outline subtree. */
export function BlockFocusPlugin({ blockId, onExit }: BlockFocusPluginProps): null {
  const [editor] = useLexicalComposerContext();
  const sync = useCallback(() => {
    const root = editor.getRootElement();
    if (root) syncBlockFocus(root, blockId);
  }, [blockId, editor]);

  useEffect(() => {
    sync();
    const unregisterUpdate = editor.registerUpdateListener(() => sync());
    return () => {
      unregisterUpdate();
      const root = editor.getRootElement();
      if (root) clearBlockFocus(root);
    };
  }, [editor, sync]);

  useEffect(() => {
    if (!blockId) return undefined;
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if ($getSelectedMegaBlock()?.getBlockId() !== blockId) return false;
        // Keep the new line inside the visible subtree. Menus retain HIGH priority;
        // descendant blocks fall through to the ordinary sibling-splitting handler.
        const handled = $splitMegaBlockAtSelection("child");
        if (handled) event?.preventDefault();
        return handled;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [blockId, editor]);

  useEffect(() => {
    if (!blockId) return undefined;
    let focused = false;
    let focusFrame: number | null = null;
    const focusTarget = () => {
      if (focused) return;
      let exists = false;
      editor.getEditorState().read(() => {
        exists = findBlock(blockId, $getRoot().getChildren()) !== null;
      });
      if (!exists) return;
      focused = true;
      editor.update(() => findBlock(blockId, $getRoot().getChildren())?.selectEnd());
      focusFrame = window.requestAnimationFrame(() => {
        const root = editor.getRootElement();
        const active = document.activeElement;
        // A user may already have moved to the other editor or split handle.
        if (active && active !== document.body && active !== root && !root?.contains(active)) return;
        editor.focus();
        root?.focus();
      });
    };
    focusTarget();
    const unregisterFocus = editor.registerUpdateListener(focusTarget);

    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        event.preventDefault();
        onExit();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    return () => {
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
      unregisterFocus();
      unregisterEscape();
    };
  }, [blockId, editor, onExit]);

  return null;
}
