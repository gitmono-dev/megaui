import { describe, expect, it } from "vitest";
import { contentPresetIncludesNode, getContentPresetConfig, getContentPresetNodeTypes } from "./preset";

describe("document preset", () => {
  it("registers the full mega block vocabulary plus all three chip node kinds", () => {
    const types = getContentPresetNodeTypes("document");
    expect(types).toEqual(
      [
        "code",
        "code-highlight",
        "mega-block",
        "mega-block-ref",
        "mega-code-block",
        "mega-embed",
        "mega-hr-block",
        "mega-image",
        "mega-outline-table",
        "mega-ref",
        "mega-roam-macro",
        "mega-table-block",
        "link",
        "autolink",
        "table",
        "tablecell",
        "tablerow",
      ].sort(),
    );
  });

  it("enables table/hr/nested-block and external links", () => {
    const config = getContentPresetConfig("document");
    expect(config.features).toMatchObject({
      blockStructure: true,
      tableBlocks: true,
      hrBlocks: true,
      nestedBlocks: true,
      markdownShortcuts: true,
      chatSendOnModEnter: false,
      links: true,
    });
  });
});

describe("comment preset", () => {
  it("registers MegaBlockNode + MegaCodeBlockNode + both ref chip kinds + LinkNode only (no embed, no CodeNode)", () => {
    const types = getContentPresetNodeTypes("comment");
    expect(types).toEqual(["link", "mega-block", "mega-block-ref", "mega-code-block", "mega-ref", "mega-roam-macro"].sort());
    expect(contentPresetIncludesNode("comment", "mega-embed")).toBe(false);
    expect(contentPresetIncludesNode("comment", "code")).toBe(false);
  });

  it("disables table/hr and chat-send-on-enter; enables links", () => {
    const config = getContentPresetConfig("comment");
    expect(config.features).toMatchObject({
      tableBlocks: false,
      hrBlocks: false,
      chatSendOnModEnter: false,
      links: true,
    });
  });
});

describe("chat preset", () => {
  it("shares comment's node set but disables nested blocks and enables send-on-mod-enter", () => {
    expect(getContentPresetNodeTypes("chat")).toEqual(getContentPresetNodeTypes("comment"));
    const config = getContentPresetConfig("chat");
    expect(config.features.nestedBlocks).toBe(false);
    expect(config.features.chatSendOnModEnter).toBe(true);
  });
});

describe("createEmptyStateJSON", () => {
  it("is the same seed function across all three presets and produces a single empty text block", () => {
    for (const preset of ["document", "comment", "chat"] as const) {
      const json = JSON.parse(getContentPresetConfig(preset).createEmptyStateJSON());
      expect(json.root.children).toHaveLength(1);
      expect(json.root.children[0].type).toBe("mega-block");
      expect(json.root.children[0].variant).toBe("text");
    }
  });
});
