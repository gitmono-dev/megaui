// @vitest-environment happy-dom
import React, { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { getContentPresetConfig } from "../preset";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createTextNode, $getRoot, $getSelection, $isElementNode, $isRangeSelection, $isTextNode, HISTORY_PUSH_TAG, UNDO_COMMAND, REDO_COMMAND, type LexicalEditor } from "lexical";
import { $createMegaBlock } from "@megaui/content";
import { MegaContentEditor } from "../editor";
import { EditorMirrorPlugin } from "./editor-mirror";

function Capture({ ready }: { ready: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => ready(editor), [editor, ready]);
  return null;
}

afterEach(() => { cleanup(); document.body.replaceChildren(); });

function setup() {
  const target = document.createElement("div");
  document.body.append(target);
  let source!: LexicalEditor;
  let mirror!: LexicalEditor;
  const view = render(<MegaContentEditor initialStateJSON='{"root":{"type":"root","version":1,"children":[{"type":"mega-block","version":1,"blockId":"initialblk01","variant":"text","children":[]}]}}' placeholder="Main" preset="document">
    <Capture ready={(editor) => { source = editor; }} />
    <EditorMirrorPlugin target={target} placeholder="Sidebar"><Capture ready={(editor) => { mirror = editor; }} /></EditorMirrorPlugin>
  </MegaContentEditor>);
  act(() => source.update(() => {
    $getRoot().clear().append($createMegaBlock("text", "firstBlock01").append($createTextNode("First")), $createMegaBlock("text", "otherBlock02").append($createTextNode("Other")));
  }, { discrete: true, tag: HISTORY_PUSH_TAG }));
  return { source, mirror, view };
}
function change(editor: LexicalEditor, text: string) {
  act(() => editor.update(() => {
    const block = $getRoot().getFirstChild();
    if (!$isElementNode(block)) throw new Error("Missing block");
    block.clear().append($createTextNode(text));
    block.selectEnd();
  }, { discrete: true, tag: HISTORY_PUSH_TAG }));
}
const body = (editor: LexicalEditor) => editor.getEditorState().read(() => $getRoot().getTextContent());

describe("document editor mirror", () => {
  it("waits for an initially empty collaborative owner before mounting the sidebar", () => {
    const target = document.createElement("div");
    document.body.append(target);
    let source!: LexicalEditor;
    render(<LexicalComposer initialConfig={{ namespace: "pending-owner", editorState: null, nodes: getContentPresetConfig("document").nodes, onError: (error) => { throw error; } }}>
      <Capture ready={(editor) => { source = editor; }} />
      <EditorMirrorPlugin target={target} placeholder="Sidebar" />
    </LexicalComposer>);
    expect(target.querySelector('[contenteditable]')).toBeNull();
    act(() => source.update(() => {
      $getRoot().append($createMegaBlock("text", "syncedBlock1").append($createTextNode("Synced content")));
    }, { discrete: true }));
    expect(target.textContent).toContain("Synced content");
    expect(target.querySelector('[contenteditable="true"]')).not.toBeNull();
  });
  it("immediately propagates edits in both directions without losing unrelated blocks", () => {
    const { source, mirror } = setup();
    expect(body(mirror)).toBe(body(source));
    change(mirror, "Sidebar edit");
    expect(body(source)).toContain("Sidebar edit");
    expect(body(source)).toContain("Other");
    change(source, "Main edit");
    expect(body(mirror)).toBe(body(source));
    expect(body(mirror)).toContain("Main edit");
  });
  it("does not move focus into the inactive view when typing in the main editor", () => {
    const { source, mirror } = setup();
    source.getRootElement()?.focus();
    change(source, "Keep main focus");
    expect(document.activeElement).toBe(source.getRootElement());
    mirror.getEditorState().read(() => expect($getSelection()).toBeNull());
  });
  it("uses the owner's shared undo and redo history", async () => {
    const { source, mirror } = setup();
    change(source, "Main edit");
    change(mirror, "Sidebar edit");
    await act(async () => { mirror.dispatchCommand(UNDO_COMMAND, undefined); });
    expect(body(source)).toContain("Main edit");
    expect(body(mirror)).toBe(body(source));
    await act(async () => { mirror.dispatchCommand(REDO_COMMAND, undefined); });
    expect(body(source)).toContain("Sidebar edit");
    expect(body(mirror)).toBe(body(source));
  });
  it("keeps the active sidebar caret during incoming content updates and handles deleted points", () => {
    const { source, mirror } = setup();
    act(() => mirror.update(() => {
      const block = $getRoot().getFirstChild();
      if (!$isElementNode(block)) throw new Error("Missing block");
      const text = block.getFirstChild();
      if (!$isTextNode(text)) throw new Error("Missing text");
      text.select(2, 2);
    }, { discrete: true }));
    mirror.getRootElement()?.focus();
    act(() => source.update(() => {
      const block = $getRoot().getLastChild();
      if (!$isElementNode(block)) throw new Error("Missing sibling");
      block.append($createTextNode(" updated remotely"));
    }, { discrete: true }));
    mirror.getEditorState().read(() => {
      const selection = $getSelection();
      expect($isRangeSelection(selection) && selection.anchor.offset).toBe(2);
    });
    expect(document.activeElement).toBe(mirror.getRootElement());
    act(() => source.update(() => { $getRoot().getFirstChild()?.remove(); }, { discrete: true }));
    expect(body(mirror)).toBe(body(source));
    expect(body(mirror)).not.toContain("First");
  });
  it("inherits read-only changes and releases the bridge on unmount", () => {
    const { source, mirror, view } = setup();
    act(() => source.setEditable(false));
    expect(mirror.isEditable()).toBe(false);
    act(() => source.setEditable(true));
    expect(mirror.isEditable()).toBe(true);
    view.unmount();
    expect(() => change(source, "After unmount")).not.toThrow();
  });
});
