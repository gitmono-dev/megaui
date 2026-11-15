// @vitest-environment happy-dom
import * as React from "react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { $getRoot, type LexicalEditor } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createMegaBlock, $isMegaBlockNode, createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import { MegaContentEditor } from "../editor";
import { BlockContextMenuPlugin } from "./block-context-menu";

afterEach(cleanup);

const LABELS = {
  ariaLabel: "Block actions",
  copyBlockRef: "Copy block ref",
  copyBlockId: "Copy block ID",
  copyBlockLink: "Copy block link",
  copyEmbed: "Copy embed",
  focusBlock: "Focus on block",
  openInSidebar: "Open in sidebar",
  expandAll: "Expand all",
  collapseAll: "Collapse all",
  makeTodo: "Make TODO",
  removeTodo: "Remove TODO",
  textStyle: "Text style",
  heading1: "Heading 1",
  heading2: "Heading 2",
  heading3: "Heading 3",
};

function EditorCapture({ onReady }: { readonly onReady: (editor: LexicalEditor) => void }): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => onReady(editor), [editor, onReady]);
  return null;
}

describe("BlockContextMenuPlugin", () => {
  it("hides the raw ID and provides executable Roam-style block actions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    let editor: LexicalEditor | undefined;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <BlockContextMenuPlugin labels={LABELS} />
        <EditorCapture onReady={(readyEditor) => { editor = readyEditor; }} />
      </MegaContentEditor>,
    );

    let blockId = "";
    editor?.getEditorState().read(() => {
      const block = $getRoot().getFirstChild();
      if (!$isMegaBlockNode(block)) throw new Error("Expected the document seed block");
      blockId = block.getBlockId();
    });
    const blockElement = editor?.getRootElement()?.querySelector("[data-block-id]");
    if (!blockElement) throw new Error("Expected a rendered mega block");

    act(() => {
      fireEvent.contextMenu(blockElement, { clientX: 32, clientY: 48 });
    });

    const menu = await screen.findByRole("menu", { name: LABELS.ariaLabel });
    expect(menu).not.toHaveTextContent(blockId);
    expect(screen.getByRole("menuitem", { name: /Copy block ref/ })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: LABELS.copyBlockLink })).toBeVisible();
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /Copy block ref/ }));
    expect(screen.getByRole("menuitem", { name: /Copy embed/ })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: LABELS.copyBlockId })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: LABELS.focusBlock })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: LABELS.expandAll })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: LABELS.collapseAll })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: LABELS.makeTodo })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: LABELS.heading1 })).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: LABELS.copyBlockId }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`((${blockId}))`));
    await waitFor(() => expect(screen.queryByRole("menu", { name: LABELS.ariaLabel })).not.toBeInTheDocument());

    fireEvent.contextMenu(blockElement, { clientX: 32, clientY: 48 });
    await screen.findByRole("menu", { name: LABELS.ariaLabel });
    fireEvent.click(screen.getByRole("menuitem", { name: LABELS.copyBlockLink }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining(`block=${blockId}`)));

    fireEvent.contextMenu(blockElement, { clientX: 32, clientY: 48 });
    await screen.findByRole("menu", { name: LABELS.ariaLabel });
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /Copy block ref/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy embed/ }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`{{[[embed]]: ((${blockId}))}}`));

    fireEvent.contextMenu(blockElement, { clientX: 32, clientY: 48 });
    await screen.findByRole("menu", { name: LABELS.ariaLabel });
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy block ref/ }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`((${blockId}))`));

    act(() => {
      editor?.update(() => {
        const block = $getRoot().getFirstChild();
        if (!$isMegaBlockNode(block)) throw new Error("Expected the document block");
        block.selectEnd();
      }, { discrete: true });
    });
    const root = editor?.getRootElement();
    if (!root) throw new Error("Expected the editor root");
    fireEvent.keyDown(root, { key: "E", metaKey: true, shiftKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(5));
    expect(writeText).toHaveBeenLastCalledWith(`{{[[embed]]: ((${blockId}))}}`);
  });

  it("turns the context block into a TODO", async () => {
    let editor: LexicalEditor | undefined;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <BlockContextMenuPlugin labels={LABELS} />
        <EditorCapture onReady={(readyEditor) => { editor = readyEditor; }} />
      </MegaContentEditor>,
    );

    const blockElement = editor?.getRootElement()?.querySelector("[data-block-id]");
    if (!blockElement) throw new Error("Expected a rendered mega block");
    fireEvent.contextMenu(blockElement, { clientX: 32, clientY: 48 });
    await screen.findByRole("menu", { name: LABELS.ariaLabel });
    fireEvent.click(screen.getByRole("menuitem", { name: LABELS.makeTodo }));

    await waitFor(() => {
      const todoBlock = editor?.getRootElement()?.querySelector('[data-mega-block="todo"]');
      expect(todoBlock).toBeInTheDocument();
    });
  });

  it("focuses, changes headings, and recursively expands or collapses outline blocks", async () => {
    let editor: LexicalEditor | undefined;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <BlockContextMenuPlugin labels={LABELS} />
        <EditorCapture onReady={(readyEditor) => { editor = readyEditor; }} />
      </MegaContentEditor>,
    );

    act(() => {
      editor?.update(() => {
        const parent = $getRoot().getFirstChild();
        if (!$isMegaBlockNode(parent)) throw new Error("Expected the document seed block");
        parent.append($createMegaBlock("text", "nested-block"));
        $getRoot().append($createMegaBlock("text", "sibling-block"));
      }, { discrete: true });
    });

    const blockElement = editor?.getRootElement()?.querySelector<HTMLElement>("[data-block-id]");
    if (!blockElement) throw new Error("Expected a rendered mega block");
    const scrollIntoView = vi.fn();
    Object.defineProperty(blockElement, "scrollIntoView", { configurable: true, value: scrollIntoView });

    fireEvent.contextMenu(blockElement, { clientX: 32, clientY: 48 });
    await screen.findByRole("menu", { name: LABELS.ariaLabel });
    fireEvent.click(screen.getByRole("menuitem", { name: LABELS.focusBlock }));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });

    fireEvent.contextMenu(blockElement, { clientX: 32, clientY: 48 });
    await screen.findByRole("menu", { name: LABELS.ariaLabel });
    fireEvent.click(screen.getByRole("menuitem", { name: LABELS.collapseAll }));
    await waitFor(() => editor?.getEditorState().read(() => {
      const parent = $getRoot().getFirstChild();
      if (!$isMegaBlockNode(parent)) throw new Error("Expected the document seed block");
      expect(parent.getCollapsed()).toBe(true);
      const child = parent.getFirstChild();
      if (!$isMegaBlockNode(child)) throw new Error("Expected a nested block");
      expect(child.getCollapsed()).toBe(true);
      const sibling = $getRoot().getLastChild();
      if (!$isMegaBlockNode(sibling)) throw new Error("Expected a sibling block");
      expect(sibling.getCollapsed()).toBe(false);
    }));

    fireEvent.contextMenu(blockElement, { clientX: 32, clientY: 48 });
    await screen.findByRole("menu", { name: LABELS.ariaLabel });
    fireEvent.click(screen.getByRole("menuitem", { name: LABELS.expandAll }));
    await waitFor(() => editor?.getEditorState().read(() => {
      const parent = $getRoot().getFirstChild();
      if (!$isMegaBlockNode(parent)) throw new Error("Expected the document seed block");
      expect(parent.getCollapsed()).toBe(false);
      const child = parent.getFirstChild();
      if (!$isMegaBlockNode(child)) throw new Error("Expected a nested block");
      expect(child.getCollapsed()).toBe(false);
    }));

    fireEvent.contextMenu(blockElement, { clientX: 32, clientY: 48 });
    await screen.findByRole("menu", { name: LABELS.ariaLabel });
    fireEvent.click(screen.getByRole("menuitem", { name: LABELS.heading1 }));
    await waitFor(() => editor?.getEditorState().read(() => {
      const parent = $getRoot().getFirstChild();
      if (!$isMegaBlockNode(parent)) throw new Error("Expected the document seed block");
      expect(parent.getVariant()).toBe("h1");
    }));
  });

  it("hands focused-block navigation to the document host", async () => {
    const onFocusBlock = vi.fn();
    let editor: LexicalEditor | undefined;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <BlockContextMenuPlugin labels={LABELS} onFocusBlock={onFocusBlock} />
        <EditorCapture onReady={(readyEditor) => { editor = readyEditor; }} />
      </MegaContentEditor>,
    );

    let blockId = "";
    editor?.getEditorState().read(() => {
      const block = $getRoot().getFirstChild();
      if (!$isMegaBlockNode(block)) throw new Error("Expected the document seed block");
      blockId = block.getBlockId();
    });
    const blockElement = editor?.getRootElement()?.querySelector("[data-block-id]");
    if (!blockElement) throw new Error("Expected a rendered mega block");

    fireEvent.contextMenu(blockElement, { clientX: 32, clientY: 48 });
    await screen.findByRole("menu", { name: LABELS.ariaLabel });
    fireEvent.click(screen.getByRole("menuitem", { name: LABELS.focusBlock }));

    expect(onFocusBlock).toHaveBeenCalledWith(blockId);
  });

  it("opens the selected block in the document sidebar", async () => {
    const onOpenInSidebar = vi.fn();
    let editor: LexicalEditor | undefined;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <BlockContextMenuPlugin labels={LABELS} onOpenInSidebar={onOpenInSidebar} />
        <EditorCapture onReady={(readyEditor) => { editor = readyEditor; }} />
      </MegaContentEditor>,
    );
    const blockElement = editor?.getRootElement()?.querySelector<HTMLElement>("[data-block-id]");
    if (!blockElement) throw new Error("Expected a rendered mega block");
    fireEvent.contextMenu(blockElement, { clientX: 32, clientY: 48 });
    fireEvent.click(await screen.findByRole("menuitem", { name: LABELS.openInSidebar }));
    expect(onOpenInSidebar).toHaveBeenCalledWith(blockElement.dataset.blockId);
  });

  it("dismisses an open menu with Escape", async () => {
    let editor: LexicalEditor | undefined;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <BlockContextMenuPlugin labels={LABELS} />
        <EditorCapture onReady={(readyEditor) => { editor = readyEditor; }} />
      </MegaContentEditor>,
    );

    const blockElement = editor?.getRootElement()?.querySelector("[data-block-id]");
    if (!blockElement) throw new Error("Expected a rendered mega block");
    fireEvent.contextMenu(blockElement, { clientX: 32, clientY: 48 });
    await screen.findByRole("menu", { name: LABELS.ariaLabel });

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: LABELS.ariaLabel })).not.toBeInTheDocument());
  });
});
