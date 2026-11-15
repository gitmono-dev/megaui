"use client";

import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { $getNodeByKey, $getRoot, $getSelection, $isRangeSelection, COMMAND_PRIORITY_LOW, SELECTION_CHANGE_COMMAND, type ElementNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $deleteTableColumnAtSelection, $deleteTableRowAtSelection, $getTableCellNodeFromLexicalNode, $insertTableColumnAtNode, $insertTableRowAtNode, $isTableCellNode, $isTableNode, $isTableRowNode, type TableNode } from "@lexical/table";
import { $createMegaBlock, generateBlockId } from "@megaui/content";

export interface TableControlsLabels {
  addRow: string;
  addColumn: string;
  deleteRow: string;
  deleteColumn: string;
  deleteTable: string;
}

type TableAction = keyof TableControlsLabels;
type TablePosition = { key: string; left: number; top: number };

function removeTableWrapper(wrapper: ElementNode): void {
  if (wrapper.getParent() === $getRoot() && $getRoot().getChildrenSize() === 1) {
    const starter = $createMegaBlock("text", generateBlockId());
    wrapper.replace(starter);
    starter.selectStart();
  } else {
    wrapper.remove();
  }
}

function removeTable(table: TableNode): void {
  const wrapper = table.getParent();
  if (wrapper) removeTableWrapper(wrapper);
}

/** Keeps row/column actions outside Lexical's managed table DOM. */
export function TableControlsPlugin({ labels }: { labels: TableControlsLabels }) {
  const [editor] = useLexicalComposerContext();
  const [position, setPosition] = useState<TablePosition | null>(null);

  const sync = useCallback(() => {
    const wrapper = editor.getRootElement()?.closest<HTMLElement>('[data-mega-content="editor"]');
    if (!wrapper) return;
    let key: string | null = null;
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      key = $getTableCellNodeFromLexicalNode(selection.anchor.getNode())?.getKey() ?? null;
    });
    if (!key) { setPosition(null); return; }
    const cell = editor.getElementByKey(key);
    const table = cell?.closest("table");
    if (!table) { setPosition(null); return; }
    const rect = table.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    setPosition({ key, left: rect.left - wrapperRect.left, top: rect.top - wrapperRect.top - 27 });
  }, [editor]);

  useEffect(() => {
    const unsubscribeSelection = editor.registerCommand(SELECTION_CHANGE_COMMAND, () => {
      queueMicrotask(sync);
      return false;
    }, COMMAND_PRIORITY_LOW);
    const unsubscribeUpdate = editor.registerUpdateListener(sync);
    window.addEventListener("resize", sync);
    return () => {
      unsubscribeSelection();
      unsubscribeUpdate();
      window.removeEventListener("resize", sync);
    };
  }, [editor, sync]);

  const run = useCallback((action: TableAction) => {
    if (!position) return;
    editor.update(() => {
      const cell = $getNodeByKey(position.key);
      if (!$isTableCellNode(cell)) return;
      const row = cell.getParent();
      const table = row?.getParent();
      if (!$isTableRowNode(row) || !$isTableNode(table)) return;
      if (action === "addRow") { $insertTableRowAtNode(cell, true); return; }
      if (action === "addColumn") { $insertTableColumnAtNode(cell, true); return; }
      if (action === "deleteTable") { removeTable(table); return; }
      const wrapper = table.getParent();
      cell.selectStart();
      if (action === "deleteRow") {
        $deleteTableRowAtSelection();
        if (wrapper?.isAttached() && wrapper.getChildrenSize() === 0) removeTableWrapper(wrapper);
        return;
      }
      $deleteTableColumnAtSelection();
      if (wrapper?.isAttached() && wrapper.getChildrenSize() === 0) removeTableWrapper(wrapper);
    });
    queueMicrotask(sync);
  }, [editor, position, sync]);

  if (!position) return null;
  return (
    <div data-mega-content="table-controls" style={{ background: "var(--mega-bg)", border: "1px solid var(--mega-border)", borderRadius: 4, display: "flex", gap: 2, left: position.left, padding: 2, position: "absolute", top: position.top, zIndex: 5 }}>
      {(Object.keys(labels) as TableAction[]).map((action) => (
        <button key={action} onClick={() => run(action)} onPointerDown={(event) => event.preventDefault()} title={labels[action]} type="button" style={{ background: "transparent", border: 0, cursor: "pointer", fontSize: 11, padding: "2px 5px" }}>{labels[action]}</button>
      ))}
    </div>
  );
}
