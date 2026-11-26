// @vitest-environment happy-dom
import * as React from "react";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { $createTextNode, $getRoot, PASTE_COMMAND, type LexicalEditor } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isMegaBlockNode, createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import { MegaContentReader } from "../../reader/reader";
import { MegaContentEditor } from "../editor";
import { OPEN_IMAGE_DIALOG_COMMAND } from "./image-command";
import { ImagePlugin, parseRoamImage } from "./images";

afterEach(cleanup);

const labels = { dialog: "Insert image", url: "Image URL", alt: "Description", file: "Upload", insert: "Insert", cancel: "Cancel", invalid: "Invalid", uploading: "Uploading" };

function Capture({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => onReady(editor), [editor, onReady]);
  return null;
}

describe("ImagePlugin", () => {
  it("does not interpret unsafe or malformed image syntax as an image", () => {
    expect(parseRoamImage("![x](javascript:alert(1))")).toBeNull();
    expect(parseRoamImage("![x](https://user:pass@example.com/a.png)")).toBeNull();
    expect(parseRoamImage("prefix ![x](https://example.com/a.png)")).toBeNull();
  });
  it("inserts a URL image, round-trips JSON into the reader, and allows removal", async () => {
    let editor!: LexicalEditor;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <ImagePlugin labels={labels} onError={vi.fn()} upload={vi.fn()} />
        <Capture onReady={(value) => { editor = value; }} />
      </MegaContentEditor>,
    );
    let blockId = "";
    editor.getEditorState().read(() => {
      const block = $getRoot().getFirstChild();
      blockId = $isMegaBlockNode(block) ? block.getBlockId() : "";
    });
    expect(blockId).not.toBe("");
    act(() => { editor.dispatchCommand(OPEN_IMAGE_DIALOG_COMMAND, blockId); });
    fireEvent.change(screen.getByLabelText(labels.url), { target: { value: "https://example.com/chart.png" } });
    fireEvent.change(screen.getByLabelText(labels.alt), { target: { value: "Chart" } });
    fireEvent.click(screen.getByRole("button", { name: labels.insert }));
    await waitFor(() => expect(screen.getByAltText("Chart")).toHaveAttribute("src", "https://example.com/chart.png"));
    const json = JSON.stringify(editor.getEditorState().toJSON());
    expect(json).toContain('"type":"mega-image"');
    expect(json).toContain('"text":"![Chart](https://example.com/chart.png)"');
    expect(json).not.toContain('"image":{"src"');
    const reader = render(<MegaContentReader stateJSON={json} />);
    expect(within(reader.container).getByAltText("Chart")).toHaveAttribute("src", "https://example.com/chart.png");
    act(() => editor.update(() => {
      const following = $getRoot().getLastChild();
      if ($isMegaBlockNode(following)) following.append($createTextNode("Existing line"));
    }, { discrete: true }));
    const image = screen.getByRole("group", { name: "Chart" });
    fireEvent.click(image);
    expect(image).toHaveFocus();
    fireEvent.keyDown(image, { key: "Enter" });
    await waitFor(() => expect(editor.getEditorState().toJSON().root.children).toHaveLength(3));
    expect(editor.getEditorState().toJSON().root.children[2]).toMatchObject({ children: [{ text: "Existing line" }] });
    fireEvent.click(screen.getByRole("button", { name: "Remove image" }));
    await waitFor(() => expect(JSON.stringify(editor.getEditorState().toJSON())).not.toContain('"type":"mega-image"'));
  });

  it("rejects unsafe image URLs before creating a node", async () => {
    let editor!: LexicalEditor;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <ImagePlugin labels={labels} onError={vi.fn()} upload={vi.fn()} />
        <Capture onReady={(value) => { editor = value; }} />
      </MegaContentEditor>,
    );
    let blockId = "";
    editor.getEditorState().read(() => {
      const block = $getRoot().getFirstChild();
      blockId = $isMegaBlockNode(block) ? block.getBlockId() : "";
    });
    act(() => { editor.dispatchCommand(OPEN_IMAGE_DIALOG_COMMAND, blockId); });
    fireEvent.change(screen.getByLabelText(labels.url), { target: { value: "javascript:alert(1)" } });
    fireEvent.submit(screen.getByRole("button", { name: labels.insert }).closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent(labels.invalid);
    expect(JSON.stringify(editor.getEditorState().toJSON())).not.toContain("mega-image");
  });

  it("uploads a clipboard image and inserts it in the selected block", async () => {
    let editor!: LexicalEditor;
    const upload = vi.fn().mockResolvedValue("https://example.com/upload.png");
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <ImagePlugin labels={labels} onError={vi.fn()} upload={upload} />
        <Capture onReady={(value) => { editor = value; }} />
      </MegaContentEditor>,
    );
    act(() => editor.update(() => {
      const block = $getRoot().getFirstChild();
      if ($isMegaBlockNode(block)) block.selectEnd();
    }, { discrete: true }));
    const file = new File(["pixels"], "chart.png", { type: "image/png" });
    const event = { clipboardData: { files: [file] }, preventDefault: vi.fn() } as unknown as ClipboardEvent;
    act(() => { expect(editor.dispatchCommand(PASTE_COMMAND, event)).toBe(true); });
    await waitFor(() => expect(upload).toHaveBeenCalledWith(file));
    await waitFor(() => expect(screen.getByAltText("chart.png")).toHaveAttribute("src", "https://example.com/upload.png"));
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("renders a pasted Roam markdown image", async () => {
    let editor!: LexicalEditor;
    render(
      <MegaContentEditor initialStateJSON={createEmptyMegaDocumentEditorStateJSON()} placeholder="Write" preset="document">
        <ImagePlugin labels={labels} onError={vi.fn()} upload={vi.fn()} />
        <Capture onReady={(value) => { editor = value; }} />
      </MegaContentEditor>,
    );
    act(() => editor.update(() => {
      const block = $getRoot().getFirstChild();
      if ($isMegaBlockNode(block)) block.selectEnd();
    }, { discrete: true }));
    const event = {
      clipboardData: { files: [], getData: (type: string) => type === "text/plain" ? "![Chart](https://example.com/chart.png)" : "" },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent;
    act(() => { expect(editor.dispatchCommand(PASTE_COMMAND, event)).toBe(true); });
    await waitFor(() => expect(screen.getByAltText("Chart")).toHaveAttribute("src", "https://example.com/chart.png"));
    expect(event.preventDefault).toHaveBeenCalled();
  });
});
