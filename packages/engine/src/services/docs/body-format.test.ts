import { describe, expect, it } from "vitest";
import { createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import {
  BODY_FORMAT_VERSION_BLOCK_TREE,
  normalizeDocBodyJson,
} from "./body-format";

describe("normalizeDocBodyJson", () => {
  it("returns the empty mega-block tree for empty or invalid JSON", () => {
    const empty = normalizeDocBodyJson(JSON.stringify({ root: { children: [] } }));
    expect(empty.migrated).toBe(true);
    expect(empty.bodyFormatVersion).toBe(BODY_FORMAT_VERSION_BLOCK_TREE);
    expect(JSON.parse(empty.editorStateJSON).root.children[0]?.type).toBe("mega-block");

    const invalid = normalizeDocBodyJson("not-json");
    expect(invalid.migrated).toBe(true);
    expect(JSON.parse(invalid.editorStateJSON).root.children[0]?.type).toBe("mega-block");
  });

  it("passes through an already block-tree body without marking migrated", () => {
    const source = createEmptyMegaDocumentEditorStateJSON();
    const result = normalizeDocBodyJson(source);
    expect(result).toEqual({
      editorStateJSON: source,
      bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
      migrated: false,
    });
  });

  it("collapses legacy flat paragraph trees into a text mega-block", () => {
    const legacy = JSON.stringify({
      root: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", text: "Hello legacy" }],
          },
        ],
      },
    });
    const result = normalizeDocBodyJson(legacy);
    expect(result.migrated).toBe(true);
    expect(result.bodyFormatVersion).toBe(BODY_FORMAT_VERSION_BLOCK_TREE);
    const parsed = JSON.parse(result.editorStateJSON) as {
      root: { children: Array<{ type: string; children?: Array<{ text?: string }> }> };
    };
    const block = parsed.root.children[0];
    expect(block?.type).toBe("mega-block");
    expect(block?.children?.[0]?.text).toBe("Hello legacy");
  });
});

describe("prepareWritableDocBody", () => {
  it("rejects malformed envelopes instead of silently upgrading them to empty docs", async () => {
    const { prepareWritableDocBody } = await import("./body-format");
    const { MegaBadRequestError } = await import("../../errors");
    expect(() => prepareWritableDocBody(JSON.stringify({ notRoot: true }))).toThrow(MegaBadRequestError);
    expect(() => prepareWritableDocBody(JSON.stringify({ root: { type: "root", children: "nope" } }))).toThrow(
      MegaBadRequestError,
    );
    expect(() => prepareWritableDocBody(JSON.stringify({ root: null }))).toThrow(MegaBadRequestError);
    expect(() => prepareWritableDocBody(JSON.stringify({ root: { type: "root", children: [null] } }))).toThrow(
      MegaBadRequestError,
    );
    expect(() => prepareWritableDocBody(JSON.stringify({ root: { type: "root", children: ["scalar"] } }))).toThrow(
      MegaBadRequestError,
    );
  });

  it("upgrades an empty root.children array to a real empty mega-block", async () => {
    const { prepareWritableDocBody } = await import("./body-format");
    const prepared = prepareWritableDocBody(JSON.stringify({ root: { type: "root", children: [] } }));
    expect(JSON.parse(prepared).root.children[0]?.type).toBe("mega-block");
  });
});
