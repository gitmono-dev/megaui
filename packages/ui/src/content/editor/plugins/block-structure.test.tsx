// @vitest-environment happy-dom
import * as React from "react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { $createTextNode, $getRoot, $isTextNode, KEY_BACKSPACE_COMMAND, KEY_ENTER_COMMAND, KEY_TAB_COMMAND, type LexicalEditor } from "lexical";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { $createMegaBlock, $isMegaBlockNode, generateBlockId, MEGA_CONTENT_BLOCK_NODES, type MegaBlockNode } from "@megaui/content";
import { $getMegaBlockInlineText } from "../commands";
import { BlockStructurePlugin } from "./block-structure";
import { $createEditorRefNode, EditorRefNode } from "../nodes";

afterEach(cleanup);

function EditorCapture({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    onReady(editor);
  }, [editor, onReady]);
  return null;
}

function Harness({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "block-structure-test",
        nodes: [...MEGA_CONTENT_BLOCK_NODES, EditorRefNode],
        onError: (error) => {
          throw error;
        },
      }}
    >
      <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      <BlockStructurePlugin />
      <EditorCapture onReady={onReady} />
    </LexicalComposer>
  );
}

function seedOneBlock(editor: LexicalEditor, text: string) {
  const blockId = generateBlockId();
  act(() => {
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const block = $createMegaBlock("text", blockId);
        const textNode = $createTextNode(text);
        block.append(textNode);
        root.append(block);
        textNode.select(text.length, text.length);
      },
      { discrete: true },
    );
  });
  return blockId;
}

// Command dispatch may schedule a non-discrete Lexical update; flush a microtask
// inside `act()` before reading the committed editor state.
async function dispatchEnter(editor: LexicalEditor) {
  await act(async () => {
    editor.dispatchCommand(KEY_ENTER_COMMAND, new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    await Promise.resolve();
  });
}

async function dispatchTab(editor: LexicalEditor, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, cancelable: true });
  await act(async () => {
    editor.dispatchCommand(KEY_TAB_COMMAND, event);
    await Promise.resolve();
  });
  return event;
}

async function dispatchBackspace(editor: LexicalEditor) {
  const event = new KeyboardEvent("keydown", { key: "Backspace", cancelable: true });
  await act(async () => {
    editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event);
    await Promise.resolve();
  });
  return event;
}

describe("BlockStructurePlugin", () => {
  it.each(["element", "text"] as const)("Backspace after an inline reference (%s cursor) preserves the row and its neighbors", async (cursor) => {
    let editor!: LexicalEditor;
    render(<Harness onReady={(ready) => (editor = ready)} />);
    const ids = [generateBlockId(), generateBlockId(), generateBlockId()];
    act(() => editor.update(() => {
      const root = $getRoot();
      root.clear();
      const before = $createMegaBlock("text", ids[0]).append($createTextNode("Before"));
      const row = $createMegaBlock("text", ids[1]);
      const tag = $createEditorRefNode({ kind: "doc", notation: "tag", targetTitle: "Planning", targetId: "doc-1" });
      const suffix = $createTextNode(" suffix");
      row.append(tag, suffix);
      const after = $createMegaBlock("text", ids[2]).append($createTextNode("After"));
      root.append(before, row, after);
      if (cursor === "element") row.select(1, 1);
      else suffix.select(0, 0);
    }, { discrete: true }));

    await dispatchBackspace(editor);
    editor.getEditorState().read(() => {
      const rows = $getRoot().getChildren() as MegaBlockNode[];
      expect(rows.map((row) => row.getBlockId())).toEqual(ids);
      expect($getMegaBlockInlineText(rows[0]!)).toBe("Before");
      expect($getMegaBlockInlineText(rows[2]!)).toBe("After");
    });
  });

  it("Backspace at the start of a TODO removes its checkbox without deleting the block or text", async () => {
    let editor!: LexicalEditor;
    render(<Harness onReady={(ready) => (editor = ready)} />);
    seedOneBlock(editor, "Keep this task");

    act(() => {
      editor.update(() => {
        const block = $getRoot().getFirstChild();
        if (!$isMegaBlockNode(block)) throw new Error("Expected a mega block");
        block.setVariant("todo").setTodoChecked(true);
        const textNode = block.getFirstChild();
        if (!$isTextNode(textNode)) throw new Error("Expected task text");
        textNode.select(0, 0);
      }, { discrete: true });
    });

    const event = await dispatchBackspace(editor);
    expect(event.defaultPrevented).toBe(true);
    editor.getEditorState().read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(1);
      const block = children[0];
      if (!$isMegaBlockNode(block)) throw new Error("Expected the task block");
      expect(block.getVariant()).toBe("text");
      expect(block.getTodoChecked()).toBe(false);
      expect($getMegaBlockInlineText(block)).toBe("Keep this task");
    });
  });

  it("Backspace converts a nested TODO before the next Backspace merges it", async () => {
    let editor!: LexicalEditor;
    render(<Harness onReady={(ready) => (editor = ready)} />);
    act(() => {
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        const first = $createMegaBlock("text", generateBlockId());
        first.append($createTextNode("Before "));
        const todo = $createMegaBlock("todo", generateBlockId());
        const taskText = $createTextNode("task");
        todo.append(taskText);
        root.append(first, todo);
        taskText.select(0, 0);
      }, { discrete: true });
    });

    await dispatchBackspace(editor);
    editor.getEditorState().read(() => {
      const blocks = $getRoot().getChildren();
      expect(blocks).toHaveLength(2);
      expect((blocks[1] as MegaBlockNode).getVariant()).toBe("text");
    });

    await dispatchBackspace(editor);
    editor.getEditorState().read(() => {
      const blocks = $getRoot().getChildren();
      expect(blocks).toHaveLength(1);
      expect($getMegaBlockInlineText(blocks[0] as MegaBlockNode)).toBe("Before task");
    });
  });

  it("Enter splits the current mega block into two siblings (Roam-style)", async () => {
    let editor!: LexicalEditor;
    render(<Harness onReady={(e) => (editor = e)} />);
    seedOneBlock(editor, "helloworld");

    // Move selection to offset 5 ("hello|world") before splitting.
    act(() => {
      editor.update(
        () => {
          const [block] = $getRoot().getChildren();
          if (!$isMegaBlockNode(block)) throw new Error("Expected a mega block");
          const [textNode] = block.getChildren();
          if (!$isTextNode(textNode)) throw new Error("Expected text in the mega block");
          textNode.select(5, 5);
        },
        { discrete: true },
      );
    });

    await dispatchEnter(editor);

    editor.getEditorState().read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(2);
      expect($getMegaBlockInlineText(children[0] as MegaBlockNode)).toBe("hello");
      expect($getMegaBlockInlineText(children[1] as MegaBlockNode)).toBe("world");
    });
  });

  it("Tab indents the selected block under its previous sibling; Shift+Tab outdents it back", async () => {
    let editor!: LexicalEditor;
    render(<Harness onReady={(e) => (editor = e)} />);

    act(() => {
      editor.update(
        () => {
          const root = $getRoot();
          root.clear();
          const blockA = $createMegaBlock("text", generateBlockId());
          blockA.append($createTextNode("a"));
          const blockB = $createMegaBlock("text", generateBlockId());
          const textB = $createTextNode("b");
          blockB.append(textB);
          root.append(blockA, blockB);
          textB.select(1, 1);
        },
        { discrete: true },
      );
    });

    await dispatchTab(editor, false);

    editor.getEditorState().read(() => {
      expect($getRoot().getChildren()).toHaveLength(1);
    });

    const outdentEvent = await dispatchTab(editor, true);

    editor.getEditorState().read(() => {
      expect($getRoot().getChildren()).toHaveLength(2);
    });
    expect(outdentEvent.defaultPrevented).toBe(true);
  });

  it("registers the mega-content invariants so a MegaBlockNode is auto-assigned a blockId", () => {
    let editor!: LexicalEditor;
    render(<Harness onReady={(e) => (editor = e)} />);

    act(() => {
      editor.update(
        () => {
          const root = $getRoot();
          root.clear();
          const block = $createMegaBlock("text", ""); // no blockId
          root.append(block);
        },
        { discrete: true },
      );
    });

    editor.getEditorState().read(() => {
      const [block] = $getRoot().getChildren();
      expect($isMegaBlockNode(block)).toBe(true);
      expect((block as MegaBlockNode).getBlockId()).not.toBe("");
    });
  });
});
