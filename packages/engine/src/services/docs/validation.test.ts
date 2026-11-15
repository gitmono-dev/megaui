import { describe, expect, it } from "vitest";
import { createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import { MegaBadRequestError } from "../../errors";
import {
  MAX_DOC_BODY_BYTES,
  MAX_DOC_SUMMARY_LENGTH,
  MAX_DOC_TITLE_LENGTH,
  validateDocBodyJson,
  validateDocSummary,
  validateDocTitle,
} from "./validation";

function megaBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "mega-block",
    blockId: "blk_1_______",
    variant: "text",
    collapsed: false,
    todoChecked: false,
    children: [],
    ...overrides,
  };
}

function editorState(children: unknown[]): string {
  return JSON.stringify({ root: { type: "root", children } });
}

describe("validateDocBodyJson (GC-11)", () => {
  it("validates persisted block-reference binding modes", () => {
    const body = (binding: unknown) => editorState([megaBlock({ children: [{
      type: "mega-block-ref", blockRef: { targetDocId: "doc_x", targetBlockId: "BlockRef0001", label: "Source", binding },
    }] })]);
    for (const binding of [undefined, "document", "search"]) expect(() => validateDocBodyJson(body(binding))).not.toThrow();
    for (const binding of [true, null, "unknown"]) expect(() => validateDocBodyJson(body(binding))).toThrow(MegaBadRequestError);
  });

  it.each(["573ddfe6-ee19-4015-89dd-558f7a5e44db", "short", "abcdefghijklM", "abcdef!hijkl"])("rejects non-12-character block identity %s", (blockId) => {
    expect(() => validateDocBodyJson(editorState([megaBlock({ blockId })]))).toThrow(MegaBadRequestError);
  });

  it.each(["mega-block-ref", "mega-embed", "mega-outline-table"])("rejects a UUID target in %s", (type) => {
    const targetBlockId = "573ddfe6-ee19-4015-89dd-558f7a5e44db";
    const node = type === "mega-outline-table"
      ? { type, blockId: "TableView001", sourceBlockId: targetBlockId }
      : type === "mega-embed" ? { type, embed: { targetDocId: "doc_x", targetBlockId } }
        : { type, blockRef: { targetDocId: "doc_x", targetBlockId, label: "source" } };
    const children = type === "mega-outline-table" ? [node] : [megaBlock({ blockId: "ValidBlock01", children: [node] })];
    expect(() => validateDocBodyJson(editorState(children))).toThrow(MegaBadRequestError);
  });

  it("accepts a well-formed empty document", () => {
    expect(() => validateDocBodyJson(createEmptyMegaDocumentEditorStateJSON())).not.toThrow();
  });

  it("accepts nested mega-block/mega-code-block/mega-table-block/mega-hr-block trees", () => {
    const body = editorState([
      megaBlock({
        children: [
          { type: "mega-code-block", blockId: "blk_code____", language: "ts", children: [] },
          { type: "mega-table-block", blockId: "blk_table___", children: [] },
          { type: "mega-hr-block", blockId: "blk_hr______", children: [] },
        ],
      }),
    ]);
    expect(() => validateDocBodyJson(body)).not.toThrow();
  });

  it("accepts an outline-backed table and rejects a missing source id", () => {
    const source = megaBlock({ blockId: "table-source", tableSource: true, children: [megaBlock({ blockId: "row-1_______" })] });
    expect(() => validateDocBodyJson(editorState([{ type: "mega-outline-table", blockId: "table-view__", sourceBlockId: "table-source" }, source]))).not.toThrow();
    expect(() => validateDocBodyJson(editorState([{ type: "mega-outline-table", blockId: "table-view__" }, source]))).toThrow(MegaBadRequestError);
    expect(() => validateDocBodyJson(editorState([megaBlock({ tableSource: "yes" })]))).toThrow(MegaBadRequestError);
  });

  it("accepts a resolved mega-ref, mega-embed, and mega-block-ref", () => {
    const body = editorState([
      megaBlock({
        children: [
          { type: "mega-ref", ref: { kind: "doc", targetTitle: "Other doc", targetId: "doc_x" } },
          { type: "mega-embed", embed: { targetDocId: "doc_x" } },
          {
            type: "mega-block-ref",
            blockRef: { targetDocId: "doc_x", targetBlockId: "blk_y_______", label: "Other block" },
          },
        ],
      }),
    ]);
    expect(() => validateDocBodyJson(body)).not.toThrow();
  });

  it("accepts HTTP(S) images and rejects executable or malformed URLs", () => {
    const withImage = (src: string) => editorState([megaBlock({ children: [{ type: "mega-image", image: { src, alt: "Chart" } }] })]);
    expect(() => validateDocBodyJson(withImage("https://example.com/chart.png"))).not.toThrow();
    expect(() => validateDocBodyJson(withImage("javascript:alert(1)"))).toThrow(MegaBadRequestError);
    expect(() => validateDocBodyJson(withImage("https://user:password@example.com/chart.png"))).toThrow(MegaBadRequestError);
    expect(() => validateDocBodyJson(withImage("/relative.png"))).toThrow(MegaBadRequestError);
  });

  it("allows safe document links and rejects script links on save", () => {
    const withLink = (url: string) => editorState([megaBlock({ children: [{ type: "link", url, children: [{ type: "text", text: "site" }] }] })]);
    expect(() => validateDocBodyJson(withLink("https://example.com/article"))).not.toThrow();
    expect(() => validateDocBodyJson(withLink("mailto:team@example.com"))).not.toThrow();
    expect(() => validateDocBodyJson(withLink("javascript:alert(1)"))).toThrow(MegaBadRequestError);
  });

  it("rejects bodies exceeding MAX_DOC_BODY_BYTES", () => {
    const oversized = editorState([megaBlock({ variant: "text", huge: "x".repeat(MAX_DOC_BODY_BYTES) })]);
    expect(oversized.length).toBeGreaterThan(MAX_DOC_BODY_BYTES);
    expect(() => validateDocBodyJson(oversized)).toThrow(MegaBadRequestError);
  });

  it("rejects invalid JSON", () => {
    expect(() => validateDocBodyJson("{not json")).toThrow(MegaBadRequestError);
  });

  it("rejects a body without a root node", () => {
    expect(() => validateDocBodyJson(JSON.stringify({ notRoot: true }))).toThrow(MegaBadRequestError);
  });

  it("rejects a root node with the wrong type tag", () => {
    expect(() => validateDocBodyJson(JSON.stringify({ root: { type: "not-root", children: [] } }))).toThrow(
      MegaBadRequestError,
    );
  });

  it("rejects mega-block nodes missing a blockId", () => {
    const body = editorState([megaBlock({ blockId: "" })]);
    expect(() => validateDocBodyJson(body)).toThrow(MegaBadRequestError);
  });

  it("rejects mega-block nodes with an illegal variant", () => {
    const body = editorState([megaBlock({ variant: "not-a-real-variant" })]);
    expect(() => validateDocBodyJson(body)).toThrow(MegaBadRequestError);
  });

  it("rejects mega-block nodes with an illegal listKind", () => {
    const body = editorState([megaBlock({ listKind: "roman-numeral" })]);
    expect(() => validateDocBodyJson(body)).toThrow(MegaBadRequestError);
  });

  it("rejects leaf containers missing a blockId", () => {
    const body = editorState([{ type: "mega-code-block", blockId: "", children: [] }]);
    expect(() => validateDocBodyJson(body)).toThrow(MegaBadRequestError);
  });

  it("rejects an empty root (editor requires at least one mega-block)", () => {
    expect(() => validateDocBodyJson(JSON.stringify({ root: { type: "root", children: [] } }))).toThrow(
      MegaBadRequestError,
    );
  });

  it("rejects nesting a mega-block inside a leaf container (GC-11)", () => {
    const body = editorState([
      {
        type: "mega-code-block",
        blockId: "blk_code____",
        language: "ts",
        children: [megaBlock({ blockId: "blk_nested__" })],
      },
    ]);
    expect(() => validateDocBodyJson(body)).toThrow(MegaBadRequestError);
  });

  function withRef(ref: Record<string, unknown>): string {
    return editorState([megaBlock({ blockId: "blk_ref_host", children: [{ type: "mega-ref", ref }] })]);
  }

  function withEmbed(embed: Record<string, unknown>): string {
    return editorState([megaBlock({ blockId: "75a5fa03a2b5", children: [{ type: "mega-embed", embed }] })]);
  }

  it("rejects a mega-ref with kind=block (use mega-block-ref instead)", () => {
    const body = withRef({ kind: "block", targetTitle: "a block", targetId: "blk_1_______" });
    expect(() => validateDocBodyJson(body)).toThrow(MegaBadRequestError);
  });

  it("rejects a mega-embed targetBlockId that is a truthy non-string", () => {
    expect(() => validateDocBodyJson(withEmbed({ targetDocId: "doc_x", targetBlockId: 123 }))).toThrow(
      MegaBadRequestError,
    );
  });

  it("rejects an unresolved-shape mega-ref (missing targetTitle)", () => {
    const body = withRef({ kind: "doc" });
    expect(() => validateDocBodyJson(body)).toThrow(MegaBadRequestError);
  });

  it("rejects a mega-ref with an unknown kind", () => {
    const body = withRef({ kind: "not-a-kind", targetTitle: "x" });
    expect(() => validateDocBodyJson(body)).toThrow(MegaBadRequestError);
  });

  it("rejects a mega-embed missing targetDocId", () => {
    const body = withEmbed({});
    expect(() => validateDocBodyJson(body)).toThrow(MegaBadRequestError);
  });

  it("rejects a mega-block-ref missing targetBlockId", () => {
    const body = editorState([{ type: "mega-block-ref", blockRef: { targetDocId: "doc_x", label: "x" } }]);
    expect(() => validateDocBodyJson(body)).toThrow(MegaBadRequestError);
  });

  it("rejects children that are not an array", () => {
    const body = JSON.stringify({ root: { type: "root", children: {} } });
    expect(() => validateDocBodyJson(body)).toThrow(MegaBadRequestError);
  });

  it("rejects non-object children (null/scalar/array) instead of silently skipping them (GC-11 P1)", () => {
    expect(() => validateDocBodyJson(editorState([null]))).toThrow(MegaBadRequestError);
    expect(() => validateDocBodyJson(editorState(["a scalar string"]))).toThrow(MegaBadRequestError);
    expect(() => validateDocBodyJson(editorState([42]))).toThrow(MegaBadRequestError);
    expect(() => validateDocBodyJson(editorState([[]]))).toThrow(MegaBadRequestError);
  });

  it("rejects duplicate blockIds anywhere in the tree (GC-11 P1)", () => {
    const siblings = editorState([megaBlock({ blockId: "blk_dup_____" }), megaBlock({ blockId: "blk_dup_____" })]);
    expect(() => validateDocBodyJson(siblings)).toThrow(MegaBadRequestError);

    const nested = editorState([
      megaBlock({
        blockId: "blk_outer___",
        children: [{ type: "mega-code-block", blockId: "blk_outer___", children: [] }],
      }),
    ]);
    expect(() => validateDocBodyJson(nested)).toThrow(MegaBadRequestError);

    const acrossVariants = editorState([
      megaBlock({ blockId: "blk_shared__" }),
      { type: "mega-hr-block", blockId: "blk_shared__", children: [] },
    ]);
    expect(() => validateDocBodyJson(acrossVariants)).toThrow(MegaBadRequestError);
  });

  it("accepts distinct blockIds across sibling and nested blocks", () => {
    const body = editorState([
      megaBlock({ blockId: "blk_a_______" }),
      megaBlock({ blockId: "blk_b_______", children: [{ type: "mega-code-block", blockId: "blk_c_______", children: [] }] }),
    ]);
    expect(() => validateDocBodyJson(body)).not.toThrow();
  });

  it("rejects a mega-ref targetId that is a truthy non-string", () => {
    expect(() => validateDocBodyJson(withRef({ kind: "doc", targetTitle: "x", targetId: 123 }))).toThrow(
      MegaBadRequestError,
    );
    expect(() => validateDocBodyJson(withRef({ kind: "doc", targetTitle: "x", targetId: { id: "x" } }))).toThrow(
      MegaBadRequestError,
    );
    expect(() => validateDocBodyJson(withRef({ kind: "doc", targetTitle: "x", targetId: true }))).toThrow(
      MegaBadRequestError,
    );
  });

  it("accepts a mega-ref targetId that is omitted, empty, or a non-empty string", () => {
    expect(() => validateDocBodyJson(withRef({ kind: "doc", targetTitle: "x" }))).not.toThrow();
    expect(() => validateDocBodyJson(withRef({ kind: "doc", targetTitle: "x", targetId: "" }))).not.toThrow();
    expect(() => validateDocBodyJson(withRef({ kind: "doc", targetTitle: "x", targetId: "doc_x" }))).not.toThrow();
  });

  it("rejects trees deeper than the nesting ceiling", () => {
    let node: Record<string, unknown> = { type: "text" };
    for (let depth = 0; depth < 100; depth += 1) {
      node = { type: "mega-block", blockId: `blk_${depth}`.padEnd(12, "_"), variant: "text", children: [node] };
    }
    expect(() => validateDocBodyJson(editorState([node]))).toThrow(MegaBadRequestError);
  });
});

describe("validateDocTitle / validateDocSummary (GC-11)", () => {
  it("rejects blank titles", () => {
    expect(() => validateDocTitle("   ")).toThrow(MegaBadRequestError);
  });

  it("rejects titles over the length ceiling", () => {
    expect(() => validateDocTitle("x".repeat(MAX_DOC_TITLE_LENGTH + 1))).toThrow(MegaBadRequestError);
  });

  it("accepts a normal title", () => {
    expect(() => validateDocTitle("Architecture overview")).not.toThrow();
  });

  it("rejects blank summaries", () => {
    expect(() => validateDocSummary("  ")).toThrow(MegaBadRequestError);
  });

  it("rejects summaries over the length ceiling", () => {
    expect(() => validateDocSummary("x".repeat(MAX_DOC_SUMMARY_LENGTH + 1))).toThrow(MegaBadRequestError);
  });
});
