"use client";

import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { $getRoot, COMMAND_PRIORITY_LOW, KEY_DOWN_COMMAND, type LexicalNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isMegaBlockNode, type MegaBlockNode, type MegaBlockVariant } from "@megaui/content";
import { $getSelectedMegaBlock } from "../commands";

export interface BlockContextMenuLabels {
  readonly ariaLabel: string;
  readonly copyBlockRef: string;
  readonly copyBlockId: string;
  readonly copyBlockLink: string;
  readonly copyEmbed: string;
  readonly focusBlock: string;
  readonly openInSidebar: string;
  readonly expandAll: string;
  readonly collapseAll: string;
  readonly makeTodo: string;
  readonly removeTodo: string;
  readonly textStyle: string;
  readonly heading1: string;
  readonly heading2: string;
  readonly heading3: string;
}

export interface BlockContextMenuPluginProps {
  readonly labels: BlockContextMenuLabels;
  readonly onFocusBlock?: (blockId: string) => void;
  readonly onOpenInSidebar?: (blockId: string) => void;
  readonly sourceDocId?: string;
}

type BlockContextMenuState = Readonly<{
  blockId: string;
  isTodo: boolean;
  left: number;
  top: number;
}>;

type BlockContextAction = "copyBlockRef" | "copyBlockId" | "copyBlockLink" | "copyEmbed" | "focusBlock" | "openInSidebar" | "expandAll" | "collapseAll" | "todo" | MegaBlockVariant;

function menuStateFromTarget(target: EventTarget | null, left: number, top: number): BlockContextMenuState | null {
  if (!(target instanceof Element)) return null;
  const block = target.closest<HTMLElement>("[data-block-id]");
  const blockId = block?.dataset.blockId;
  if (!blockId) return null;
  if (block.closest('[data-mega-content="reader"]')) return null;
  return { blockId, isTodo: block.dataset.megaBlock === "todo", left, top };
}

function findBlock(blockId: string, nodes: readonly LexicalNode[]): MegaBlockNode | null {
  for (const node of nodes) {
    if (!$isMegaBlockNode(node)) continue;
    if (node.getBlockId() === blockId) return node;
    const nested = findBlock(blockId, node.getChildren());
    if (nested) return nested;
  }
  return null;
}

function setCollapsed(nodes: readonly LexicalNode[], collapsed: boolean): void {
  for (const node of nodes) {
    if (!$isMegaBlockNode(node)) continue;
    node.setCollapsed(collapsed);
    setCollapsed(node.getChildren(), collapsed);
  }
}

function blockLink(blockId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("block", blockId);
  return url.toString();
}

/** Provides real block actions without exposing transient IDs in the authoring surface. */
export function BlockContextMenuPlugin({ labels, onFocusBlock, onOpenInSidebar, sourceDocId }: BlockContextMenuPluginProps): React.ReactNode {
  const [editor] = useLexicalComposerContext();
  const [menu, setMenu] = useState<BlockContextMenuState | null>(null);
  const [refSubmenuOpen, setRefSubmenuOpen] = useState(false);

  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return undefined;
    const onContextMenu = (event: MouseEvent) => {
      const nextMenu = menuStateFromTarget(event.target, event.clientX, event.clientY);
      if (!nextMenu) return;
      event.preventDefault();
      setMenu(nextMenu);
      setRefSubmenuOpen(false);
    };
    root.addEventListener("contextmenu", onContextMenu);
    return () => root.removeEventListener("contextmenu", onContextMenu);
  }, [editor]);

  useEffect(() => {
    if (!menu) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-mega-content="block-context-menu"]')) return;
      setMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menu]);

  const copy = useCallback((value: string) => {
    void navigator.clipboard?.writeText(value);
    setMenu(null);
  }, []);

  const copyBlockReference = useCallback((blockId: string) => {
    const syntax = `((${blockId}))`;
    const clipboard = navigator.clipboard;
    if (sourceDocId && clipboard?.write && typeof ClipboardItem !== "undefined") {
      const marker = document.createElement("span");
      marker.dataset.megaBlockRefDoc = sourceDocId;
      marker.dataset.megaBlockRefBlock = blockId;
      marker.textContent = syntax;
      void clipboard.write([new ClipboardItem({
        "text/plain": new Blob([syntax], { type: "text/plain" }),
        "text/html": new Blob([marker.outerHTML], { type: "text/html" }),
      })]).catch(() => clipboard.writeText(syntax));
      setMenu(null);
    } else copy(syntax);
    // Focus synchronously: a queued editor.focus() can restore the old source
    // selection after the user has already clicked the destination row.
    editor.getRootElement()?.focus({ preventScroll: true });
  }, [copy, editor, sourceDocId]);

  const copyEmbed = useCallback((blockId: string) => {
    const syntax = `{{[[embed]]: ((${blockId}))}}`;
    const clipboard = navigator.clipboard;
    if (sourceDocId && clipboard?.write && typeof ClipboardItem !== "undefined") {
      const marker = document.createElement("span");
      marker.dataset.megaEmbedDoc = sourceDocId;
      marker.dataset.megaEmbedBlock = blockId;
      marker.textContent = syntax;
      void clipboard.write([new ClipboardItem({
        "text/plain": new Blob([syntax], { type: "text/plain" }),
        "text/html": new Blob([marker.outerHTML], { type: "text/html" }),
      })]).catch((error: unknown) => {
        if (error instanceof DOMException) return clipboard.writeText(syntax);
        throw error;
      });
      setMenu(null);
      // The menu button takes focus; the next paste must reach the editor.
      editor.focus();
      return;
    }
    copy(syntax);
    editor.focus();
  }, [copy, editor, sourceDocId]);

  useEffect(() => editor.registerCommand(KEY_DOWN_COMMAND, (event) => {
    if (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "o" && onOpenInSidebar) {
      const blockId = editor.getEditorState().read(() => $getSelectedMegaBlock()?.getBlockId());
      if (!blockId) return false;
      event.preventDefault();
      onOpenInSidebar(blockId);
      return true;
    }
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return false;
    const key = event.key.toLowerCase();
    if (key !== "e" && key !== "c") return false;
    const blockId = editor.getEditorState().read(() => $getSelectedMegaBlock()?.getBlockId());
    if (!blockId) return false;
    event.preventDefault();
    if (key === "e") copyEmbed(blockId);
    else {
      copyBlockReference(blockId);
    }
    return true;
  }, COMMAND_PRIORITY_LOW), [copyBlockReference, copyEmbed, editor, onOpenInSidebar]);

  const runAction = useCallback((action: BlockContextAction) => {
    if (!menu) return;
    if (action === "copyBlockRef" || action === "copyBlockId") {
      copyBlockReference(menu.blockId);
      return;
    }
    if (action === "copyBlockLink") {
      copy(blockLink(menu.blockId));
      return;
    }
    if (action === "copyEmbed") {
      copyEmbed(menu.blockId);
      return;
    }
    if (action === "focusBlock") {
      if (onFocusBlock) {
        onFocusBlock(menu.blockId);
        setMenu(null);
        return;
      }
      const element = [...(editor.getRootElement()?.querySelectorAll<HTMLElement>("[data-block-id]") ?? [])]
        .find((candidate) => candidate.dataset.blockId === menu.blockId);
      element?.scrollIntoView({ block: "center", inline: "nearest" });
      editor.update(() => findBlock(menu.blockId, $getRoot().getChildren())?.selectEnd());
      editor.focus();
      setMenu(null);
      return;
    }
    if (action === "openInSidebar") {
      onOpenInSidebar?.(menu.blockId);
      setMenu(null);
      return;
    }
    editor.update(() => {
      if (action === "expandAll" || action === "collapseAll") {
        const block = findBlock(menu.blockId, $getRoot().getChildren());
        if (block) setCollapsed([block], action === "collapseAll");
        return;
      }
      const block = findBlock(menu.blockId, $getRoot().getChildren());
      if (!block) return;
      if (action === "todo") {
        block.setVariant(menu.isTodo ? "text" : "todo");
        block.setTodoChecked(false);
        return;
      }
      block.setVariant(action);
      block.setTodoChecked(false);
    });
    setMenu(null);
  }, [copy, copyBlockReference, copyEmbed, editor, menu, onFocusBlock, onOpenInSidebar]);

  if (!menu || typeof document === "undefined") return null;
  return createPortal(
    <div
      aria-label={labels.ariaLabel}
      data-mega-content="block-context-menu"
      role="menu"
      style={{ left: menu.left, top: menu.top }}
    >
      <div data-mega-content="block-context-group">
        <div
          data-mega-content="block-context-submenu-host"
          onMouseEnter={() => setRefSubmenuOpen(true)}
          onMouseLeave={() => setRefSubmenuOpen(false)}
        >
          <button
            aria-expanded={refSubmenuOpen}
            aria-haspopup="menu"
            data-mega-content="block-context-action"
            onClick={() => runAction("copyBlockRef")}
            onFocus={() => setRefSubmenuOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault();
                setRefSubmenuOpen(true);
                requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-mega-content="block-context-submenu"] [data-mega-content="block-context-action"]')?.focus());
              }
            }}
            role="menuitem"
            type="button"
          >
            <span>{labels.copyBlockRef}</span>
            <span data-mega-content="block-context-shortcut">⌘⇧C</span>
            <span aria-hidden="true" data-mega-content="block-context-chevron">▸</span>
          </button>
          {refSubmenuOpen ? (
            <div
              aria-label={labels.copyBlockRef}
              data-mega-content="block-context-submenu"
              data-side={menu.left > window.innerWidth - 480 ? "left" : "right"}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setRefSubmenuOpen(false);
                  document.querySelector<HTMLElement>('[data-mega-content="block-context-submenu-host"] > button')?.focus();
                }
              }}
              role="menu"
            >
              <button data-mega-content="block-context-action" onClick={() => runAction("copyEmbed")} role="menuitem" type="button">
                <span>{labels.copyEmbed}</span>
                <span data-mega-content="block-context-shortcut">⌘⇧E</span>
              </button>
              <button data-mega-content="block-context-action" onClick={() => runAction("copyBlockId")} role="menuitem" type="button">
                {labels.copyBlockId}
              </button>
            </div>
          ) : null}
        </div>
        <button data-mega-content="block-context-action" onClick={() => runAction("copyBlockLink")} role="menuitem" type="button">
          {labels.copyBlockLink}
        </button>
        <button data-mega-content="block-context-action" onClick={() => runAction("focusBlock")} role="menuitem" type="button">
          {labels.focusBlock}
        </button>
        {onOpenInSidebar ? (
          <button data-mega-content="block-context-action" onClick={() => runAction("openInSidebar")} role="menuitem" type="button">
            {labels.openInSidebar}
          </button>
        ) : null}
      </div>
      <div aria-hidden="true" data-mega-content="block-context-divider" />
      <div data-mega-content="block-context-group">
        <button data-mega-content="block-context-action" onClick={() => runAction("expandAll")} role="menuitem" type="button">
          {labels.expandAll}
        </button>
        <button data-mega-content="block-context-action" onClick={() => runAction("collapseAll")} role="menuitem" type="button">
          {labels.collapseAll}
        </button>
      </div>
      <div aria-hidden="true" data-mega-content="block-context-divider" />
      <div data-mega-content="block-context-group">
        <button data-mega-content="block-context-action" onClick={() => runAction("todo")} role="menuitem" type="button">
          {menu.isTodo ? labels.removeTodo : labels.makeTodo}
        </button>
      </div>
      <div aria-hidden="true" data-mega-content="block-context-divider" />
      <div aria-label={labels.textStyle} data-mega-content="block-context-heading-group" role="group">
        <button aria-label={labels.heading1} data-mega-content="block-context-heading" onClick={() => runAction("h1")} role="menuitem" type="button">H1</button>
        <button aria-label={labels.heading2} data-mega-content="block-context-heading" onClick={() => runAction("h2")} role="menuitem" type="button">H2</button>
        <button aria-label={labels.heading3} data-mega-content="block-context-heading" onClick={() => runAction("h3")} role="menuitem" type="button">H3</button>
      </div>
    </div>,
    document.body,
  );
}
