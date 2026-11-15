"use client";

import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { $getRoot, type LexicalNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isMegaBlockNode, type MegaBlockNode } from "@megaui/content";

export interface BlockCollapseLabels {
  readonly collapse: string;
  readonly expand: string;
}

type CollapseControl = Readonly<{
  blockId: string;
  collapsed: boolean;
  tableOutline: boolean;
  left: number;
  top: number;
}>;

function collectCollapseControls(root: HTMLElement, overlay: HTMLElement): readonly CollapseControl[] {
  const overlayRect = overlay.getBoundingClientRect();
  const focusedOutline = root.closest('[data-mega-content="outliner"]');
  const tables = [...root.querySelectorAll<HTMLElement>('[data-mega-outline-table][data-source-block-id]')];
  return [...root.querySelectorAll<HTMLElement>('[data-mega-block][data-block-id]')].flatMap((block) => {
    const blockId = block.dataset.blockId;
    if (!blockId || ![...block.children].some((child) => child.hasAttribute("data-mega-block"))) return [];
    if (block.closest('[data-mega-content="reader"]')) return [];
    if (block.parentElement?.closest('[data-mega-block][data-collapsed="true"]')) return [];
    if (focusedOutline?.hasAttribute("data-mega-block-focus") && !block.hasAttribute("data-mega-block-focus")) return [];
    const table = block.dataset.megaTableSource === "true"
      ? tables.find((view) => view.dataset.sourceBlockId === blockId)
      : undefined;
    const rect = (table ?? block).getBoundingClientRect();
    return [{
      blockId,
      collapsed: block.dataset.collapsed === "true",
      tableOutline: Boolean(table),
      left: rect.left - overlayRect.left - (table ? 36.5 : 12.5),
      top: rect.top - overlayRect.top + 7,
    }];
  });
}

function controlsMatch(left: readonly CollapseControl[], right: readonly CollapseControl[]): boolean {
  return left.length === right.length && left.every((control, index) => {
    const candidate = right[index];
    return candidate?.blockId === control.blockId
      && candidate.collapsed === control.collapsed
      && candidate.tableOutline === control.tableOutline
      && candidate.left === control.left
      && candidate.top === control.top;
  });
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

/** Places fold controls next to bullets without mutating Lexical's managed DOM. */
export function BlockCollapsePlugin({ labels }: { readonly labels: BlockCollapseLabels }): React.JSX.Element {
  const [editor] = useLexicalComposerContext();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [controls, setControls] = useState<readonly CollapseControl[]>([]);
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);

  const syncControls = useCallback(() => {
    const root = editor.getRootElement();
    const overlay = overlayRef.current;
    if (!root || !overlay) return;
    const next = collectCollapseControls(root, overlay);
    setControls((current) => controlsMatch(current, next) ? current : next);
  }, [editor]);

  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return undefined;
    syncControls();
    const unregisterUpdate = editor.registerUpdateListener(syncControls);
    const observer = new MutationObserver(syncControls);
    observer.observe(root, { attributes: true, childList: true, subtree: true });
    window.addEventListener("resize", syncControls);
    return () => {
      unregisterUpdate();
      observer.disconnect();
      window.removeEventListener("resize", syncControls);
    };
  }, [editor, syncControls]);

  useEffect(() => {
    const root = editor.getRootElement();
    const wrapper = root?.closest<HTMLElement>('[data-mega-content="editor"]');
    if (!root || !wrapper) return undefined;
    const onPointerMove = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const toggle = target.closest<HTMLElement>('[data-mega-content="collapse-toggle"]');
      if (toggle && overlayRef.current?.contains(toggle)) {
        setHoveredBlockId(toggle.dataset.blockId ?? null);
        return;
      }
      const block = target.closest<HTMLElement>('[data-mega-block][data-block-id]');
      if (!block || !root.contains(block)) {
        setHoveredBlockId(null);
        return;
      }
      const rect = block.getBoundingClientRect();
      const nearBullet = event.clientX >= rect.left - 12 && event.clientX <= rect.left + 23
        && event.clientY >= rect.top && event.clientY <= rect.top + 28;
      const hasChildren = [...block.children].some((child) => child.hasAttribute("data-mega-block"));
      setHoveredBlockId(nearBullet && hasChildren ? block.dataset.blockId ?? null : null);
    };
    const onPointerLeave = () => setHoveredBlockId(null);
    wrapper.addEventListener("pointermove", onPointerMove);
    wrapper.addEventListener("pointerleave", onPointerLeave);
    return () => {
      wrapper.removeEventListener("pointermove", onPointerMove);
      wrapper.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [editor]);

  const toggle = useCallback((blockId: string) => {
    editor.update(() => {
      const block = findBlock(blockId, $getRoot().getChildren());
      if (block) block.setCollapsed(!block.getCollapsed());
    });
  }, [editor]);

  return (
    <div data-mega-content="collapse-overlay" ref={overlayRef}>
      {controls.map((control) => (
        <button
          aria-expanded={!control.collapsed}
          aria-label={control.collapsed ? labels.expand : labels.collapse}
          data-block-id={control.blockId}
          data-hovered={hoveredBlockId === control.blockId}
          data-mega-content="collapse-toggle"
          data-table-outline={control.tableOutline}
          key={control.blockId}
          onClick={() => toggle(control.blockId)}
          onPointerDown={(event) => event.preventDefault()}
          style={{ left: control.left, top: control.top }}
          type="button"
        />
      ))}
    </div>
  );
}
