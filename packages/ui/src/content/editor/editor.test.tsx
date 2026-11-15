/**
 * UI-06 AC1/AC2/AC4 coverage for `MegaContentEditor` (megaui-only test file, no upstream
 * source — upstream's `editor.tsx` had no colocated test).
 *
 * AC1: editor init/input/serialize round-trip (editor state JSON ↔ mega blocks).
 * AC2: collab configured (`collab.url` set) but missing `token` → explicit read-only,
 *      no silent autosave of unsynced edits.
 * AC4: `collab` unset → plain local/editable mode, autosave still fires (no silent data
 *      loss vs. a "half-wired collab" editor that neither syncs nor persists).
 */
// @vitest-environment happy-dom
import * as React from "react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createHeadlessEditor } from "@lexical/headless";
import { $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createMegaBlock, $isMegaBlockNode, generateBlockId, MEGA_CONTENT_BLOCK_NODES, type MegaBlockNode } from "@megaui/content";
import { $getMegaBlockInlineText } from "./commands";
import { MegaContentEditor } from "./editor";
import { getContentPresetConfig } from "./preset";

afterEach(cleanup);

/** Builds a one-block `document` preset initial state JSON via a headless editor (not hand-rolled JSON). */
function makeInitialStateJSON(text: string, blockId = generateBlockId()): { json: string; blockId: string } {
  const editor = createHeadlessEditor({
    namespace: "editor-test-seed",
    nodes: [...MEGA_CONTENT_BLOCK_NODES],
    onError: (error) => {
      throw error;
    },
  });
  editor.update(
    () => {
      const block = $createMegaBlock("text", blockId);
      block.append($createTextNode(text));
      $getRoot().append(block);
    },
    { discrete: true },
  );
  return { json: JSON.stringify(editor.getEditorState().toJSON()), blockId };
}

function readBlockText(json: string): string {
  const editor = createHeadlessEditor({
    namespace: "editor-test-read",
    nodes: [...MEGA_CONTENT_BLOCK_NODES],
    onError: (error) => {
      throw error;
    },
  });
  const state = editor.parseEditorState(json);
  let text = "";
  state.read(() => {
    const [block] = $getRoot().getChildren();
    text = $isMegaBlockNode(block) ? $getMegaBlockInlineText(block as MegaBlockNode) : "";
  });
  return text;
}

/** Grabs the live Lexical editor instance from inside `MegaContentEditor`'s composer via `children`. */
function EditorCapture({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    onReady(editor);
  }, [editor, onReady]);
  return null;
}

describe("MegaContentEditor init / AC4 local mode", () => {
  it("mounts in local/editable mode when collab is unset, rendering the seeded block text", () => {
    const { json } = makeInitialStateJSON("Hello world");
    render(<MegaContentEditor initialStateJSON={json} placeholder="Write…" preset="document" />);

    const container = document.querySelector('[data-mega-content="editor"]');
    expect(container).not.toBeNull();
    expect(container?.getAttribute("data-mega-content-collab-mode")).toBe("local");
    expect(container?.getAttribute("data-mega-content-preset")).toBe("document");

    const contentEditable = document.querySelector('[data-mega-content="content-editable"]');
    expect(contentEditable?.getAttribute("aria-readonly")).toBe("false");
    expect(contentEditable?.getAttribute("contenteditable")).toBe("true");
    expect(contentEditable?.textContent).toContain("Hello world");
  });

  it("registers a node type set matching the document preset config", () => {
    const documentTypes = getContentPresetConfig("document").nodes.map((klass) => klass.getType()).sort();
    expect(documentTypes).toContain("mega-block");
    expect(documentTypes).toContain("mega-ref");
    expect(documentTypes).toContain("mega-embed");
    expect(documentTypes).toContain("mega-block-ref");
  });
});

describe("MegaContentEditor input/serialize round-trip (AC1)", () => {
  it("edits made via the live editor serialize back out to the same mega-block text", async () => {
    const { json, blockId } = makeInitialStateJSON("Hello");
    let liveEditor!: LexicalEditor;
    let readStateJSON: (() => string) | undefined;

    render(
      <MegaContentEditor
        initialStateJSON={json}
        placeholder="Write…"
        preset="document"
        registerStateReader={(reader) => {
          readStateJSON = reader;
        }}
      >
        <EditorCapture onReady={(e) => (liveEditor = e)} />
      </MegaContentEditor>,
    );

    // Sanity: the reader reflects the seeded state before any edit.
    expect(readBlockText(readStateJSON!())).toBe("Hello");

    // Simulate a user edit: append " world" to the seeded block's text.
    await act(async () => {
      liveEditor.update(
        () => {
          const found = $getRoot()
            .getChildren()
            .find((node) => $isMegaBlockNode(node) && (node as MegaBlockNode).getBlockId() === blockId);
          const block = found as MegaBlockNode;
          const [textNode] = block.getChildren();
          (textNode as unknown as { setTextContent: (t: string) => void }).setTextContent("Hello world");
        },
        { discrete: true },
      );
    });

    const serialized = readStateJSON!();
    expect(readBlockText(serialized)).toBe("Hello world");

    // Full round-trip: the exported JSON re-parses into an editor with the same block id/text.
    const rehydrated = createHeadlessEditor({
      namespace: "editor-test-rehydrate",
      nodes: [...MEGA_CONTENT_BLOCK_NODES],
      onError: (error) => {
        throw error;
      },
    });
    const state = rehydrated.parseEditorState(serialized);
    state.read(() => {
      const [block] = $getRoot().getChildren();
      expect($isMegaBlockNode(block)).toBe(true);
      expect((block as MegaBlockNode).getBlockId()).toBe(blockId);
      expect($getMegaBlockInlineText(block as MegaBlockNode)).toBe("Hello world");
    });
  });
});

describe("MegaContentEditor AC4: unset collab URL keeps local editing + autosave (no silent data loss)", () => {
  it("debounced autosave fires with the edited content when collab is not configured", async () => {
    vi.useFakeTimers();
    try {
      const { json, blockId } = makeInitialStateJSON("Draft");
      let liveEditor!: LexicalEditor;
      const onAutoSave = vi.fn();

      render(
        <MegaContentEditor initialStateJSON={json} onAutoSave={onAutoSave} placeholder="Write…" preset="document">
          <EditorCapture onReady={(e) => (liveEditor = e)} />
        </MegaContentEditor>,
      );

      act(() => {
        liveEditor.update(
          () => {
            const found = $getRoot()
              .getChildren()
              .find((node) => $isMegaBlockNode(node) && (node as MegaBlockNode).getBlockId() === blockId);
            const block = found as MegaBlockNode;
            const [textNode] = block.getChildren();
            (textNode as unknown as { setTextContent: (t: string) => void }).setTextContent("Draft edited");
          },
          { discrete: true },
        );
      });

      expect(onAutoSave).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(2_100);
      });

      expect(onAutoSave).toHaveBeenCalledTimes(1);
      const saved = onAutoSave.mock.calls[0]![0] as string;
      expect(readBlockText(saved)).toBe("Draft edited");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MegaContentEditor AC2: collab configured but missing token → fail-closed read-only", () => {
  it("renders read-only, non-editable, and never invokes onAutoSave for unsynced local edits", () => {
    const { json } = makeInitialStateJSON("Server copy");
    const onAutoSave = vi.fn();

    render(
      <MegaContentEditor
        collab={{ documentName: "container:doc:1", url: "wss://collab.example.test", token: undefined }}
        initialStateJSON={json}
        onAutoSave={onAutoSave}
        placeholder="Write…"
        preset="document"
      />,
    );

    const container = document.querySelector('[data-mega-content="editor"]');
    expect(container?.getAttribute("data-mega-content-collab-mode")).toBe("readonly");

    const contentEditable = document.querySelector('[data-mega-content="content-editable"]');
    expect(contentEditable?.getAttribute("aria-readonly")).toBe("true");
    expect(contentEditable?.getAttribute("contenteditable")).toBe("false");

    expect(onAutoSave).not.toHaveBeenCalled();
  });

  it("stays local/editable when collab.url itself is unset, even if a stray token is present (AC4 precedence)", () => {
    const { json } = makeInitialStateJSON("Untracked");
    render(
      <MegaContentEditor
        collab={{ documentName: "", url: "", token: "irrelevant" }}
        initialStateJSON={json}
        placeholder="Write…"
        preset="document"
      />,
    );
    const container = document.querySelector('[data-mega-content="editor"]');
    expect(container?.getAttribute("data-mega-content-collab-mode")).toBe("local");
    const contentEditable = document.querySelector('[data-mega-content="content-editable"]');
    expect(contentEditable?.getAttribute("aria-readonly")).toBe("false");
  });
});
