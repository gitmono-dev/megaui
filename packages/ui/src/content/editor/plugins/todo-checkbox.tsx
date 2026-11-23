"use client";

import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { $getRoot, type LexicalNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isMegaBlockNode, type MegaBlockNode } from "@megaui/content";

export interface TodoCheckboxLabels {
  readonly markComplete: string;
  readonly markIncomplete: string;
}

type TodoCheckboxControl = Readonly<{
  blockId: string;
  checked: boolean;
  left: number;
  top: number;
}>;

function collectTodoControls(root: HTMLElement, overlay: HTMLElement): readonly TodoCheckboxControl[] {
  const overlayRect = overlay.getBoundingClientRect();
  return [...root.querySelectorAll<HTMLElement>('[data-mega-block="todo"][data-block-id]')].flatMap((block) => {
    const blockId = block.dataset.blockId;
    if (!blockId) return [];
    if (block.closest('[data-mega-content="reader"]')) return [];
    if (root.closest('[data-mega-content="outliner"]')?.hasAttribute("data-mega-block-focus") && !block.hasAttribute("data-mega-block-focus")) return [];
    if (block.parentElement?.closest('[data-mega-block][data-collapsed="true"]')) return [];
    const rect = block.getBoundingClientRect();
    return [{
      blockId,
      checked: block.dataset.todoChecked === "true",
      left: rect.left - overlayRect.left + 12,
      top: rect.top - overlayRect.top + 7,
    }];
  });
}

function controlsMatch(left: readonly TodoCheckboxControl[], right: readonly TodoCheckboxControl[]): boolean {
  return left.length === right.length && left.every((control, index) => {
    const candidate = right[index];
    return candidate?.blockId === control.blockId
      && candidate.checked === control.checked
      && candidate.left === control.left
      && candidate.top === control.top;
  });
}

function findTodoBlock(blockId: string, nodes: readonly LexicalNode[]): MegaBlockNode | null {
  for (const node of nodes) {
    if (!$isMegaBlockNode(node)) continue;
    if (node.getBlockId() === blockId && node.getVariant() === "todo") return node;
    const nested = findTodoBlock(blockId, node.getChildren());
    if (nested) return nested;
  }
  return null;
}

/** Renders editable TODO controls outside Lexical's managed contentEditable tree. */
export function TodoCheckboxPlugin({ labels }: { readonly labels: TodoCheckboxLabels }): React.JSX.Element {
  const [editor] = useLexicalComposerContext();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [controls, setControls] = useState<readonly TodoCheckboxControl[]>([]);

  const syncControls = useCallback(() => {
    const root = editor.getRootElement();
    const overlay = overlayRef.current;
    if (!root || !overlay) return;
    const next = collectTodoControls(root, overlay);
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

  const toggle = useCallback((blockId: string) => {
    editor.update(() => {
      const block = findTodoBlock(blockId, $getRoot().getChildren());
      if (block) block.setTodoChecked(!block.getTodoChecked());
    });
  }, [editor]);

  return (
    <div data-mega-content="todo-overlay" ref={overlayRef}>
      {controls.map((control) => (
        <button
          aria-label={control.checked ? labels.markIncomplete : labels.markComplete}
          aria-pressed={control.checked}
          data-block-id={control.blockId}
          data-mega-content="todo-check"
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
