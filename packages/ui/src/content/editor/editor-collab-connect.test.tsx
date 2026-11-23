// @vitest-environment happy-dom
import React, { StrictMode, useEffect } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { LexicalEditor } from "lexical";
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import { MegaContentEditor } from "./editor";

vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: class {
    whenSynced = new Promise<void>((resolve) => setTimeout(resolve, 100));
    destroy() { return Promise.resolve(); }
  },
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("connects the collaborative editor under React Strict Mode", async () => {
  const connect = vi.spyOn(HocuspocusProviderWebsocket.prototype, "connect").mockResolvedValue(undefined);
  const destroy = vi.spyOn(HocuspocusProviderWebsocket.prototype, "destroy");
  vi.stubGlobal("indexedDB", {});
  render(
    <StrictMode>
      <MegaContentEditor
        collab={{ documentName: "container:doc:test", token: "test", url: "ws://127.0.0.1:7002" }}
        initialStateJSON={createEmptyMegaDocumentEditorStateJSON()}
        placeholder="Write"
        preset="document"
      />
    </StrictMode>,
  );
  await waitFor(() => expect(connect).toHaveBeenCalled(), { timeout: 4000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(destroy).not.toHaveBeenCalled();
});

it("recreates the actual Lexical editor when changing collaboration documents", async () => {
  vi.spyOn(HocuspocusProviderWebsocket.prototype, "connect").mockResolvedValue(undefined);
  const editors: LexicalEditor[] = [];
  function Capture() {
    const [editor] = useLexicalComposerContext();
    useEffect(() => { editors.push(editor); }, [editor]);
    return null;
  }
  const seed = createEmptyMegaDocumentEditorStateJSON();
  const renderEditor = (documentName: string) => <MegaContentEditor
    collab={{ documentName, token: "test", url: "ws://127.0.0.1:7002" }}
    initialStateJSON={seed}
    placeholder="Write"
    preset="document"
  ><Capture /></MegaContentEditor>;
  const view = render(renderEditor("container:doc:first"));
  await waitFor(() => expect(editors).toHaveLength(1));
  view.rerender(renderEditor("container:doc:second"));
  await waitFor(() => expect(editors).toHaveLength(2));
  expect(editors[1]).not.toBe(editors[0]);
});
