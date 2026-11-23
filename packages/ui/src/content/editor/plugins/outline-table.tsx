"use client";

import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { $createParagraphNode, $getNodeByKey, $getRoot, $getSelection, $isRangeSelection, REDO_COMMAND, UNDO_COMMAND, type LexicalEditor } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createMegaBlock, $ensureTableCell, $findMegaBlockById, $isMegaBlockNode,
  $isMegaOutlineTableNode, $isPlainTableCell, $setTableCellText, $tableCellText, $tableRows,
  generateBlockId, type MegaBlockNode,
} from "@megaui/content";
import { en, zhCN } from "@megaui/i18n";

type Cell = { blockId: string; text: string; editable: boolean };
type TableView = { rows: Cell[][]; columns: number; sourceExists: boolean };
type ActiveCell = { row: number; column: number } | null;
type Action = "addRow" | "addColumn" | "deleteRow" | "deleteColumn" | "deleteTable";
const ACTIONS: readonly Action[] = ["addRow", "addColumn", "deleteRow", "deleteColumn", "deleteTable"];
const pendingTableFocus = new WeakMap<LexicalEditor, { sourceId: string; cellId: string }>();

export function requestNewTableFocus(editor: LexicalEditor, sourceId: string, cellId: string): void {
  pendingTableFocus.set(editor, { sourceId, cellId });
}

function TableCellEditor({ cell, row, column, columns, rowCount, isChinese, editable, onEdit, onFocus, onAction }: {
  cell: Cell | undefined;
  row: number;
  column: number;
  columns: number;
  rowCount: number;
  isChinese: boolean;
  editable: boolean;
  onEdit: (value: string) => void;
  onFocus: () => void;
  onAction: (action: Action) => void;
}): React.JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [draft, setDraft] = useState(cell?.text ?? "");
  const composing = useRef(false);
  useEffect(() => {
    if (!composing.current) setDraft(cell?.text ?? "");
  }, [cell?.text]);

  const focusCell = (targetRow: number, targetColumn: number, element: HTMLTextAreaElement) => {
    const table = element.closest<HTMLElement>('[data-mega-content="outline-table-view"]');
    table?.querySelectorAll<HTMLTextAreaElement>('[data-mega-content="outline-table-cell"]')[targetRow * columns + targetColumn]?.focus();
  };

  return <textarea
    aria-label={isChinese ? `第 ${row + 1} 行，第 ${column + 1} 列` : `Row ${row + 1}, column ${column + 1}`}
    data-mega-content="outline-table-cell"
    onChange={(event) => {
      const value = event.target.value;
      setDraft(value);
      if (!composing.current) onEdit(value);
    }}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={(event) => {
      composing.current = false;
      onEdit(event.currentTarget.value);
    }}
    onFocus={onFocus}
    onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        if (editor.dispatchCommand(event.shiftKey ? REDO_COMMAND : UNDO_COMMAND, undefined)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (!editable || composing.current) return;
      if (event.key !== "Tab" && (event.key !== "Enter" || event.shiftKey)) return;
      if (event.key === "Tab" && event.shiftKey && row === 0 && column === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const nextRow = event.key === "Tab" ? row + (event.shiftKey ? (column === 0 ? -1 : 0) : (column === columns - 1 ? 1 : 0)) : row + 1;
      const nextColumn = event.key === "Tab" ? (event.shiftKey ? (column === 0 ? columns - 1 : column - 1) : (column + 1) % columns) : column;
      if (nextRow < 0) return;
      if (nextRow >= rowCount) {
        const element = event.currentTarget;
        onAction("addRow");
        requestAnimationFrame(() => focusCell(nextRow, nextColumn, element));
      } else {
        focusCell(nextRow, nextColumn, event.currentTarget);
      }
    }}
    readOnly={!editable || cell?.editable === false}
    rows={1}
    title={cell?.editable === false ? (isChinese ? "请在下方大纲编辑带格式内容" : "Edit formatted content in the outline below") : undefined}
    value={draft}
  />;
}

function $addColumn(source: MegaBlockNode, column: number): void {
  for (const row of $tableRows(source)) {
    const parent = $ensureTableCell(row[0]!, column);
    const nested = parent.getChildren().filter($isMegaBlockNode);
    const inserted = $createMegaBlock("text", generateBlockId());
    if (nested[0]) nested[0].insertBefore(inserted);
    else parent.append(inserted);
    for (const child of nested) inserted.append(child);
  }
}

function $deleteColumn(source: MegaBlockNode, column: number): void {
  for (const cells of $tableRows(source)) {
    const cell = cells[column];
    if (!cell) continue;
    if (column === 0) {
      const next = cells[1];
      for (const child of cell.getChildren().filter((node) => !$isMegaBlockNode(node))) child.remove();
      if (next) {
        for (const child of next.getChildren()) next.insertBefore(child);
        next.remove();
      }
    } else {
      for (const child of cell.getChildren().filter($isMegaBlockNode)) cell.insertBefore(child);
      cell.remove();
    }
  }
}

/** A live projection of nested blocks; typing in either view updates the same Lexical nodes. */
export function OutlineTableView({ sourceBlockId, nodeKey }: { sourceBlockId: string; nodeKey: string }): React.JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [view, setView] = useState<TableView>({ rows: [], columns: 1, sourceExists: false });
  const [active, setActive] = useState<ActiveCell>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const sourceKey = useRef<string | null>(null);
  const isChinese = typeof document !== "undefined" && document.documentElement.lang.startsWith("zh");
  const labels = (isChinese ? zhCN : en).workspace.docEdit.tableControls;

  const $source = useCallback((): MegaBlockNode | null => {
    const cached = sourceKey.current ? $getNodeByKey(sourceKey.current) : null;
    if ($isMegaBlockNode(cached) && cached.getBlockId() === sourceBlockId) return cached;
    const found = $findMegaBlockById(sourceBlockId);
    sourceKey.current = found?.getKey() ?? null;
    return found;
  }, [sourceBlockId]);

  const sync = useCallback(() => {
    const emptyCellKeys: string[] = [];
    editor.getEditorState().read(() => {
      const source = $source();
      const rows = source ? $tableRows(source).map((cells) => cells.map((cell) => {
        if (editor.isEditable() && $isMegaBlockNode(cell.getFirstChild())) emptyCellKeys.push(cell.getKey());
        return { blockId: cell.getBlockId(), text: $tableCellText(cell), editable: $isPlainTableCell(cell) };
      })) : [];
      setView({ rows, columns: Math.max(1, ...rows.map((row) => row.length)), sourceExists: Boolean(source) });
    });
    // Yjs applies remote state with skipTransforms. Repair legacy empty cell
    // lines once after loading, as well as through the normal local invariant.
    if (emptyCellKeys.length) editor.update(() => {
      for (const key of emptyCellKeys) {
        const cell = $getNodeByKey(key);
        const first = $isMegaBlockNode(cell) ? cell.getFirstChild() : null;
        if ($isMegaBlockNode(first)) first.insertBefore($createParagraphNode());
      }
    });
  }, [$source, editor]);

  useEffect(() => {
    sync();
    return editor.registerUpdateListener(sync);
  }, [editor, sync]);

  useEffect(() => {
    const pending = pendingTableFocus.get(editor);
    if (!pending || pending.sourceId !== sourceBlockId || !view.sourceExists || !view.rows[0]?.[0]) return;
    pendingTableFocus.delete(editor);
    const stillSelected = editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      let node = selection.anchor.getNode();
      while (node) {
        if ($isMegaBlockNode(node) && node.getBlockId() === pending.cellId) return true;
        const parent = node.getParent();
        if (!parent) break;
        node = parent;
      }
      return false;
    });
    if (stillSelected) tableRef.current?.querySelector<HTMLTextAreaElement>('[data-mega-content="outline-table-cell"]')?.focus();
  }, [editor, sourceBlockId, view]);

  const editCell = useCallback((row: number, column: number, value: string) => {
    editor.update(() => {
      const source = $source();
      const targetRow = source && $tableRows(source)[row]?.[0];
      if (targetRow) {
        const cell = $ensureTableCell(targetRow, column);
        if ($isPlainTableCell(cell)) $setTableCellText(cell, value);
      }
    });
  }, [$source, editor]);

  const run = useCallback((action: Action, rowIndex: number, columnIndex: number) => {
    editor.update(() => {
      const source = $source();
      if (!source) return;
      const rows = $tableRows(source);
      if (action === "deleteTable") {
        const table = $getNodeByKey(nodeKey);
        if ($isMegaOutlineTableNode(table)) table.remove();
        source.remove();
        if ($getRoot().getChildrenSize() === 0) $getRoot().append($createMegaBlock("text", generateBlockId()));
        return;
      }
      if (action === "addRow") {
        const row = $createMegaBlock("text", generateBlockId());
        $ensureTableCell(row, view.columns - 1);
        const after = rows[rowIndex]?.[0];
        if (after) after.insertAfter(row);
        else source.append(row);
        return;
      }
      if (action === "deleteRow") {
        if (rows.length > 1) rows[rowIndex]?.[0]?.remove();
        else if (rows[0]) for (const cell of rows[0]) $setTableCellText(cell, "");
        return;
      }
      if (action === "addColumn") { if (view.columns < 32) $addColumn(source, columnIndex); return; }
      if (view.columns > 1) $deleteColumn(source, columnIndex);
      else for (const cells of rows) $setTableCellText(cells[0]!, "");
    });
  }, [$source, editor, nodeKey, view.columns]);

  const removeOrphan = useCallback(() => editor.update(() => {
    const table = $getNodeByKey(nodeKey);
    if ($isMegaOutlineTableNode(table)) table.remove();
    if ($getRoot().getChildrenSize() === 0) $getRoot().append($createMegaBlock("text", generateBlockId()));
  }), [editor, nodeKey]);

  return <div
    contentEditable={false}
    data-mega-content="outline-table-view"
    ref={tableRef}
    onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setActive(null);
    }}
  >
    {!view.sourceExists ? <div data-mega-content="outline-table-missing">
      {isChinese ? "表格来源已删除" : "Table source was deleted"}
      {editor.isEditable() ? <button onClick={removeOrphan} type="button">{labels.deleteTable}</button> : null}
    </div> : (
      <>
      <div data-mega-content="outline-table-scroll"><table aria-label={isChinese ? "表格" : "Table"}>
        <tbody>{view.rows.map((row, rowIndex) => <tr key={row[0]?.blockId ?? rowIndex}>
          {Array.from({ length: view.columns }, (_, columnIndex) => {
            const cell = row[columnIndex];
            return <td key={cell?.blockId ?? columnIndex}>
              <TableCellEditor
                cell={cell}
                column={columnIndex}
                columns={view.columns}
                editable={editor.isEditable()}
                isChinese={isChinese}
                onAction={(action) => run(action, rowIndex, columnIndex)}
                onEdit={(value) => editCell(rowIndex, columnIndex, value)}
                onFocus={() => setActive({ row: rowIndex, column: columnIndex })}
                row={rowIndex}
                rowCount={view.rows.length}
              />
            </td>;
          })}
        </tr>)}</tbody>
      </table></div>
      {active && editor.isEditable() ? <div data-mega-content="outline-table-actions">
        {ACTIONS.map((action) => <button
          aria-label={labels[action]}
          disabled={action === "addColumn" && view.columns >= 32}
          key={action}
          onClick={() => run(action, active.row, active.column)}
          onPointerDown={(event) => event.preventDefault()}
          title={labels[action]}
          type="button"
        >{labels[action]}</button>)}
      </div> : null}
      </>
    )}
  </div>;
}
