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
import { $isEditorRefNode, EditorEmbedNode, EditorRefNode } from "../nodes";
import { WikilinksPlugin, type WikilinkCandidate } from "./wikilinks";

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
        namespace: "wikilinks-test",
        nodes: [EditorRefNode, EditorEmbedNode],
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

const LABELS = { ariaLabel: "Wikilinks", createPage: 'Create "{title}"', empty: "No matches" };

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

describe("WikilinksPlugin ([[ typeahead)", () => {
  it("queries on '[[' and lists resolved candidates", async () => {
    const candidates: WikilinkCandidate[] = [{ kind: "doc", targetTitle: "Roadmap", targetId: "doc-1", detail: "Docs" }];
    const search = vi.fn().mockResolvedValue(candidates);
    let editor!: LexicalEditor;
    render(
      <Harness onReady={(e) => (editor = e)}>
        <WikilinksPlugin labels={LABELS} search={search} />
      </Harness>,
    );

    typeTrailingText(editor, "[[Road");

    await waitFor(() => expect(search).toHaveBeenCalledWith("Road"));
    await waitFor(() => expect(screen.getByText("Roadmap")).toBeInTheDocument());
    // Query "Road" is a substring, not an exact title match, so a create-page offer also shows.
    expect(screen.getByText('Create "Road"')).toBeInTheDocument();
  });

  it("suppresses the create-page offer once the typed query is an exact title match", async () => {
    const candidates: WikilinkCandidate[] = [{ kind: "doc", targetTitle: "Roadmap", targetId: "doc-1" }];
    const search = vi.fn().mockResolvedValue(candidates);
    let editor!: LexicalEditor;
    render(
      <Harness onReady={(e) => (editor = e)}>
        <WikilinksPlugin labels={LABELS} search={search} />
      </Harness>,
    );

    typeTrailingText(editor, "[[Roadmap");

    await waitFor(() => expect(search).toHaveBeenCalledWith("Roadmap"));
    await waitFor(() => expect(screen.getByText("Roadmap")).toBeInTheDocument());
    expect(screen.queryByText('Create "Roadmap"')).not.toBeInTheDocument();
  });

  it("offers create-page when there is no exact-title match", async () => {
    const search = vi.fn().mockResolvedValue([]);
    let editor!: LexicalEditor;
    render(
      <Harness onReady={(e) => (editor = e)}>
        <WikilinksPlugin labels={LABELS} search={search} />
      </Harness>,
    );

    typeTrailingText(editor, "[[Brand New Page");

    await waitFor(() => expect(search).toHaveBeenCalledWith("Brand New Page"));
    await waitFor(() => expect(screen.getByText('Create "Brand New Page"')).toBeInTheDocument());
  });

  it("suppresses the create-page offer when allowCreate is false (chat preset)", async () => {
    const search = vi.fn().mockResolvedValue([]);
    let editor!: LexicalEditor;
    render(
      <Harness onReady={(e) => (editor = e)}>
        <WikilinksPlugin allowCreate={false} labels={LABELS} search={search} />
      </Harness>,
    );

    typeTrailingText(editor, "[[Nothing Here");

    await waitFor(() => expect(search).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("No matches")).toBeInTheDocument());
    expect(screen.queryByText('Create "Nothing Here"')).not.toBeInTheDocument();
  });

  it("selecting a resolved candidate replaces the trigger text with an EditorRefNode", async () => {
    const candidates: WikilinkCandidate[] = [{ kind: "doc", targetTitle: "Roadmap", targetId: "doc-1" }];
    const search = vi.fn().mockResolvedValue(candidates);
    let editor!: LexicalEditor;
    render(
      <Harness onReady={(e) => (editor = e)}>
        <WikilinksPlugin labels={LABELS} search={search} />
      </Harness>,
    );

    typeTrailingText(editor, "[[Road");
    await waitFor(() => expect(screen.getByText("Roadmap")).toBeInTheDocument());

    const option = screen.getByText("Roadmap");
    await act(async () => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    editor.getEditorState().read(() => {
      const [paragraph] = $getRoot().getChildren() as [ElementNode];
      const refNode = paragraph.getChildren().find($isEditorRefNode);
      expect(refNode).toBeDefined();
      expect((refNode as EditorRefNode).getRef()).toMatchObject({ kind: "doc", targetTitle: "Roadmap", targetId: "doc-1" });
    });
  });

  it("recognizes direct #N (issue) / !N (CL) / @user triggers and filters candidates by kind", async () => {
    const candidates: WikilinkCandidate[] = [
      { kind: "issue", targetTitle: "Fix crash", targetId: "42" },
      { kind: "cl", targetTitle: "Add feature", targetId: "42" },
    ];
    const search = vi.fn().mockResolvedValue(candidates);
    let editor!: LexicalEditor;
    render(
      <Harness onReady={(e) => (editor = e)}>
        <WikilinksPlugin labels={LABELS} search={search} />
      </Harness>,
    );

    typeTrailingText(editor, "see #42");

    await waitFor(() => expect(search).toHaveBeenCalledWith("42"));
    await waitFor(() => expect(screen.getByText("Fix crash")).toBeInTheDocument());
    expect(screen.queryByText("Add feature")).not.toBeInTheDocument();
  });

  it("treats a non-numeric #query as a page tag while preserving #N for Issue references", async () => {
    const candidates: WikilinkCandidate[] = [
      { kind: "doc", targetTitle: "Planning", targetId: "doc-1" },
      { kind: "issue", targetTitle: "Fix crash", targetId: "42" },
    ];
    const search = vi.fn().mockResolvedValue(candidates);
    let editor!: LexicalEditor;
    render(
      <Harness onReady={(e) => (editor = e)}>
        <WikilinksPlugin labels={LABELS} search={search} />
      </Harness>,
    );

    typeTrailingText(editor, "#Plan");
    await waitFor(() => expect(screen.getByText("Planning")).toBeInTheDocument());
    expect(screen.queryByText("Fix crash")).not.toBeInTheDocument();

    const tagOption = screen.getByText("Planning");
    await act(async () => {
      tagOption.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      tagOption.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    editor.getEditorState().read(() => {
      const [paragraph] = $getRoot().getChildren() as [ElementNode];
      expect(paragraph.getTextContent()).toBe("#Planning");
      const refNode = paragraph.getChildren().find($isEditorRefNode) as EditorRefNode;
      expect(refNode.getTextContent()).toBe("#Planning");
      expect(paragraph.getChildren()).toHaveLength(1);
      expect(refNode.getRef()).toMatchObject({ kind: "doc", targetTitle: "Planning", targetId: "doc-1" });
    });

    typeTrailingText(editor, "#42");
    await waitFor(() => expect(screen.getByText("Fix crash")).toBeInTheDocument());
    expect(screen.queryByText("Planning")).not.toBeInTheDocument();
  });

  it("resolves a created page before inserting its reference", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const createPage = vi.fn().mockResolvedValue({ kind: "doc", targetTitle: "Brand New Page", targetId: "doc-created" });
    let editor!: LexicalEditor;
    render(
      <Harness onReady={(e) => (editor = e)}>
        <WikilinksPlugin createPage={createPage} labels={LABELS} search={search} />
      </Harness>,
    );

    typeTrailingText(editor, "[[Brand New Page");
    await waitFor(() => expect(screen.getByText('Create "Brand New Page"')).toBeInTheDocument());

    const createOption = screen.getByText('Create "Brand New Page"');
    await act(async () => {
      createOption.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      createOption.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await waitFor(() => expect(createPage).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      editor.getEditorState().read(() => {
        const [paragraph] = $getRoot().getChildren() as [ElementNode];
        const refNode = paragraph.getChildren().find($isEditorRefNode) as EditorRefNode;
        expect(refNode.getRef()).toMatchObject({ kind: "doc", targetTitle: "Brand New Page", targetId: "doc-created" });
      });
    });
  });
});
