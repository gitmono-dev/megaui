import { describe, expect, it } from "vitest";
import { normalizeCLDescriptionJson, plainSummaryFromDescription } from "./description";

describe("normalizeCLDescriptionJson", () => {
  it("normalizes null/undefined/blank to an empty editor state", () => {
    for (const input of [null, undefined, "", "   "]) {
      const parsed = JSON.parse(normalizeCLDescriptionJson(input)) as { root: { children: unknown[] } };
      expect(parsed.root.children).toHaveLength(1);
    }
  });

  it("imports a plain-text string as line-based mega-blocks", () => {
    const parsed = JSON.parse(normalizeCLDescriptionJson("Fixes the flaky retry loop.")) as {
      root: { children: Array<{ children: Array<{ text?: string }> }> };
    };
    expect(parsed.root.children[0]?.children[0]).toMatchObject({ text: "Fixes the flaky retry loop." });
  });

  it("passes an already-Lexical `{ root }` payload through unchanged, whether object or JSON string", () => {
    const lexical = { root: { children: [{ type: "mega-block", children: [] }] } };
    expect(JSON.parse(normalizeCLDescriptionJson(lexical))).toEqual(lexical);
    expect(JSON.parse(normalizeCLDescriptionJson(JSON.stringify(lexical)))).toEqual(lexical);
  });

  it("imports a `{ text }` legacy envelope via the plain-text path", () => {
    const parsed = JSON.parse(normalizeCLDescriptionJson({ text: "legacy description" })) as {
      root: { children: Array<{ children: Array<{ text?: string }> }> };
    };
    expect(parsed.root.children[0]?.children[0]).toMatchObject({ text: "legacy description" });
  });

  it("falls back to an empty state for a `{ text }` envelope with blank text, and for non-object payloads", () => {
    const blankText = JSON.parse(normalizeCLDescriptionJson({ text: "   " })) as { root: { children: unknown[] } };
    expect(blankText.root.children).toHaveLength(1);

    for (const input of [[], 42, true]) {
      const parsed = JSON.parse(normalizeCLDescriptionJson(input)) as { root: { children: unknown[] } };
      expect(parsed.root.children).toHaveLength(1);
    }
  });

  it("falls back to plain-text import for a non-JSON string", () => {
    const parsed = JSON.parse(normalizeCLDescriptionJson("not json at all")) as {
      root: { children: Array<{ children: Array<{ text?: string }> }> };
    };
    expect(parsed.root.children[0]?.children[0]).toMatchObject({ text: "not json at all" });
  });
});

describe("plainSummaryFromDescription", () => {
  it("returns undefined for null/undefined/non-object input", () => {
    expect(plainSummaryFromDescription(null)).toBeUndefined();
    expect(plainSummaryFromDescription(undefined)).toBeUndefined();
    expect(plainSummaryFromDescription("string")).toBeUndefined();
    expect(plainSummaryFromDescription([])).toBeUndefined();
  });

  it("returns the legacy `text` field verbatim when present", () => {
    expect(plainSummaryFromDescription({ text: "  legacy summary  " })).toBe("  legacy summary  ");
  });

  it("walks a Lexical root, joining text nodes and mega-ref titles, collapsing whitespace", () => {
    const envelope = {
      root: {
        children: [
          { type: "mega-block", children: [{ type: "text", text: "See  " }, { type: "mega-ref", ref: { targetTitle: "!42" } }] },
        ],
      },
    };
    expect(plainSummaryFromDescription(envelope)).toBe("See !42");
  });

  it("returns undefined for an envelope with no extractable text", () => {
    expect(plainSummaryFromDescription({ root: { children: [{ type: "mega-block", children: [] }] } })).toBeUndefined();
    expect(plainSummaryFromDescription({})).toBeUndefined();
  });
});
