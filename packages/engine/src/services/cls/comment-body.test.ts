import { describe, expect, it } from "vitest";
import {
  importPlainText,
  isEmptyCommentBody,
  normalizeCommentBodyJson,
  plainTextFromCommentBody,
} from "./comment-body";

interface LexicalBlock {
  type: string;
  children: Array<{ type: string; text?: string; ref?: { kind: string; targetId?: string; targetTitle: string } }>;
}

function parse(bodyJson: string): { root: { children: LexicalBlock[] } } {
  return JSON.parse(bodyJson) as { root: { children: LexicalBlock[] } };
}

describe("importPlainText", () => {
  it("produces one empty mega-block for an empty string", () => {
    const { root } = parse(importPlainText(""));
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toMatchObject({ type: "mega-block", variant: "text", children: [] });
  });

  it("splits multi-line text into one mega-block per line", () => {
    const { root } = parse(importPlainText("first line\nsecond line"));
    expect(root.children).toHaveLength(2);
    expect(root.children[0]?.children).toEqual([
      { detail: 0, format: 0, mode: "normal", style: "", text: "first line", type: "text", version: 1 },
    ]);
    expect(root.children[1]?.children[0]).toMatchObject({ text: "second line" });
  });

  it("promotes !N / #N / @user tokens to mega-ref nodes", () => {
    const { root } = parse(importPlainText("See !42, !9ab0CD0345xy, !9ab_CD-345xy, !9ab_CD_345xy and #7, ping @octocat"));
    const inline = root.children[0]?.children ?? [];
    const refs = inline.filter((node) => node.type === "mega-ref");
    expect(refs).toEqual([
      { type: "mega-ref", version: 1, ref: { kind: "cl", targetId: "42", targetTitle: "!42" } },
      { type: "mega-ref", version: 1, ref: { kind: "cl", targetId: "9ab0CD0345xy", targetTitle: "!9ab0CD0345xy" } },
      { type: "mega-ref", version: 1, ref: { kind: "cl", targetId: "9ab_CD-345xy", targetTitle: "!9ab_CD-345xy" } },
      { type: "mega-ref", version: 1, ref: { kind: "cl", targetId: "9ab_CD_345xy", targetTitle: "!9ab_CD_345xy" } },
      { type: "mega-ref", version: 1, ref: { kind: "issue", targetId: "7", targetTitle: "#7" } },
      { type: "mega-ref", version: 1, ref: { kind: "user", targetId: "octocat", targetTitle: "@octocat" } },
    ]);
  });
});

describe("normalizeCommentBodyJson", () => {
  it("normalizes null/undefined/blank to an empty editor state", () => {
    for (const input of [null, undefined, "", "   "]) {
      const { root } = parse(normalizeCommentBodyJson(input));
      expect(root.children).toHaveLength(1);
      expect(root.children[0]?.children).toEqual([]);
    }
  });

  it("imports a plain-text string as line-based mega-blocks", () => {
    const { root } = parse(normalizeCommentBodyJson("hello world"));
    expect(root.children[0]?.children[0]).toMatchObject({ text: "hello world" });
  });

  it("keeps JSON-looking primitive strings as plain text (not empty docs)", () => {
    for (const input of ["123", "true", "null", "false"]) {
      const { root } = parse(normalizeCommentBodyJson(input));
      expect(root.children[0]?.children[0]).toMatchObject({ text: input });
    }
  });

  it("passes an already-Lexical `{ root }` payload through unchanged (as JSON, as an object, or as a string)", () => {
    const lexical = { root: { children: [{ type: "mega-block", children: [] }] } };
    expect(JSON.parse(normalizeCommentBodyJson(lexical))).toEqual(lexical);
    expect(JSON.parse(normalizeCommentBodyJson(JSON.stringify(lexical)))).toEqual(lexical);
  });

  it("imports a `{ text }` envelope (legacy shape) via importPlainText", () => {
    const { root } = parse(normalizeCommentBodyJson({ text: "legacy note" }));
    expect(root.children[0]?.children[0]).toMatchObject({ text: "legacy note" });
  });

  it("falls back to an empty state for arrays and other non-object payloads", () => {
    for (const input of [[], 42, true]) {
      const { root } = parse(normalizeCommentBodyJson(input));
      expect(root.children).toHaveLength(1);
      expect(root.children[0]?.children).toEqual([]);
    }
  });

  it("falls back to importPlainText for a non-JSON, non-empty string", () => {
    const { root } = parse(normalizeCommentBodyJson("not json at all"));
    expect(root.children[0]?.children[0]).toMatchObject({ text: "not json at all" });
  });
});

describe("isEmptyCommentBody", () => {
  it("treats a body with zero root children as empty", () => {
    expect(isEmptyCommentBody(JSON.stringify({ root: { children: [] } }))).toBe(true);
  });

  it("treats whitespace-only text as empty", () => {
    expect(isEmptyCommentBody(importPlainText("   \n  "))).toBe(true);
  });

  it("treats a body containing only a mega-ref (no plain text) as non-empty", () => {
    const body = JSON.stringify({
      root: { children: [{ type: "mega-block", children: [{ type: "mega-ref", ref: { targetTitle: "!42" } }] }] },
    });
    expect(isEmptyCommentBody(body)).toBe(false);
  });

  it("treats real text content as non-empty", () => {
    expect(isEmptyCommentBody(importPlainText("hi"))).toBe(false);
  });

  it("falls back to raw-string emptiness for unparseable JSON", () => {
    expect(isEmptyCommentBody("not json")).toBe(false);
    expect(isEmptyCommentBody("   ")).toBe(true);
  });
});

describe("plainTextFromCommentBody", () => {
  it("flattens text nodes and mega-ref titles into one string", () => {
    const body = normalizeCommentBodyJson("hello !42");
    expect(plainTextFromCommentBody(body)).toBe("hello !42");
  });

  it("falls back to the trimmed raw string for unparseable JSON", () => {
    expect(plainTextFromCommentBody("  raw text  ")).toBe("raw text");
  });
});
