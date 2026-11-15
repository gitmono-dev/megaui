// @vitest-environment happy-dom
import * as React from "react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createMegaBlock, $isMegaBlockNode, createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import { MegaContentEditor } from "../editor";
import { DocumentEmptyStatePlugin } from "./document-empty-state";

afterEach(cleanup);

function EditorCapture({ onReady }: { onReady: (editor: LexicalEditor) => void }): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    onReady(editor);
  }, [editor, onReady]);
  return null;
}

describe("DocumentEmptyStatePlugin", () => {
  it("reports an empty custom block root, then text, then empty again", async () => {
    const states: boolean[] = [];
    let editor: LexicalEditor | undefined;

    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write…" preset="document">
        <DocumentEmptyStatePlugin onEmptyChange={(isEmpty) => states.push(isEmpty)} />
        <EditorCapture onReady={(readyEditor) => {
          editor = readyEditor;
        }} />
      </MegaContentEditor>,
    );

    await waitFor(() => expect(states).toContain(true));
    const liveEditor = editor;
    if (!liveEditor) throw new Error("Expected the Lexical editor to mount");

    // Given the seeded custom block, when text is entered, then the hint state becomes false.
    act(() => {
      liveEditor.update(
        () => {
          const block = $getRoot().getFirstChild();
          if (!$isMegaBlockNode(block)) throw new Error("Expected a mega-block root child");
          block.append($createTextNode("First block"));
        },
        { discrete: true },
      );
    });
    await waitFor(() => expect(states[states.length - 1]).toBe(false));

    // When that text is removed, then the same root is again reported as empty.
    act(() => {
      liveEditor.update(
        () => {
          const block = $getRoot().getFirstChild();
          if (!$isMegaBlockNode(block)) throw new Error("Expected a mega-block root child");
          block.clear();
        },
        { discrete: true },
      );
    });
    await waitFor(() => expect(states[states.length - 1]).toBe(true));
  });

  it("hides the hint for an empty TODO or a second block, then restores it for the blank starter", async () => {
    const states: boolean[] = [];
    let editor: LexicalEditor | undefined;

    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write…" preset="document">
        <DocumentEmptyStatePlugin onEmptyChange={(isEmpty) => states.push(isEmpty)} />
        <EditorCapture onReady={(readyEditor) => {
          editor = readyEditor;
        }} />
      </MegaContentEditor>,
    );

    await waitFor(() => expect(states.at(-1)).toBe(true));
    const liveEditor = editor;
    if (!liveEditor) throw new Error("Expected the Lexical editor to mount");

    act(() => {
      liveEditor.update(() => {
        const block = $getRoot().getFirstChild();
        if (!$isMegaBlockNode(block)) throw new Error("Expected a mega-block root child");
        block.setVariant("todo");
      }, { discrete: true });
    });
    await waitFor(() => expect(states.at(-1)).toBe(false));

    act(() => {
      liveEditor.update(() => {
        const block = $getRoot().getFirstChild();
        if (!$isMegaBlockNode(block)) throw new Error("Expected a mega-block root child");
        block.setVariant("text");
      }, { discrete: true });
    });
    await waitFor(() => expect(states.at(-1)).toBe(true));

    act(() => {
      liveEditor.update(() => {
        $getRoot().append($createMegaBlock("text", "second-empty-block"));
      }, { discrete: true });
    });
    await waitFor(() => expect(states.at(-1)).toBe(false));

    act(() => {
      liveEditor.update(() => {
        $getRoot().getLastChild()?.remove();
      }, { discrete: true });
    });
    await waitFor(() => expect(states.at(-1)).toBe(true));
  });
});
