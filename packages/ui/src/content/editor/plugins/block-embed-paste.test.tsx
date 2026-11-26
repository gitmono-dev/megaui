// @vitest-environment happy-dom
import { createHeadlessEditor } from "@lexical/headless";
import { $createTextNode, $getRoot } from "lexical";
import { $createMegaBlock, MegaBlockNode } from "@megaui/content";
import { describe, expect, it } from "vitest";

import { $createEditorEmbedNode, EditorEmbedNode } from "../nodes";
import { $insertBlockEmbedAtSelection, parseBlockEmbedClipboard, wrapRootEmbeds } from "./block-embed-paste";

describe("parseBlockEmbedClipboard", () => {
  it("rejects UUID and malformed block identities", () => {
    for (const id of ["573ddfe6-ee19-4015-89dd-558f7a5e44db", "short", "abcdefghijklM"]) {
      expect(parseBlockEmbedClipboard(`{{[[embed]]: ((${id}))}}`, "", "doc_current")).toBeNull();
    }
  });
  it("inserts a copied embed at an empty nested block selection", () => {
    const editor = createHeadlessEditor({
      namespace: "nested-embed-paste",
      nodes: [MegaBlockNode, EditorEmbedNode],
      onError: (error) => { throw error; },
    });
    editor.update(() => {
      const parent = $createMegaBlock("text", "parent");
      const empty = $createMegaBlock("text", "empty");
      parent.append(empty);
      $getRoot().append(parent);
      empty.selectEnd();
      expect($insertBlockEmbedAtSelection({ targetDocId: "source", targetBlockId: "source-block" })).toBe(true);
    }, { discrete: true });
    const root = editor.getEditorState().toJSON().root;
    expect(JSON.stringify(root)).toContain('"type":"mega-embed"');
    expect(root.children[0]).toMatchObject({
      children: [
        { blockId: "empty", children: [{ type: "mega-embed" }] },
        { type: "mega-block", variant: "text", children: [] },
      ],
    });
  });

  it("adds an embed sibling after a populated nested block without deleting its text", () => {
    const editor = createHeadlessEditor({
      namespace: "populated-nested-embed-paste",
      nodes: [MegaBlockNode, EditorEmbedNode],
      onError: (error) => { throw error; },
    });
    editor.update(() => {
      const parent = $createMegaBlock("text", "parent");
      const child = $createMegaBlock("text", "child");
      const childText = $createTextNode("Keep this text");
      child.append(childText);
      parent.append(child);
      $getRoot().append(parent);
      childText.selectEnd();
      expect($insertBlockEmbedAtSelection({ targetDocId: "source", targetBlockId: "source-block" })).toBe(true);
    }, { discrete: true });
    const root = editor.getEditorState().toJSON().root;
    expect(root.children[0]).toMatchObject({
      children: [
        { blockId: "child", children: [{ text: "Keep this text" }] },
        { children: [{ type: "mega-embed" }] },
        { type: "mega-block", variant: "text", children: [] },
      ],
    });
  });

  it("adds an embed sibling after a populated root block", () => {
    const editor = createHeadlessEditor({
      namespace: "populated-root-embed-paste",
      nodes: [MegaBlockNode, EditorEmbedNode],
      onError: (error) => { throw error; },
    });
    editor.update(() => {
      const block = $createMegaBlock("text", "original");
      const content = $createTextNode("Keep this text");
      block.append(content);
      $getRoot().append(block);
      content.selectEnd();
      expect($insertBlockEmbedAtSelection({ targetDocId: "source", targetBlockId: "source-block" })).toBe(true);
    }, { discrete: true });
    expect(editor.getEditorState().toJSON().root.children).toMatchObject([
      { blockId: "original", children: [{ text: "Keep this text" }] },
      { children: [{ type: "mega-embed" }] },
      { type: "mega-block", variant: "text", children: [] },
    ]);
  });

  it("keeps the source document for a copied block embed", () => {
    const result = parseBlockEmbedClipboard(
      "{{[[embed]]: ((source-block))}}",
      '<span data-mega-embed-doc="doc_source" data-mega-embed-block="source-block">embed</span>',
      "doc_current",
    );
    expect(result).toEqual({ targetDocId: "doc_source", targetBlockId: "source-block" });
  });

  it("uses the current document for plain-text Roam embeds", () => {
    expect(parseBlockEmbedClipboard("{{[[embed]]: ((SameDocBlk01))}}", "", "doc_current"))
      .toEqual({ targetDocId: "doc_current", targetBlockId: "SameDocBlk01" });
  });

  it("does not trust a rich clipboard marker for a different block", () => {
    const result = parseBlockEmbedClipboard(
      "{{[[embed]]: ((Requested001))}}",
      '<span data-mega-embed-doc="doc_unrelated" data-mega-embed-block="other-block">embed</span>',
      "doc_current",
    );
    expect(result).toEqual({ targetDocId: "doc_current", targetBlockId: "Requested001" });
  });

  it("leaves ordinary pasted text alone", () => {
    expect(parseBlockEmbedClipboard("Use ((source-block))", "", "doc_current")).toBeNull();
  });

  it("moves a legacy root-level embed into a real block without changing its target", () => {
    const editor = createHeadlessEditor({
      namespace: "legacy-embed-repair",
      nodes: [MegaBlockNode, EditorEmbedNode],
      onError: (error) => { throw error; },
    });
    editor.update(() => {
      $getRoot().append($createMegaBlock("text", "existing-block"));
      $getRoot().append($createEditorEmbedNode({ targetDocId: "doc_source", targetBlockId: "source-block" }));
      expect(wrapRootEmbeds()).toBe(true);
    }, { discrete: true });

    const children = editor.getEditorState().toJSON().root.children;
    expect(children.map((node) => node.type)).toEqual(["mega-block", "mega-block"]);
    expect(children[1]).toMatchObject({
      children: [{ type: "mega-embed", targetDocId: "doc_source", text: "{{[[embed]]: ((source-block))}}" }],
    });
  });
});
