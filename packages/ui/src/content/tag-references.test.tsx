// @vitest-environment happy-dom
import * as React from "react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { $createParagraphNode, $createTextNode, $getRoot, type Klass, type LexicalEditor } from "lexical";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { type RefNode, type RefNodeValue } from "@megaui/content";
import { EditorRefNode } from "./editor/nodes";
import { ReaderRefNode } from "./reader/nodes";
import { TagReferencesPlugin } from "./tag-references";

afterEach(cleanup);

function Capture({ ready }: { ready: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => ready(editor), [editor, ready]);
  return null;
}

function Harness({ nodeClass, ready }: { nodeClass: Klass<RefNode>; ready: (editor: LexicalEditor) => void }) {
  return <LexicalComposer initialConfig={{ namespace: "tag-normalization", nodes: [nodeClass], onError: (error) => { throw error; } }}>
    <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
    <TagReferencesPlugin nodeClass={nodeClass} />
    <Capture ready={ready} />
  </LexicalComposer>;
}

describe("tag references compatibility", () => {
  it.each([EditorRefNode, ReaderRefNode])("normalizes legacy tags from skipped transforms with %s and stays stable on reload", async (NodeClass) => {
    let editor!: LexicalEditor;
    const { container } = render(<Harness nodeClass={NodeClass} ready={(value) => { editor = value; }} />);
    const tag: RefNodeValue = { kind: "doc", notation: "tag", targetId: "doc-tag", targetTitle: "Planning" };
    await act(async () => {
      editor.update(() => {
        const paragraph = $createParagraphNode().append(
          $createTextNode("before ##").setFormat("bold"), new NodeClass(tag),
          $createTextNode(" #"), new NodeClass({ ...tag, tagPrefix: "inline" }),
          $createTextNode(" after"),
        );
        $getRoot().clear().append(paragraph);
      }, { discrete: true, skipTransforms: true });
    });
    await waitFor(() => expect(container.querySelectorAll('[data-ref-notation="tag"]')[0]?.textContent).toBe("#Planning"));
    editor.getEditorState().read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      expect(paragraph.getTextContent()).toBe("before ##Planning ##Planning after");
    });

    const saved = JSON.stringify(editor.getEditorState().toJSON());
    await act(async () => { editor.setEditorState(editor.parseEditorState(saved)); });
    expect(JSON.stringify(editor.getEditorState().toJSON())).toBe(saved);
    expect(container.querySelector("strong")?.textContent).toBe("before #");
    expect(Array.from(container.querySelectorAll('[data-ref-notation="tag"]'), (tag) => tag.textContent)).toEqual(["#Planning", "#Planning"]);
  });

  it("repairs a legacy tag with no hash without changing ordinary page and issue references", async () => {
    let editor!: LexicalEditor;
    const { container } = render(<Harness nodeClass={EditorRefNode} ready={(value) => { editor = value; }} />);
    await act(async () => {
      editor.update(() => {
        $getRoot().clear().append($createParagraphNode().append(
          new EditorRefNode({ kind: "doc", notation: "tag", targetTitle: "New" }),
          $createTextNode(" "), new EditorRefNode({ kind: "doc", targetTitle: "Wiki", targetId: "wiki" }),
          $createTextNode(" "), new EditorRefNode({ kind: "issue", targetTitle: "Issue", targetId: "42" }),
        ));
      }, { discrete: true });
    });
    expect(container.querySelector('[data-ref-notation="tag"]')?.textContent).toBe("#New");
    editor.getEditorState().read(() => expect($getRoot().getTextContent()).toBe("#New [[Wiki]] Issue"));
  });
});
