import { describe, expect, it } from "vitest";

import { bodyHasVisibleContent, bodyPlainText, readingMinutes, tocFromBody } from "./doc-outline";

function lexicalWith(nodes: unknown[]): string {
  return JSON.stringify({
    root: {
      type: "root",
      children: nodes,
    },
  });
}

describe("doc-outline", () => {
  it("reads mega-block headings in document order", () => {
    const body = lexicalWith([
      {
        type: "mega-block",
        variant: "h1",
        children: [{ type: "text", text: " Architecture " }],
      },
      {
        type: "mega-block",
        variant: "text",
        children: [{ type: "text", text: "intro" }],
      },
      {
        type: "mega-block",
        variant: "h2",
        children: [{ type: "text", text: "Storage" }],
      },
    ]);

    expect(tocFromBody(body)).toEqual([
      { index: 0, level: 1, text: "Architecture" },
      { index: 1, level: 2, text: "Storage" },
    ]);
  });

  it("reads native Lexical heading nodes", () => {
    const body = lexicalWith([
      {
        type: "heading",
        tag: "h3",
        children: [{ type: "text", text: "Notes" }],
      },
    ]);

    expect(tocFromBody(body)).toEqual([{ index: 0, level: 3, text: "Notes" }]);
  });

  it("treats empty or invalid bodies as empty text and 1-minute reads", () => {
    expect(tocFromBody("not-json")).toEqual([]);
    expect(bodyPlainText("{}")).toBe("");
    expect(bodyPlainText("nope")).toBe("");
    expect(readingMinutes("nope")).toBe(1);
    expect(readingMinutes(lexicalWith([{ type: "text", text: "abcd" }]))).toBe(1);
  });

  it("does not show the blank hint for an image-only or TODO document", () => {
    expect(bodyHasVisibleContent(lexicalWith([{ type: "mega-block", variant: "text", children: [] }]))).toBe(false);
    expect(bodyHasVisibleContent(lexicalWith([{ type: "mega-block", variant: "text", children: [{ type: "mega-image", image: { src: "https://example.com/p.png", alt: "" } }] }]))).toBe(true);
    expect(bodyHasVisibleContent(lexicalWith([{ type: "mega-block", variant: "todo", children: [] }]))).toBe(true);
  });
});
