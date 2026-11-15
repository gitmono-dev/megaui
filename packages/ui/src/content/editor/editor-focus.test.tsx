// @vitest-environment happy-dom
import React, { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createTextNode, $getRoot, $isElementNode, type LexicalEditor } from "lexical";
import { createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import { MegaContentEditor } from "./editor";

afterEach(cleanup);

function Capture({ ready }: { ready: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => ready(editor), [editor, ready]);
  return null;
}

it("does not reconcile the document when a sibling comment field updates during IME composition", async () => {
  let editor!: LexicalEditor;
  const initialStateJSON = createEmptyMegaDocumentEditorStateJSON();
  function Harness() {
    const [comment, setComment] = useState('');
    return <>
      <MegaContentEditor initialStateJSON={initialStateJSON} placeholder="Document" preset="document">
        <Capture ready={value => { editor = value; }} />
      </MegaContentEditor>
      <textarea aria-label="Comment" value={comment} onChange={event => setComment(event.target.value)} />
    </>;
  }
  render(<Harness />);
  await act(async () => {
    editor.update(() => {
      const block = $getRoot().getFirstChild();
      if (!$isElementNode(block)) throw new Error('Missing starter block');
      block.append($createTextNode('Document must stay unchanged'));
      block.selectEnd();
    }, { discrete: true });
  });
  const comment = screen.getByRole('textbox', { name: 'Comment' });
  comment.focus();
  const changes = vi.fn();
  const unregister = editor.registerUpdateListener(changes);
  fireEvent.compositionStart(comment);
  for (const value of ['z', 'zhong', '中文']) {
    await act(async () => { fireEvent.change(comment, { target: { value } }); });
  }
  fireEvent.compositionEnd(comment, { data: '中文' });
  expect(changes).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(comment);
  expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('Document must stay unchanged');
  unregister();
});
