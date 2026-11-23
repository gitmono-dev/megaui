// @vitest-environment happy-dom
import React, { useEffect, useRef } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { afterEach, expect, it, vi } from "vitest";
import type { Doc } from "yjs";
import { createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";

// Lexical 0.53 may disconnect during its effect replay before the binding's
// later effect connects the same provider.
vi.mock("@lexical/react/LexicalCollaborationPlugin", () => ({
  CollaborationPlugin: ({ id, providerFactory }: {
    id: string;
    providerFactory: (id: string, docs: Map<string, Doc>) => { connect(): void; disconnect(): void };
  }) => {
    const docs = useRef(new Map<string, Doc>());
    useEffect(() => {
      const provider = providerFactory(id, docs.current);
      provider.disconnect();
      const timer = setTimeout(() => provider.connect(), 30);
      return () => { clearTimeout(timer); provider.disconnect(); };
    }, [id, providerFactory]);
    return null;
  },
}));

import { MegaContentEditor } from "../editor";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("keeps the provider alive until Lexical connects it and disposes it on unmount", async () => {
  const connect = vi.spyOn(HocuspocusProviderWebsocket.prototype, "connect").mockResolvedValue(undefined);
  const destroy = vi.spyOn(HocuspocusProviderWebsocket.prototype, "destroy");
  const view = render(<MegaContentEditor
    collab={{ documentName: "container:doc:lifecycle", token: "test", url: "ws://127.0.0.1:7002" }}
    initialStateJSON={createEmptyMegaDocumentEditorStateJSON()}
    placeholder="Write"
    preset="document"
  />);
  await waitFor(() => expect(connect).toHaveBeenCalled());
  expect(destroy).not.toHaveBeenCalled();
  view.unmount();
  await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
});

it("disposes the previous provider when the collaboration document changes", async () => {
  const connect = vi.spyOn(HocuspocusProviderWebsocket.prototype, "connect").mockResolvedValue(undefined);
  const destroy = vi.spyOn(HocuspocusProviderWebsocket.prototype, "destroy");
  const editor = (documentName: string) => <MegaContentEditor
    collab={{ documentName, token: "test", url: "ws://127.0.0.1:7002" }}
    initialStateJSON={createEmptyMegaDocumentEditorStateJSON()}
    placeholder="Write"
    preset="document"
  />;
  const view = render(editor("container:doc:first"));
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
  view.rerender(editor("container:doc:second"));
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
  expect(destroy).toHaveBeenCalledTimes(1);
  view.unmount();
  await waitFor(() => expect(destroy).toHaveBeenCalledTimes(2));
});
