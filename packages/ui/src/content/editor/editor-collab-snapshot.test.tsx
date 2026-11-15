// @vitest-environment happy-dom
import React, { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import { afterEach, describe, expect, it, vi } from "vitest";
import { $createMegaBlock } from "@megaui/content";

vi.mock("./plugins/collab", async (importOriginal) => ({
  ...await importOriginal<typeof import("./plugins/collab")>(),
  MegaDocCollabPlugin: () => null,
}));

import { MegaContentEditor } from "./editor";

function CaptureEditor({ onReady }: { readonly onReady: (editor: LexicalEditor) => void }): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => onReady(editor), [editor, onReady]);
  return null;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("collaborative document snapshots", () => {
  it("persists a changed collaborative block for embed resolution", () => {
    vi.useFakeTimers();
    let editor: LexicalEditor | undefined;
    const onAutoSave = vi.fn();
    render(
      <MegaContentEditor
        collab={{ documentName: "container:doc:source", token: "test-token", url: "ws://localhost:7002" }}
        initialStateJSON='{"root":{"children":[]}}'
        onAutoSave={onAutoSave}
        placeholder="Write…"
        preset="document"
      >
        <CaptureEditor onReady={(ready) => { editor = ready; }} />
      </MegaContentEditor>,
    );

    const liveEditor = editor;
    if (!liveEditor) throw new Error("Editor did not mount");
    act(() => {
      liveEditor.update(() => {
        const block = $createMegaBlock("text", "3277b6e5-e386-43d1-b411-ce99b609edad");
        block.append($createTextNode("Source block"));
        $getRoot().append(block);
      }, { discrete: true });
    });
    act(() => vi.advanceTimersByTime(2_100));

    expect(onAutoSave).toHaveBeenCalledTimes(1);
    expect(onAutoSave.mock.lastCall?.[0]).toContain("3277b6e5-e386-43d1-b411-ce99b609edad");
  });
});
