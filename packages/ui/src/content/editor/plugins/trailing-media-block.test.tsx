// @vitest-environment happy-dom
import * as React from "react";
import { useEffect } from "react";
import { createHeadlessEditor } from "@lexical/headless";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import { afterEach, describe, expect, it } from "vitest";
import { $createMegaBlock, $isMegaBlockNode, type MegaBlockNode } from "@megaui/content";
import { MegaContentEditor } from "../editor";
import { $createEditorImageNode } from "../image-node";
import { $createEditorEmbedNode } from "../nodes";
import { getContentPresetConfig } from "../preset";
import { TrailingMediaBlockPlugin } from "./trailing-media-block";

afterEach(cleanup);

function savedDocument(kind: "image" | "embed" | "text" | "image-with-next-block", nested = false): string {
  const editor = createHeadlessEditor({
    namespace: "trailing-media-seed",
    nodes: getContentPresetConfig("document").nodes,
    onError: (error) => { throw error; },
  });
  editor.update(() => {
    const rootBlock = $createMegaBlock("text", "root-block");
    const contentBlock = nested ? $createMegaBlock("text", "nested-block") : rootBlock;
    if (nested) rootBlock.append(contentBlock);
    if (kind === "image" || kind === "image-with-next-block") {
      contentBlock.append($createEditorImageNode({ src: "https://example.com/image.png", alt: "Example" }));
    } else if (kind === "embed") {
      contentBlock.append($createEditorEmbedNode({ targetDocId: "doc-one" }));
    } else {
      contentBlock.append($createTextNode("Still writing"));
    }
    $getRoot().append(rootBlock);
    if (kind === "image-with-next-block") rootBlock.insertAfter($createMegaBlock("text", "existing-next-block"));
  }, { discrete: true });
  return JSON.stringify(editor.getEditorState().toJSON());
}

function EditorCapture({ onReady }: { onReady: (editor: LexicalEditor) => void }): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

function readBlocks(editor: LexicalEditor): { rootCount: number; nestedCount: number; lastIsBlank: boolean } {
  let result = { rootCount: 0, nestedCount: 0, lastIsBlank: false };
  editor.getEditorState().read(() => {
    const children = $getRoot().getChildren();
    const last = children.at(-1);
    const first = children[0];
    result = {
      rootCount: children.length,
      nestedCount: $isMegaBlockNode(first) ? first.getChildren().filter($isMegaBlockNode).length : 0,
      lastIsBlank: $isMegaBlockNode(last) && last.getChildrenSize() === 0,
    };
  });
  return result;
}

async function mountSavedDocument(json: string): Promise<LexicalEditor> {
  let editor: LexicalEditor | undefined;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MegaContentEditor initialStateJSON={json} placeholder="Write…" preset="document">
        <TrailingMediaBlockPlugin />
        <EditorCapture onReady={(value) => { editor = value; }} />
      </MegaContentEditor>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(editor).toBeDefined());
  return editor as LexicalEditor;
}

describe("TrailingMediaBlockPlugin", () => {
  it("adds one editable root row after a saved terminal image and keeps it through later updates", async () => {
    const editor = await mountSavedDocument(savedDocument("image"));
    await waitFor(() => expect(readBlocks(editor)).toMatchObject({ rootCount: 2, lastIsBlank: true }));

    act(() => {
      editor.update(() => {
        const last = $getRoot().getLastChild();
        if (!$isMegaBlockNode(last)) throw new Error("Expected a trailing block");
        last.append($createTextNode("Next line"));
      }, { discrete: true });
    });
    await waitFor(() => expect(readBlocks(editor).rootCount).toBe(2));
    expect(editor.getEditorState().toJSON().root.children).toHaveLength(2);
  });

  it("adds a sibling row after a nested terminal embed", async () => {
    const editor = await mountSavedDocument(savedDocument("embed", true));
    await waitFor(() => expect(readBlocks(editor)).toMatchObject({ rootCount: 1, nestedCount: 2 }));
    editor.getEditorState().read(() => {
      const rootBlock = $getRoot().getFirstChild() as MegaBlockNode;
      const nested = rootBlock.getLastChild();
      expect($isMegaBlockNode(nested) && nested.getChildrenSize() === 0).toBe(true);
    });
  });

  it.each(["text", "image-with-next-block"] as const)("leaves an existing %s ending unchanged", async (kind) => {
    const editor = await mountSavedDocument(savedDocument(kind));
    const expected = kind === "text" ? 1 : 2;
    await waitFor(() => expect(readBlocks(editor).rootCount).toBe(expected));
    act(() => { editor.update(() => { $getRoot().getFirstChild()?.getTextContent(); }, { discrete: true }); });
    expect(readBlocks(editor).rootCount).toBe(expected);
  });
});
