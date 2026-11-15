// @vitest-environment happy-dom
import * as React from "react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { $createTextNode, $getRoot, $createParagraphNode, type ElementNode, type LexicalEditor } from "lexical";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { $isEditorBlockRefNode, EditorBlockRefNode } from "../nodes";
import { BlockRefsPlugin, type BlockRefCandidate } from "./block-refs";

afterEach(cleanup);

function EditorCapture({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    onReady(editor);
  }, [editor, onReady]);
  return null;
}

function Harness({ onReady, children }: { onReady: (editor: LexicalEditor) => void; children: React.ReactNode }) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "block-refs-test",
        nodes: [EditorBlockRefNode],
        onError: (error) => {
          throw error;
        },
      }}
    >
      <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      <EditorCapture onReady={onReady} />
      {children}
    </LexicalComposer>
  );
}

const LABELS = { ariaLabel: "Block refs", empty: "No matches" };

function typeTrailingText(editor: LexicalEditor, text: string) {
  act(() => {
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        const textNode = $createTextNode(text);
        paragraph.append(textNode);
        root.append(paragraph);
        textNode.select(text.length, text.length);
      },
      { discrete: true },
    );
  });
}

describe("BlockRefsPlugin (( typeahead)", () => {
  it("queries on '((' and lists candidates from blocks/search", async () => {
    const candidates: BlockRefCandidate[] = [{ targetDocId: "doc-1", targetBlockId: "block-1", label: "Key decision", detail: "Doc › Section › Key decision" }];
    const search = vi.fn().mockResolvedValue(candidates);
    let editor!: LexicalEditor;
    render(
      <Harness onReady={(e) => (editor = e)}>
        <BlockRefsPlugin labels={LABELS} search={search} />
      </Harness>,
    );

    typeTrailingText(editor, "((decision");

    await waitFor(() => expect(search).toHaveBeenCalledWith("decision"));
    await waitFor(() => expect(screen.getByText("Key decision")).toBeInTheDocument());
  });

  it("selecting a candidate inserts a status:'ok' EditorBlockRefNode", async () => {
    const candidates: BlockRefCandidate[] = [{ targetDocId: "doc-1", targetBlockId: "block-1", label: "Key decision", detail: "Doc › Section" }];
    const search = vi.fn().mockResolvedValue(candidates);
    let editor!: LexicalEditor;
    render(
      <Harness onReady={(e) => (editor = e)}>
        <BlockRefsPlugin labels={LABELS} search={search} />
      </Harness>,
    );

    typeTrailingText(editor, "((decision");
    await waitFor(() => expect(screen.getByText("Key decision")).toBeInTheDocument());

    const option = screen.getByText("Key decision");
    await act(async () => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    editor.getEditorState().read(() => {
      const [paragraph] = $getRoot().getChildren() as [ElementNode];
      const node = paragraph.getChildren().find($isEditorBlockRefNode) as EditorBlockRefNode;
      expect(node).toBeDefined();
      expect(node.getBlockRef()).toMatchObject({ targetDocId: "doc-1", targetBlockId: "block-1", label: "Key decision", status: "ok" });
    });
  });
});
