// @vitest-environment happy-dom
import * as React from "react";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { $getRoot, type LexicalEditor } from "lexical";
import { $createTableNodeWithDimensions } from "@lexical/table";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createMegaTableBlock, createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import { MegaContentEditor } from "../editor";
import { TableControlsPlugin } from "./table-controls";

afterEach(cleanup);

const labels = { addRow: "+ row", addColumn: "+ column", deleteRow: "Delete row", deleteColumn: "Delete column", deleteTable: "Delete table" };

function Capture({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => onReady(editor), [editor, onReady]);
  return null;
}

describe("TableControlsPlugin", () => {
  it("adds rows and columns and deletes the selected table", async () => {
    let editor!: LexicalEditor;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <TableControlsPlugin labels={labels} />
        <Capture onReady={(value) => { editor = value; }} />
      </MegaContentEditor>,
    );
    act(() => editor.update(() => {
      const table = $createMegaTableBlock("table-1");
      table.append($createTableNodeWithDimensions(2, 2, false));
      $getRoot().append(table);
      table.selectStart();
    }, { discrete: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: labels.addRow })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: labels.addRow }));
    await waitFor(() => expect(editor.getRootElement()?.querySelectorAll("table tr")).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: labels.addColumn }));
    await waitFor(() => expect(editor.getRootElement()?.querySelectorAll("table tr:first-child td")).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: labels.deleteRow }));
    await waitFor(() => expect(editor.getRootElement()?.querySelectorAll("table tr")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: labels.deleteColumn }));
    await waitFor(() => expect(editor.getRootElement()?.querySelectorAll("table tr:first-child td")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: labels.deleteTable }));
    await waitFor(() => expect(editor.getRootElement()?.querySelector("table")).not.toBeInTheDocument());
  });

  it("keeps a valid starter block when deleting a document's only table", async () => {
    let editor!: LexicalEditor;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <TableControlsPlugin labels={labels} />
        <Capture onReady={(value) => { editor = value; }} />
      </MegaContentEditor>,
    );
    act(() => editor.update(() => {
      const table = $createMegaTableBlock("only-table");
      table.append($createTableNodeWithDimensions(1, 1, false));
      $getRoot().clear();
      $getRoot().append(table);
      table.selectStart();
    }, { discrete: true }));
    fireEvent.click(await screen.findByRole("button", { name: labels.deleteTable }));
    await waitFor(() => expect(editor.getRootElement()?.querySelectorAll("[data-mega-block]")).toHaveLength(1));
    expect(editor.getRootElement()?.querySelector("table")).not.toBeInTheDocument();
  });
});
