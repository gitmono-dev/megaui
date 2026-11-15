// @vitest-environment happy-dom
import * as React from "react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createMegaBlock, $isMegaBlockNode, createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import { MegaContentEditor } from "../editor";
import { TodoCheckboxPlugin } from "./todo-checkbox";

afterEach(cleanup);

const LABELS = { markComplete: "Mark TODO complete", markIncomplete: "Mark TODO incomplete" };

function EditorCapture({ onReady }: { readonly onReady: (editor: LexicalEditor) => void }): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => onReady(editor), [editor, onReady]);
  return null;
}

describe("TodoCheckboxPlugin", () => {
  it("renders an accessible checkbox and persists a click to the todo block", async () => {
    let editor: LexicalEditor | undefined;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <TodoCheckboxPlugin labels={LABELS} />
        <EditorCapture onReady={(readyEditor) => { editor = readyEditor; }} />
      </MegaContentEditor>,
    );

    act(() => {
      editor?.update(() => {
        const block = $getRoot().getFirstChild();
        if (!$isMegaBlockNode(block)) throw new Error("Expected the document seed block");
        block.setVariant("todo");
        block.append($createTextNode("Ship the checkbox"));
      }, { discrete: true });
    });

    const checkbox = await screen.findByRole("button", { name: LABELS.markComplete });
    expect(checkbox).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(checkbox);

    await waitFor(() => expect(screen.getByRole("button", { name: LABELS.markIncomplete })).toHaveAttribute("aria-pressed", "true"));
    let todoChecked: boolean | null = null;
    editor?.getEditorState().read(() => {
      const block = $getRoot().getFirstChild();
      if (!$isMegaBlockNode(block)) throw new Error("Expected a TODO block");
      todoChecked = block.getTodoChecked();
    });
    expect(todoChecked).toBe(true);
  });

  it("does not overlay a TODO checkbox inside a collapsed parent block", async () => {
    let editor: LexicalEditor | undefined;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <TodoCheckboxPlugin labels={LABELS} />
        <EditorCapture onReady={(readyEditor) => { editor = readyEditor; }} />
      </MegaContentEditor>,
    );

    act(() => {
      editor?.update(() => {
        const parent = $getRoot().getFirstChild();
        if (!$isMegaBlockNode(parent)) throw new Error("Expected the document seed block");
        parent.setCollapsed(true);
        parent.append($createMegaBlock("todo", "hidden-todo"));
      }, { discrete: true });
    });

    await waitFor(() => expect(screen.queryByRole("button", { name: LABELS.markComplete })).not.toBeInTheDocument());
  });
});
