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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { $isEditorEmbedNode, EditorEmbedNode, EditorRefNode } from "../nodes";
import { EmbedsPlugin, type EmbedCandidate } from "./embeds";

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
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LexicalComposer
        initialConfig={{
          namespace: "embeds-test",
          nodes: [EditorEmbedNode, EditorRefNode],
          onError: (error) => {
            throw error;
          },
        }}
      >
        <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
        <EditorCapture onReady={onReady} />
        {children}
      </LexicalComposer>
    </QueryClientProvider>
  );
}

const LABELS = { ariaLabel: "Embeds", empty: "No matches", pagesGroup: "Pages", blocksGroup: "Blocks" };

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

describe("EmbedsPlugin ({{ typeahead)", () => {
  it("queries on '{{' and lists both page and block candidates", async () => {
    const candidates: EmbedCandidate[] = [
      { kind: "page", targetDocId: "doc-1", label: "Roadmap", detail: "doc" },
      { kind: "block", targetDocId: "doc-2", targetBlockId: "block-1", label: "Summary", detail: "block" },
    ];
    const search = vi.fn().mockResolvedValue(candidates);
    let editor!: LexicalEditor;
    render(
      <Harness onReady={(e) => (editor = e)}>
        <EmbedsPlugin labels={LABELS} search={search} />
      </Harness>,
    );

    typeTrailingText(editor, "{{Road");

    await waitFor(() => expect(search).toHaveBeenCalledWith("Road"));
    await waitFor(() => expect(screen.getByText("Roadmap")).toBeInTheDocument());
    expect(screen.getByText("Summary")).toBeInTheDocument();
  });

  it("shows the empty label when the query returns no candidates", async () => {
    const search = vi.fn().mockResolvedValue([]);
    let editor!: LexicalEditor;
    render(
      <Harness onReady={(e) => (editor = e)}>
        <EmbedsPlugin labels={LABELS} search={search} />
      </Harness>,
    );

    typeTrailingText(editor, "{{nothing");

    await waitFor(() => expect(search).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("No matches")).toBeInTheDocument());
  });

  it("selecting a page candidate inserts an EditorEmbedNode with no targetBlockId", async () => {
    const candidates: EmbedCandidate[] = [{ kind: "page", targetDocId: "doc-1", label: "Roadmap", detail: "doc" }];
    const search = vi.fn().mockResolvedValue(candidates);
    let editor!: LexicalEditor;
    render(
      <Harness onReady={(e) => (editor = e)}>
        <EmbedsPlugin labels={LABELS} search={search} />
      </Harness>,
    );

    typeTrailingText(editor, "{{Road");
    await waitFor(() => expect(screen.getByText("Roadmap")).toBeInTheDocument());

    const option = screen.getByText("Roadmap");
    await act(async () => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    editor.getEditorState().read(() => {
      const [paragraph] = $getRoot().getChildren() as [ElementNode];
      const embedNode = paragraph.getChildren().find($isEditorEmbedNode);
      expect(embedNode).toBeDefined();
      expect((embedNode as EditorEmbedNode).getEmbed()).toMatchObject({ targetDocId: "doc-1", label: "Roadmap" });
      expect((embedNode as EditorEmbedNode).getEmbed().targetBlockId).toBeUndefined();
    });
  });

  it("selecting a block candidate inserts an EditorEmbedNode carrying targetBlockId", async () => {
    const candidates: EmbedCandidate[] = [{ kind: "block", targetDocId: "doc-2", targetBlockId: "block-1", label: "Summary", detail: "block" }];
    const search = vi.fn().mockResolvedValue(candidates);
    let editor!: LexicalEditor;
    render(
      <Harness onReady={(e) => (editor = e)}>
        <EmbedsPlugin labels={LABELS} search={search} />
      </Harness>,
    );

    typeTrailingText(editor, "{{Sum");
    await waitFor(() => expect(screen.getByText("Summary")).toBeInTheDocument());

    const option = screen.getByText("Summary");
    await act(async () => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    editor.getEditorState().read(() => {
      const [paragraph] = $getRoot().getChildren() as [ElementNode];
      const embedNode = paragraph.getChildren().find($isEditorEmbedNode) as EditorEmbedNode;
      expect(embedNode.getEmbed()).toMatchObject({ targetDocId: "doc-2", targetBlockId: "block-1", label: "Summary" });
    });
  });
});
