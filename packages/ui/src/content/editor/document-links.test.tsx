// @vitest-environment happy-dom
import * as React from "react";
import { useEffect } from "react";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isMegaBlockNode, createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import { MegaContentReader } from "../reader/reader";
import { MegaContentEditor } from "./editor";

afterEach(cleanup);

function Capture({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => onReady(editor), [editor, onReady]);
  return null;
}

describe("document links", () => {
  it("recognizes an external URL and preserves it in the read-only view", async () => {
    let editor!: LexicalEditor;
    const view = render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <Capture onReady={(value) => { editor = value; }} />
      </MegaContentEditor>,
    );
    act(() => editor.update(() => {
      const block = $getRoot().getFirstChild();
      if (!$isMegaBlockNode(block)) throw new Error("Expected a block");
      block.append($createTextNode("https://example.com/article"));
    }, { discrete: true }));
    await waitFor(() => expect(view.container.querySelector("a[href='https://example.com/article']")).toBeInTheDocument());
    const json = JSON.stringify(editor.getEditorState().toJSON());
    const reader = render(<MegaContentReader stateJSON={json} />);
    expect(within(reader.container).getByRole("link", { name: "https://example.com/article" })).toHaveAttribute("href", "https://example.com/article");
  });
});
