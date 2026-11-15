// @vitest-environment happy-dom
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $getRoot, type ElementNode, type LexicalNode } from "lexical";
import { describe, expect, it } from "vitest";
import { $createEditorBlockRefNode, $createEditorEmbedNode, $createEditorRefNode, $isEditorBlockRefNode, $isEditorEmbedNode, $isEditorRefNode, EditorBlockRefNode, EditorEmbedNode, EditorRefNode } from "./nodes";

function makeEditor() {
  return createHeadlessEditor({
    namespace: "nodes-test",
    nodes: [EditorRefNode, EditorEmbedNode, EditorBlockRefNode],
    onError: (error) => {
      throw error;
    },
  });
}

// RefNode / BlockRefNode are inline decorator nodes (isInline() === true): Lexical requires
// root's direct children to be block-level, so tests append them inside a paragraph wrapper
// (matching how they actually appear in real documents — inline content within a block).
function appendInline(node: LexicalNode) {
  const paragraph = $createParagraphNode();
  paragraph.append(node);
  $getRoot().append(paragraph);
}

/** `$getRoot().getChildren()` types elements as `LexicalNode`; every node under test here is
 * always a paragraph/element wrapper, so this centralizes the one narrowing cast. */
function childrenOf(node: LexicalNode | undefined): LexicalNode[] {
  return (node as ElementNode).getChildren();
}

describe("EditorRefNode", () => {
  it("exports JSON under the wire-compatible 'mega-ref' type", () => {
    const editor = makeEditor();
    let serialized: unknown;
    editor.update(
      () => {
        const node = $createEditorRefNode({ kind: "doc", targetTitle: "Roadmap", targetId: "doc-1" });
        appendInline(node);
        serialized = node.exportJSON();
      },
      { discrete: true },
    );
    expect(serialized).toMatchObject({ type: "mega-ref", version: 1, ref: { kind: "doc", targetTitle: "Roadmap", targetId: "doc-1" } });
  });

  it("round-trips through JSON and importJSON produces an EditorRefNode (not the base RefNode)", () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const node = $createEditorRefNode({ kind: "issue", targetTitle: "Bug", targetId: "42" });
        appendInline(node);
      },
      { discrete: true },
    );
    const json = JSON.stringify(editor.getEditorState().toJSON());
    const restored = editor.parseEditorState(json);
    restored.read(() => {
      const [paragraph] = $getRoot().getChildren();
      const [node] = childrenOf(paragraph);
      expect($isEditorRefNode(node)).toBe(true);
      expect((node as EditorRefNode).getRef()).toEqual({ kind: "issue", targetTitle: "Bug", targetId: "42" });
    });
  });

  it("survives getWritable() clone as an EditorRefNode (subclassing pitfall regression guard)", () => {
    // LexicalNode.getWritable() clones via `this.constructor.clone(this)`. If EditorRefNode
    // did not override `static clone()`, the inherited (upstream) implementation hardcodes
    // `new RefNode(...)` and this node would silently downgrade to the base, chip-less class
    // on the very first edit that forces a clone (setRef below).
    const editor = makeEditor();
    editor.update(
      () => {
        const node = $createEditorRefNode({ kind: "doc", targetTitle: "Before" });
        appendInline(node);
      },
      { discrete: true },
    );
    editor.update(
      () => {
        const [paragraph] = $getRoot().getChildren();
        const [node] = childrenOf(paragraph);
        const writable = (node as EditorRefNode).setRef({ kind: "doc", targetTitle: "After" });
        expect(writable).toBeInstanceOf(EditorRefNode);
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      const [paragraph] = $getRoot().getChildren();
      const [node] = childrenOf(paragraph);
      expect($isEditorRefNode(node)).toBe(true);
      expect((node as EditorRefNode).getRef().targetTitle).toBe("After");
    });
  });

  it("decorate() renders a chip using the ref export contract", () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const resolved = $createEditorRefNode({ kind: "doc", targetTitle: "Roadmap", targetId: "doc-1" });
        const unresolved = $createEditorRefNode({ kind: "doc", targetTitle: "New Page" });
        appendInline(resolved);
        appendInline(unresolved);
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      const paragraphs = $getRoot().getChildren();
      const resolved = childrenOf(paragraphs[0])[0] as EditorRefNode;
      const unresolved = childrenOf(paragraphs[1])[0] as EditorRefNode;
      const resolvedEl = resolved.decorate();
      expect(resolvedEl.type).toBe("span");
      expect(resolvedEl.props["data-mega-content-chip"]).toBe("ref");
      const unresolvedEl = unresolved.decorate();
      expect(unresolvedEl.type).toBe("span");
    });
  });
});

describe("EditorEmbedNode", () => {
  it("exports/imports as 'mega-embed' and clone preserves the subclass", () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const node = $createEditorEmbedNode({ targetDocId: "doc-1", label: "Roadmap" });
        $getRoot().append(node);
      },
      { discrete: true },
    );
    editor.update(
      () => {
        const [node] = $getRoot().getChildren();
        const writable = (node as EditorEmbedNode).setEmbed({ targetDocId: "doc-1", label: "Renamed" });
        expect(writable).toBeInstanceOf(EditorEmbedNode);
      },
      { discrete: true },
    );
    const json = JSON.stringify(editor.getEditorState().toJSON());
    expect(json).toContain('"type":"mega-embed"');
    const restored = editor.parseEditorState(json);
    restored.read(() => {
      const [node] = $getRoot().getChildren();
      expect($isEditorEmbedNode(node)).toBe(true);
      expect((node as EditorEmbedNode).getEmbed().label).toBe("Renamed");
    });
  });

  it("decorate() renders a resolved embed preview with its target block", () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const node = $createEditorEmbedNode({ targetDocId: "doc-9", targetBlockId: "block-3", label: "Block embed" });
        $getRoot().append(node);
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      const [node] = $getRoot().getChildren() as [EditorEmbedNode];
      const el = node.decorate();
      expect(el.props.value).toMatchObject({ targetDocId: "doc-9", targetBlockId: "block-3" });
    });
  });
});

describe("EditorBlockRefNode", () => {
  it("exports/imports as 'mega-block-ref' and clone preserves the subclass", () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const node = $createEditorBlockRefNode({ targetDocId: "doc-1", targetBlockId: "block-1", label: "Summary" });
        appendInline(node);
      },
      { discrete: true },
    );
    editor.update(
      () => {
        const [paragraph] = $getRoot().getChildren();
        const [node] = childrenOf(paragraph);
        const writable = (node as EditorBlockRefNode).setBlockRef({ targetDocId: "doc-1", targetBlockId: "block-1", label: "Renamed" });
        expect(writable).toBeInstanceOf(EditorBlockRefNode);
      },
      { discrete: true },
    );
    const json = JSON.stringify(editor.getEditorState().toJSON());
    const restored = editor.parseEditorState(json);
    restored.read(() => {
      const [paragraph] = $getRoot().getChildren();
      const [node] = childrenOf(paragraph);
      expect($isEditorBlockRefNode(node)).toBe(true);
      expect((node as EditorBlockRefNode).getBlockRef().label).toBe("Renamed");
    });
  });

  it("decorate() preserves resolved and forbidden status for the inline renderer", () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const ok = $createEditorBlockRefNode({ targetDocId: "doc-1", targetBlockId: "block-1", label: "OK", status: "ok" });
        const forbidden = $createEditorBlockRefNode({ targetDocId: "doc-1", targetBlockId: "block-2", label: "Nope", status: "forbidden" });
        appendInline(ok);
        appendInline(forbidden);
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      const paragraphs = $getRoot().getChildren();
      const ok = childrenOf(paragraphs[0])[0] as EditorBlockRefNode;
      const forbidden = childrenOf(paragraphs[1])[0] as EditorBlockRefNode;
      expect(ok.decorate().props.value.status).toBe("ok");
      expect(forbidden.decorate().props.value.status).toBe("forbidden");
    });
  });
});
