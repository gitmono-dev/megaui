// @vitest-environment happy-dom
import * as React from "react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { $createTextNode, $getRoot, KEY_ARROW_DOWN_COMMAND, KEY_ENTER_COMMAND, type LexicalEditor } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createOutlineTable, $findMegaBlockById, $isMegaBlockNode, $setTableCellText, createEmptyMegaDocumentEditorStateJSON, type MegaBlockNode } from "@megaui/content";
import { MegaContentEditor } from "../editor";
import { EditorOutlineTableNode } from "../outline-table-node";
import { QuickCommandsPlugin } from "./quick-commands";

afterEach(cleanup);

function EditorCapture({ onReady }: { onReady: (editor: LexicalEditor) => void }): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    onReady(editor);
  }, [editor, onReady]);
  return null;
}

const LABELS = {
  ariaLabel: "Quick commands",
  blockReference: "Block reference",
  pageReference: "Page reference",
  tagPage: "Tag page",
  todo: "TODO",
  table: "Table",
  image: "Image",
};

function seedText(editor: LexicalEditor, text: string): void {
  act(() => {
    editor.update(
      () => {
        const block = $getRoot().getFirstChild();
        if (!$isMegaBlockNode(block)) throw new Error("Expected the document seed block");
        block.clear();
        const node = $createTextNode(text);
        block.append(node);
        node.select(text.length, text.length);
      },
      { discrete: true },
    );
  });
}

function readFirstBlock(editor: LexicalEditor): { text: string; variant: MegaBlockNode["getVariant"] extends () => infer Variant ? Variant : never } {
  let result: { text: string; variant: MegaBlockNode["getVariant"] extends () => infer Variant ? Variant : never } | null = null;
  editor.getEditorState().read(() => {
    const candidate = $getRoot().getFirstChild();
    if ($isMegaBlockNode(candidate)) {
      result = { text: candidate.getTextContent(), variant: candidate.getVariant() };
    }
  });
  if (!result) throw new Error("Expected a MegaBlockNode");
  return result;
}

describe("QuickCommandsPlugin (/ typeahead)", () => {
  it("restores empty first-column lines when collaboration loads a table without running transforms", async () => {
    let editor!: LexicalEditor;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <EditorCapture onReady={(ready) => { editor = ready; }} />
      </MegaContentEditor>,
    );
    act(() => editor.update(() => {
      const { table, source } = $createOutlineTable(2, 2, (id, sourceId) => new EditorOutlineTableNode(id, sourceId));
      $getRoot().clear().append(table, source);
    }, { discrete: true, skipTransforms: true, tag: "collaboration" }));
    await waitFor(() => expect(editor.getRootElement()?.querySelectorAll('[data-mega-table-source] > [data-mega-block] > p')).toHaveLength(2));
    const firstCell = screen.getByRole("textbox", { name: "Row 1, column 1" });
    expect(firstCell).not.toHaveAttribute("readonly");
    fireEvent.change(firstCell, { target: { value: "Restored first column" } });
    await waitFor(() => expect(editor.getRootElement()?.querySelector('[data-mega-table-source] > [data-mega-block] > p')).toHaveTextContent("Restored first column"));
  });

  it("opens Roam-style actions and leaves a page-reference trigger selected", async () => {
    let editor!: LexicalEditor;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <QuickCommandsPlugin labels={LABELS} />
        <EditorCapture onReady={(readyEditor) => {
          editor = readyEditor;
        }} />
      </MegaContentEditor>,
    );

    seedText(editor, "/");

    await waitFor(() => expect(screen.getByRole("listbox", { name: "Quick commands" })).toBeInTheDocument());
    expect(screen.getByRole("option", { name: "TODO" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Page reference" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Block reference" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Tag page" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Table" })).toBeInTheDocument();

    const pageReference = screen.getByRole("option", { name: "Page reference" });
    await act(async () => {
      pageReference.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      pageReference.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(readFirstBlock(editor).text).toBe("[[");
  });

  it("turns the current block into a todo when Enter selects the first / command", async () => {
    let editor!: LexicalEditor;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <QuickCommandsPlugin labels={LABELS} />
        <EditorCapture onReady={(readyEditor) => {
          editor = readyEditor;
        }} />
      </MegaContentEditor>,
    );

    seedText(editor, "/");
    await waitFor(() => expect(screen.getByRole("option", { name: "TODO" })).toBeInTheDocument());
    expect(screen.getByRole("option", { name: "TODO" })).toHaveAttribute("aria-selected", "true");

    await act(async () => {
      editor.dispatchCommand(KEY_ENTER_COMMAND, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    });

    expect(readFirstBlock(editor).variant).toBe("todo");
    expect(readFirstBlock(editor).text).toBe("");
  });

  it("turns / plus four ArrowDown presses into the block-reference trigger", async () => {
    let editor!: LexicalEditor;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <QuickCommandsPlugin labels={LABELS} />
        <EditorCapture onReady={(readyEditor) => {
          editor = readyEditor;
        }} />
      </MegaContentEditor>,
    );

    seedText(editor, "/");
    await waitFor(() => expect(screen.getByRole("option", { name: "Block reference" })).toBeInTheDocument());

    await act(async () => {
      editor.dispatchCommand(KEY_ARROW_DOWN_COMMAND, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }));
      editor.dispatchCommand(KEY_ARROW_DOWN_COMMAND, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }));
      editor.dispatchCommand(KEY_ARROW_DOWN_COMMAND, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }));
      editor.dispatchCommand(KEY_ARROW_DOWN_COMMAND, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }));
      editor.dispatchCommand(KEY_ENTER_COMMAND, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    });

    expect(readFirstBlock(editor).text).toBe("((");
  });

  it("inserts an editable two-by-two table from the slash menu", async () => {
    let editor!: LexicalEditor;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <QuickCommandsPlugin labels={LABELS} />
        <EditorCapture onReady={(readyEditor) => { editor = readyEditor; }} />
      </MegaContentEditor>,
    );
    seedText(editor, "/table");
    const option = await screen.findByRole("option", { name: "Table" });
    await act(async () => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(editor.getRootElement()?.querySelectorAll("[data-mega-outline-table] tr")).toHaveLength(2));
    expect(editor.getRootElement()?.querySelectorAll("[data-mega-outline-table] td")).toHaveLength(4);
    expect(editor.getRootElement()?.querySelectorAll("[data-mega-table-source] [data-mega-block]")).toHaveLength(4);
    const firstCell = screen.getByRole("textbox", { name: "Row 1, column 1" });
    fireEvent.change(firstCell, { target: { value: "Table edit" } });
    await waitFor(() => expect(editor.getRootElement()?.querySelector("[data-mega-table-source] [data-mega-block]")).toHaveTextContent("Table edit"));
    const sourceId = editor.getRootElement()?.querySelector<HTMLElement>("[data-mega-table-source]")?.dataset.blockId;
    act(() => editor.update(() => {
      const source = $findMegaBlockById(sourceId!);
      const row = source?.getChildren().find($isMegaBlockNode);
      if (row) $setTableCellText(row, "Outline edit");
    }, { discrete: true }));
    await waitFor(() => expect(firstCell).toHaveValue("Outline edit"));
    fireEvent.compositionStart(firstCell);
    fireEvent.change(firstCell, { target: { value: "中文输入" } });
    expect(editor.getRootElement()?.querySelector("[data-mega-table-source] [data-mega-block]")).toHaveTextContent("Outline edit");
    fireEvent.compositionEnd(firstCell);
    await waitFor(() => expect(editor.getRootElement()?.querySelector("[data-mega-table-source] [data-mega-block]")).toHaveTextContent("中文输入"));
    fireEvent.focus(firstCell);
    fireEvent.click(screen.getByRole("button", { name: "+ row" }));
    await waitFor(() => expect(editor.getRootElement()?.querySelectorAll("[data-mega-outline-table] tr")).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "+ column" }));
    await waitFor(() => expect(editor.getRootElement()?.querySelectorAll("[data-mega-outline-table] tr:first-child td")).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Delete row" }));
    await waitFor(() => expect(editor.getRootElement()?.querySelectorAll("[data-mega-outline-table] tr")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Delete column" }));
    await waitFor(() => expect(editor.getRootElement()?.querySelectorAll("[data-mega-outline-table] tr:first-child td")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Delete table" }));
    await waitFor(() => expect(editor.getRootElement()?.querySelector("[data-mega-outline-table]")).not.toBeInTheDocument());
    expect(editor.getRootElement()?.querySelector("[data-mega-table-source]")).not.toBeInTheDocument();
  });
});
