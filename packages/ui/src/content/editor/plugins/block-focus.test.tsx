// @vitest-environment happy-dom
import * as React from "react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { $createTextNode, $getRoot, $getSelection, $isRangeSelection, $isTextNode, KEY_ENTER_COMMAND, type LexicalEditor } from "lexical";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { $createMegaBlock, $isMegaBlockNode, MEGA_CONTENT_BLOCK_NODES } from "@megaui/content";
import { $getNestedMegaBlocks, $getSelectedMegaBlock } from "../commands";
import { BlockFocusPlugin } from "./block-focus";
import { BlockStructurePlugin } from "./block-structure";

afterEach(cleanup);

function EditorCapture({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => onReady(editor), [editor, onReady]);
  return null;
}

function setup(text: string, { focused = true, child = false } = {}) {
  let editor!: LexicalEditor;
  render(
    <LexicalComposer initialConfig={{
      namespace: "block-focus-test",
      nodes: [...MEGA_CONTENT_BLOCK_NODES],
      onError: (error) => { throw error; },
      editorState: () => {
        const target = $createMegaBlock("text", "target");
        if (text) target.append($createTextNode(text));
        if (child) {
          target.append($createMegaBlock("text", "existing-child").append($createTextNode("Existing child")));
          target.setCollapsed(true);
        }
        $getRoot().append(target, $createMegaBlock("text", "outside"));
      },
    }}>
      <div data-mega-content="outliner">
        <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      </div>
      <BlockStructurePlugin />
      <BlockFocusPlugin blockId={focused ? "target" : null} onExit={() => {}} />
      <EditorCapture onReady={(ready) => { editor = ready; }} />
    </LexicalComposer>,
  );
  act(() => {
    editor.update(() => {
      const target = $getRoot().getFirstChild();
      if (!$isMegaBlockNode(target)) throw new Error("Expected target block");
      const first = target.getFirstChild();
      if ($isTextNode(first)) first.select(text.length, text.length);
      else target.selectStart();
    }, { discrete: true });
  });
  return editor;
}

async function enter(editor: LexicalEditor) {
  const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
  await act(async () => {
    editor.dispatchCommand(KEY_ENTER_COMMAND, event);
    await Promise.resolve();
  });
  expect(event.defaultPrevented).toBe(true);
}

describe("BlockFocusPlugin Enter", () => {
  it("does not steal focus back after the user selects another control", () => {
    let scheduled: FrameRequestCallback | undefined;
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      scheduled = callback;
      return 1;
    });
    const control = document.createElement("button");
    document.body.append(control);
    try {
      setup("First line");
      control.focus();
      act(() => scheduled?.(0));
      expect(document.activeElement).toBe(control);
    } finally {
      control.remove();
      frame.mockRestore();
    }
  });

  it.each(["First line", ""])("keeps new lines and typing inside a focused leaf (%j)", async (text) => {
    const editor = setup(text);
    await enter(editor);
    editor.getEditorState().read(() => {
      expect($getRoot().getChildren()).toHaveLength(2);
      const target = $getRoot().getFirstChild();
      if (!$isMegaBlockNode(target)) throw new Error("Expected target block");
      const children = $getNestedMegaBlocks(target);
      expect(children).toHaveLength(1);
      expect($getSelectedMegaBlock()).toBe(children[0]);
      expect(editor.getElementByKey(children[0]!.getKey())).toHaveAttribute("data-mega-block-focus", "descendant");
    });

    await enter(editor);
    act(() => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) throw new Error("Expected typing selection");
        selection.insertText("Next line");
      }, { discrete: true });
    });
    editor.getEditorState().read(() => {
      const target = $getRoot().getFirstChild();
      if (!$isMegaBlockNode(target)) throw new Error("Expected target block");
      expect($getRoot().getChildren()).toHaveLength(2);
      const children = $getNestedMegaBlocks(target);
      expect(children).toHaveLength(2);
      expect(children[1]!.getTextContent()).toBe("Next line");
      expect($getSelectedMegaBlock()).toBe(children[1]);
    });
  });

  it("splits the focused root before its existing children and unfolds the new line", async () => {
    const editor = setup("helloworld", { child: true });
    act(() => {
      editor.update(() => {
        const target = $getRoot().getFirstChild();
        if (!$isMegaBlockNode(target)) throw new Error("Expected target block");
        const text = target.getFirstChild();
        if (!$isTextNode(text)) throw new Error("Expected target text");
        text.select(5, 5);
      }, { discrete: true });
    });
    await enter(editor);
    editor.getEditorState().read(() => {
      const target = $getRoot().getFirstChild();
      if (!$isMegaBlockNode(target)) throw new Error("Expected target block");
      expect($getRoot().getChildren()).toHaveLength(2);
      expect(target.getFirstChild()?.getTextContent()).toBe("hello");
      expect(target.getCollapsed()).toBe(false);
      const children = $getNestedMegaBlocks(target);
      expect(children.map((node) => node.getTextContent())).toEqual(["world", "Existing child"]);
      expect(children[1]!.getBlockId()).toBe("existing-child");
      expect($getSelectedMegaBlock()).toBe(children[0]);
    });
  });

  it("keeps ordinary Enter creating siblings when block focus is disabled", async () => {
    const editor = setup("First line", { focused: false });
    await enter(editor);
    editor.getEditorState().read(() => {
      const blocks = $getRoot().getChildren();
      expect(blocks).toHaveLength(3);
      expect($getSelectedMegaBlock()).toBe(blocks[1]);
    });
  });
});
