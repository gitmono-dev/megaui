// @vitest-environment happy-dom
import * as React from "react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { $getRoot, type LexicalEditor } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createMegaBlock, $createOutlineTable, $findMegaBlockById, $isMegaBlockNode, createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import { MegaContentEditor } from "../editor";
import { EditorOutlineTableNode } from "../outline-table-node";
import { BlockCollapsePlugin } from "./block-collapse";

afterEach(cleanup);

const LABELS = { collapse: "Collapse block", expand: "Expand block" };

function EditorCapture({ onReady }: { readonly onReady: (editor: LexicalEditor) => void }): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => onReady(editor), [editor, onReady]);
  return null;
}

describe("BlockCollapsePlugin", () => {
  it("folds table source blocks from the table control and restores the saved fold state", async () => {
    let editor!: LexicalEditor;
    let sourceId = "";
    const mount = (state: string) => render(
      <MegaContentEditor initialStateJSON={state} placeholder="Write" preset="document">
        <BlockCollapsePlugin labels={LABELS} />
        <EditorCapture onReady={(ready) => { editor = ready; }} />
      </MegaContentEditor>,
    );
    const first = mount(createEmptyMegaDocumentEditorStateJSON());
    act(() => editor.update(() => {
      const { table, source } = $createOutlineTable(2, 2, (id, sourceId) => new EditorOutlineTableNode(id, sourceId));
      sourceId = source.getBlockId();
      $getRoot().clear().append(table, source);
    }, { discrete: true }));
    const tableToggle = () => document.querySelector<HTMLButtonElement>('[data-table-outline="true"]')!;
    await waitFor(() => expect(tableToggle()).toBeInTheDocument());
    expect(tableToggle()).toHaveAttribute("data-block-id", sourceId);
    fireEvent.click(tableToggle());
    await waitFor(() => expect(tableToggle()).toHaveAttribute("aria-expanded", "false"));
    expect(screen.getAllByRole("button", { name: LABELS.expand })).toHaveLength(1);
    expect(screen.queryAllByRole("button", { name: LABELS.collapse })).toHaveLength(0);
    editor.getEditorState().read(() => expect($findMegaBlockById(sourceId)?.getCollapsed()).toBe(true));
    const saved = JSON.stringify(editor.getEditorState().toJSON());
    first.unmount();
    mount(saved);
    await waitFor(() => expect(tableToggle()).toHaveAttribute("aria-expanded", "false"));
    expect(document.querySelectorAll('[data-mega-outline-table] td')).toHaveLength(4);
    fireEvent.click(tableToggle());
    await waitFor(() => expect(tableToggle()).toHaveAttribute("aria-expanded", "true"));
    editor.getEditorState().read(() => expect($findMegaBlockById(sourceId)?.getCollapsed()).toBe(false));
  });

  it("toggles a parent block and hides descendant controls until expanded", async () => {
    let editor: LexicalEditor | undefined;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <BlockCollapsePlugin labels={LABELS} />
        <EditorCapture onReady={(readyEditor) => { editor = readyEditor; }} />
      </MegaContentEditor>,
    );

    act(() => {
      editor?.update(() => {
        const parent = $getRoot().getFirstChild();
        if (!$isMegaBlockNode(parent)) throw new Error("Expected the document seed block");
        const child = $createMegaBlock("text", "child");
        child.append($createMegaBlock("text", "grandchild"));
        parent.append(child);
      }, { discrete: true });
    });

    const parentToggle = await screen.findAllByRole("button", { name: LABELS.collapse });
    expect(parentToggle).toHaveLength(2);
    const parent = document.querySelector<HTMLElement>('[data-mega-content="collapse-toggle"]:not([data-block-id="child"])');
    if (!parent) throw new Error("Expected a parent fold control");
    expect(parent).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(parent);
    await waitFor(() => expect(parent).toHaveAttribute("aria-expanded", "false"));
    expect(parent).toHaveAttribute("aria-label", LABELS.expand);
    expect(screen.queryAllByRole("button", { name: LABELS.collapse })).toHaveLength(0);
    expect(document.querySelector('[data-mega-content="collapse-toggle"][data-block-id="child"]')).toBeNull();

    editor?.getEditorState().read(() => {
      const block = $getRoot().getFirstChild();
      if (!$isMegaBlockNode(block)) throw new Error("Expected a parent block");
      expect(block.getCollapsed()).toBe(true);
    });

    fireEvent.click(parent);
    await waitFor(() => expect(parent).toHaveAttribute("aria-expanded", "true"));
    await waitFor(() => expect(screen.queryAllByRole("button", { name: LABELS.collapse })).toHaveLength(2));
  });
});
