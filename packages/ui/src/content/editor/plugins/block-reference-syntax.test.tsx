// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createTextNode, $getRoot, $getSelection, $isRangeSelection, PASTE_COMMAND, type LexicalEditor } from "lexical";
import { $createMegaBlock, createEmptyMegaDocumentEditorStateJSON, type BlockRefValue } from "@megaui/content";
import { MegaContentEditor } from "../editor";
import { $createEditorBlockRefNode } from "../nodes";
import { BlockReferenceSyntaxPlugin } from "./block-reference-syntax";
import { BlockFocusPlugin } from "./block-focus";

afterEach(cleanup);
function Capture({ ready }: { ready: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  React.useEffect(() => ready(editor), [editor, ready]);
  return null;
}
function setup(resolve: (id: string, doc: string, exact: boolean) => Promise<BlockRefValue>, { initialStateJSON = createEmptyMegaDocumentEditorStateJSON(), focus = null }: { initialStateJSON?: string; focus?: string | null } = {}) {
  let editor!: LexicalEditor;
  const view = render(<MegaContentEditor initialStateJSON={initialStateJSON} preset="document" placeholder="Write">
    <BlockReferenceSyntaxPlugin currentDocId="current" resolve={resolve} />
    <BlockFocusPlugin blockId={focus} onExit={() => {}} />
    <Capture ready={value => { editor = value; }} />
  </MegaContentEditor>);
  return { ...view, editor };
}

describe("inline block reference syntax", () => {
  it.each([true, false])("keeps Enter from reference syntax in the expected outline (focused=%s)", async (focused) => {
    const { editor } = setup(async id => ({ targetDocId: "source", targetBlockId: id, label: "Referenced text", status: "ok" }), { focus: focused ? "FocusedBlk01" : null });
    act(() => editor.update(() => $getRoot().clear().append(
      $createMegaBlock("text", "FocusedBlk01").append($createEditorBlockRefNode({ targetDocId: "source", targetBlockId: "BlockRef0001", label: "Referenced text" })),
      $createMegaBlock("text", "OutsideBlk01"),
    ), { discrete: true }));
    await waitFor(() => expect(screen.getByText("Referenced text")).toBeVisible());
    fireEvent.click(screen.getByText("Referenced text"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Block reference" }), { key: "Enter" });
    act(() => editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) throw new Error("Expected editable next line");
      selection.insertText("Next line");
    }, { discrete: true }));
    const blocks = editor.getEditorState().toJSON().root.children;
    expect(blocks).toHaveLength(focused ? 2 : 3);
    if (focused) {
      expect(blocks[0]).toMatchObject({ children: [
        { type: "mega-block-ref" }, { type: "mega-block", children: [{ text: "Next line" }] },
      ] });
    } else expect(blocks[1]).toMatchObject({ children: [{ text: "Next line" }] });
  });

  it("preserves an unresolved copied source across saving and reloading", async () => {
    const resolve = vi.fn(async (id: string, doc: string, exact: boolean): Promise<BlockRefValue> => ({
      targetDocId: exact ? doc : "wrong-source", targetBlockId: id,
      label: exact ? `((${id}))` : "Wrong source", status: exact ? "unresolved" : "ok",
    }));
    const { editor, unmount } = setup(resolve);
    act(() => editor.update(() => $getRoot().getFirstChildOrThrow().selectEnd(), { discrete: true }));
    const event = new ClipboardEvent("paste", { cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => type === "text/plain"
      ? "((BlockRef0001))" : '<span data-mega-block-ref-doc="private-source" data-mega-block-ref-block="BlockRef0001">((BlockRef0001))</span>' } });
    act(() => { editor.dispatchCommand(PASTE_COMMAND, event); });
    await waitFor(() => expect(resolve).toHaveBeenCalledWith("BlockRef0001", "private-source", true));
    const initialStateJSON = JSON.stringify(editor.getEditorState().toJSON());
    unmount();
    resolve.mockClear();
    const restored = setup(resolve, { initialStateJSON });
    await waitFor(() => expect(resolve).toHaveBeenCalledWith("BlockRef0001", "private-source", true));
    expect(JSON.stringify(restored.editor.getEditorState().toJSON())).not.toContain("wrong-source");
  });

  it("keeps old UUID and malformed reference syntax as ordinary text", () => {
    const resolve = vi.fn();
    const { editor } = setup(resolve);
    const text = "((573ddfe6-ee19-4015-89dd-558f7a5e44db)) ((short)) ((abcdefghijklM))";
    act(() => editor.update(() => $getRoot().clear().append($createMegaBlock("text").append($createTextNode(text))), { discrete: true }));
    expect(editor.getEditorState().toJSON().root.children[0]).toMatchObject({ children: [{ type: "text", text }] });
    expect(resolve).not.toHaveBeenCalled();
  });
  it("pastes into an empty row without removing neighbouring blocks", async () => {
    const { editor } = setup(async id => ({ targetDocId: "current", targetBlockId: id, label: "Source", status: "ok" }));
    act(() => editor.update(() => {
      const target = $createMegaBlock("text", "target");
      $getRoot().clear().append($createMegaBlock("text", "SourceBlk001").append($createTextNode("Source")), target, $createMegaBlock("text", "after").append($createTextNode("After")));
      target.selectEnd();
    }, { discrete: true }));
    // Native click has moved the caret, but Lexical still remembers the source.
    act(() => editor.update(() => $getRoot().getFirstChildOrThrow().selectEnd(), { discrete: true }));
    const target = editor.getRootElement()!.querySelector('[data-block-id="target"]')!;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    const event = new ClipboardEvent("paste", { cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => type === "text/plain" ? "((SourceBlk001))" : "" } });
    act(() => { editor.dispatchCommand(PASTE_COMMAND, event); });
    await waitFor(() => expect(JSON.stringify(editor.getEditorState().toJSON())).toContain("mega-block-ref"));
    expect(editor.getEditorState().toJSON().root.children).toMatchObject([
      { blockId: "SourceBlk001", children: [{ text: "Source" }] },
      { blockId: "target", children: [{ type: "mega-block-ref" }] },
      { blockId: "after", children: [{ text: "After" }] },
    ]);
  });
  it("converts complete syntax inside text without creating another outline row", async () => {
    const resolve = vi.fn(async (id: string) => ({ targetDocId: "SourceBlk001", targetBlockId: id, label: "Referenced text", status: "ok" as const }));
    const { editor, container } = setup(resolve);
    act(() => editor.update(() => {
      $getRoot().clear().append($createMegaBlock("text").append($createTextNode("Before ((BlockRef0001)) after")));
    }, { discrete: true }));
    await waitFor(() => expect(container.querySelector('[data-mega-content="block-ref"]')).toHaveTextContent("Referenced text"));
    expect(container.querySelectorAll('[data-mega-block]')).toHaveLength(1);
    expect(editor.getEditorState().toJSON().root.children[0]).toMatchObject({ children: [
      { type: "text", text: "Before " }, { type: "mega-block-ref", blockRef: { targetDocId: "SourceBlk001" } }, { type: "text", text: " after" },
    ] });
  });
  it("edits the syntax and resumes ordinary text immediately after the same inline reference", async () => {
    const resolve = vi.fn(async (id: string) => ({ targetDocId: "SourceBlk001", targetBlockId: id, label: "Referenced text", status: "ok" as const }));
    const { editor, container } = setup(resolve);
    act(() => editor.update(() => $getRoot().clear().append($createMegaBlock("text").append(
      $createEditorBlockRefNode({ targetDocId: "SourceBlk001", targetBlockId: "BlockRef0001", label: "Referenced text" }), $createTextNode(" after"),
    )), { discrete: true }));
    await waitFor(() => expect(screen.getByText("Referenced text")).toBeVisible());
    fireEvent.click(screen.getByText("Referenced text"));
    const input = screen.getByRole("textbox", { name: "Block reference" });
    expect(input).toHaveValue("((BlockRef0001))");
    fireEvent.keyDown(input, { key: "ArrowRight" });
    act(() => editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText(" added");
    }, { discrete: true }));
    expect(container.querySelectorAll('[data-mega-block]')).toHaveLength(1);
    expect(editor.getEditorState().toJSON().root.children[0]).toMatchObject({ children: [
      { type: "mega-block-ref", blockRef: { targetBlockId: "BlockRef0001" } }, { type: "text", text: " added after" },
    ] });
    // A non-focusable area can leave activeElement and the native caret in the editor.
    fireEvent.pointerDown(document.body);
    act(() => editor.update(() => $getRoot().getFirstChildOrThrow().getWritable(), { discrete: true }));
    expect(container.querySelector('[data-mega-content="block-ref"]')).toHaveTextContent("Referenced text");
  });
  it("discards a late resolution after the reference was deleted", async () => {
    let finish!: (value: BlockRefValue) => void;
    const { editor, container } = setup(() => new Promise(resolve => { finish = resolve; }));
    act(() => editor.update(() => $getRoot().clear().append($createMegaBlock("text").append($createTextNode("((OldBlock0001))"))), { discrete: true }));
    await waitFor(() => expect(finish).toBeDefined());
    act(() => editor.update(() => $getRoot().clear().append($createMegaBlock("text").append($createTextNode("Kept"))), { discrete: true }));
    await act(async () => finish({ targetDocId: "other", targetBlockId: "OldBlock0001", label: "Stale", status: "ok" }));
    expect(container).not.toHaveTextContent("Stale");
    expect(container).toHaveTextContent("Kept");
  });
});
