import { createHeadlessEditor } from "@lexical/headless";
import { $createTextNode, $getRoot } from "lexical";
import { describe, expect, it } from "vitest";
import { $createMegaBlock, $isMegaBlockNode, generateBlockId, NODES_CORE, type MegaBlockNode } from "@megaui/content";
import { EditorOutlineTableNode } from "./outline-table-node";
import {
  $applyMegaBlockMarkdownPrefix,
  $ensureRootMegaBlockTree,
  $getMegaBlockInlineText,
  $getNestedMegaBlocks,
  $getSelectedMegaBlock,
  $indentMegaBlock,
  $insertMegaCodeBlockSibling,
  $insertMegaHrBlockSibling,
  $insertMegaTableBlockSibling,
  $insertNestedMegaListItem,
  $mergeMegaBlockWithPrevious,
  $moveMegaBlockDown,
  $moveMegaBlockUp,
  $outdentMegaBlock,
  $setSelectedMegaBlockVariant,
  $selectFollowingMegaBlock,
  $splitMegaBlockAtSelection,
} from "./commands";

function makeEditor() {
  return createHeadlessEditor({
    namespace: "commands-test",
    nodes: NODES_CORE.map((node) => node.getType() === "mega-outline-table" ? EditorOutlineTableNode : node),
    onError: (error) => {
      throw error;
    },
  });
}

/** Builds root = [blockA(text), blockB(text)] and returns their ids. */
function seedTwoRootBlocks(editor: ReturnType<typeof createHeadlessEditor>, textA: string, textB: string) {
  const blockAId = generateBlockId();
  const blockBId = generateBlockId();
  editor.update(
    () => {
      const root = $getRoot();
      const blockA = $createMegaBlock("text", blockAId);
      blockA.append($createTextNode(textA));
      const blockB = $createMegaBlock("text", blockBId);
      blockB.append($createTextNode(textB));
      root.append(blockA, blockB);
    },
    { discrete: true },
  );
  return { blockAId, blockBId };
}

function selectEndOfBlock(editor: ReturnType<typeof createHeadlessEditor>, blockId: string) {
  editor.update(
    () => {
      const found = $getRoot()
        .getChildren()
        .find((node) => $isMegaBlockNode(node) && (node as MegaBlockNode).getBlockId() === blockId);
      (found as MegaBlockNode).selectEnd();
    },
    { discrete: true },
  );
}

describe("$getSelectedMegaBlock / $getMegaBlockInlineText / $getNestedMegaBlocks", () => {
  it("resolves the owning root block from a text selection and reads its inline text", () => {
    const editor = makeEditor();
    const { blockAId } = seedTwoRootBlocks(editor, "hello", "world");
    selectEndOfBlock(editor, blockAId);
    editor.update(
      () => {
        const block = $getSelectedMegaBlock();
        expect(block).not.toBeNull();
        expect(block!.getBlockId()).toBe(blockAId);
        expect($getMegaBlockInlineText(block!)).toBe("hello");
      },
      { discrete: true },
    );
  });

  it("returns null when there is no range selection", () => {
    const editor = makeEditor();
    editor.update(
      () => {
        expect($getSelectedMegaBlock()).toBeNull();
      },
      { discrete: true },
    );
  });

  it("collects direct nested MegaBlockNode children only", () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const parent = $createMegaBlock("text", generateBlockId());
        const child = $createMegaBlock("text", generateBlockId());
        parent.append($createTextNode("parent-text"), child);
        expect($getNestedMegaBlocks(parent)).toHaveLength(1);
        expect($getMegaBlockInlineText(parent)).toBe("parent-text");
      },
      { discrete: true },
    );
  });
});

describe("$selectFollowingMegaBlock", () => {
  it("creates a selected text row and reuses it after the embed macro is committed", () => {
    const editor = makeEditor();
    editor.update(() => {
      const block = $createMegaBlock("text", "media");
      $getRoot().append(block);
      const next = $selectFollowingMegaBlock(block);
      expect($getSelectedMegaBlock()?.getKey()).toBe(next.getKey());
      expect($selectFollowingMegaBlock(block).getKey()).toBe(next.getKey());
      expect($getRoot().getChildrenSize()).toBe(2);
    }, { discrete: true });
  });

  it("preserves an existing populated row and inserts a new one before it", () => {
    const editor = makeEditor();
    editor.update(() => {
      const media = $createMegaBlock("text", "media");
      const existing = $createMegaBlock("text", "existing");
      existing.append($createTextNode("Keep this"));
      $getRoot().append(media, existing);
      const next = $selectFollowingMegaBlock(media);
      expect($getRoot().getChildren().map((node) => node.getKey())).toEqual([media, next, existing].map((node) => node.getKey()));
      expect(existing.getTextContent()).toBe("Keep this");
    }, { discrete: true });
  });
});

describe("$indentMegaBlock / $outdentMegaBlock", () => {
  it("indents a block under its previous sibling and outdents it back out", () => {
    const editor = makeEditor();
    const { blockBId } = seedTwoRootBlocks(editor, "a", "b");
    selectEndOfBlock(editor, blockBId);
    editor.update(
      () => {
        const block = $getSelectedMegaBlock()!;
        expect($indentMegaBlock(block)).toBe(true);
        expect($getRoot().getChildren()).toHaveLength(1);
      },
      { discrete: true },
    );
    editor.update(
      () => {
        const root = $getRoot();
        const [onlyChild] = root.getChildren();
        const nested = $getNestedMegaBlocks(onlyChild as MegaBlockNode)[0]!;
        expect($outdentMegaBlock(nested)).toBe(true);
        expect($getRoot().getChildren()).toHaveLength(2);
      },
      { discrete: true },
    );
  });

  it("fails to indent the first root block (no previous sibling)", () => {
    const editor = makeEditor();
    const { blockAId } = seedTwoRootBlocks(editor, "a", "b");
    selectEndOfBlock(editor, blockAId);
    editor.update(
      () => {
        const block = $getSelectedMegaBlock()!;
        expect($indentMegaBlock(block)).toBe(false);
      },
      { discrete: true },
    );
  });
});

describe("$moveMegaBlockUp / $moveMegaBlockDown", () => {
  it("swaps sibling order", () => {
    const editor = makeEditor();
    const { blockBId } = seedTwoRootBlocks(editor, "a", "b");
    selectEndOfBlock(editor, blockBId);
    editor.update(
      () => {
        const block = $getSelectedMegaBlock()!;
        expect($moveMegaBlockUp(block)).toBe(true);
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      const [first] = $getRoot().getChildren();
      expect((first as MegaBlockNode).getBlockId()).toBe(blockBId);
    });
  });

  it("cannot move the last block down", () => {
    const editor = makeEditor();
    const { blockBId } = seedTwoRootBlocks(editor, "a", "b");
    selectEndOfBlock(editor, blockBId);
    editor.update(
      () => {
        const block = $getSelectedMegaBlock()!;
        expect($moveMegaBlockDown(block)).toBe(false);
      },
      { discrete: true },
    );
  });
});

describe("$splitMegaBlockAtSelection", () => {
  it("splits inline text at the collapsed selection offset into a new sibling block", () => {
    const editor = makeEditor();
    const blockId = generateBlockId();
    editor.update(
      () => {
        const block = $createMegaBlock("text", blockId);
        const text = $createTextNode("helloworld");
        block.append(text);
        $getRoot().append(block);
        text.select(5, 5);
      },
      { discrete: true },
    );
    editor.update(
      () => {
        expect($splitMegaBlockAtSelection()).toBe(true);
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(2);
      expect($getMegaBlockInlineText(children[0] as MegaBlockNode)).toBe("hello");
      expect($getMegaBlockInlineText(children[1] as MegaBlockNode)).toBe("world");
    });
  });

  it("returns false without a collapsed range selection", () => {
    const editor = makeEditor();
    editor.update(
      () => {
        expect($splitMegaBlockAtSelection()).toBe(false);
      },
      { discrete: true },
    );
  });
});

describe("$mergeMegaBlockWithPrevious", () => {
  it("merges a root block's text into its previous sibling and removes it", () => {
    const editor = makeEditor();
    const { blockAId } = seedTwoRootBlocks(editor, "hello", "world");
    editor.update(
      () => {
        const [, blockB] = $getRoot().getChildren();
        expect($mergeMegaBlockWithPrevious(blockB as MegaBlockNode)).toBe(true);
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(1);
      expect((children[0] as MegaBlockNode).getBlockId()).toBe(blockAId);
      expect($getMegaBlockInlineText(children[0] as MegaBlockNode)).toBe("helloworld");
    });
  });

  it("merges a nested block up into its parent when it has no previous sibling", () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const parent = $createMegaBlock("text", generateBlockId());
        parent.append($createTextNode("parent"));
        const child = $createMegaBlock("text", generateBlockId());
        child.append($createTextNode("child"));
        parent.append(child);
        $getRoot().append(parent);
        expect($mergeMegaBlockWithPrevious(child)).toBe(true);
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      const [only] = $getRoot().getChildren();
      expect($getMegaBlockInlineText(only as MegaBlockNode)).toBe("parentchild");
      expect($getNestedMegaBlocks(only as MegaBlockNode)).toHaveLength(0);
    });
  });

  it("returns false for the first root block (nothing to merge into)", () => {
    const editor = makeEditor();
    const { blockAId } = seedTwoRootBlocks(editor, "a", "b");
    editor.update(
      () => {
        const [blockA] = $getRoot().getChildren();
        expect((blockA as MegaBlockNode).getBlockId()).toBe(blockAId);
        expect($mergeMegaBlockWithPrevious(blockA as MegaBlockNode)).toBe(false);
      },
      { discrete: true },
    );
  });
});

describe("$setSelectedMegaBlockVariant / $insertNestedMegaListItem / sibling inserts", () => {
  it("sets the variant and clears todoChecked for non-todo variants", () => {
    const editor = makeEditor();
    const { blockAId } = seedTwoRootBlocks(editor, "a", "b");
    selectEndOfBlock(editor, blockAId);
    editor.update(
      () => {
        const block = $getSelectedMegaBlock()!;
        block.setTodoChecked(true);
        expect($setSelectedMegaBlockVariant("h1")).toBe(true);
        expect(block.getVariant()).toBe("h1");
        expect(block.getTodoChecked()).toBe(false);
      },
      { discrete: true },
    );
  });

  it("inserts a nested bullet/ordered list child under the selected block", () => {
    const editor = makeEditor();
    const { blockAId } = seedTwoRootBlocks(editor, "a", "b");
    selectEndOfBlock(editor, blockAId);
    editor.update(
      () => {
        const block = $getSelectedMegaBlock()!;
        expect($insertNestedMegaListItem("ordered")).toBe(true);
        const nested = $getNestedMegaBlocks(block);
        expect(nested).toHaveLength(1);
        expect(nested[0]!.getListKind()).toBe("ordered");
        expect($getMegaBlockInlineText(nested[0]!)).toBe("1. ");
      },
      { discrete: true },
    );
  });

  it("inserts code/table/hr sibling blocks after the selected block", () => {
    const editor = makeEditor();
    const { blockAId } = seedTwoRootBlocks(editor, "a", "b");
    selectEndOfBlock(editor, blockAId);
    editor.update(
      () => {
        expect($insertMegaCodeBlockSibling("ts")).toBe(true);
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      const children = $getRoot().getChildren();
      // [blockA, codeBlock, blockB]
      expect(children).toHaveLength(3);
      expect(children[1]!.getType()).toBe("mega-code-block");
    });

    selectEndOfBlock(editor, blockAId);
    editor.update(
      () => {
        expect($insertMegaTableBlockSibling()).toBe(true);
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      const types = $getRoot()
        .getChildren()
        .map((n) => n.getType());
      expect(types).toContain("mega-outline-table");
      expect(types).toContain("mega-block");
    });

    selectEndOfBlock(editor, blockAId);
    editor.update(
      () => {
        expect($insertMegaHrBlockSibling()).toBe(true);
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      const types = $getRoot()
        .getChildren()
        .map((n) => n.getType());
      expect(types).toContain("mega-hr-block");
    });
  });

  it("returns false for all setters/inserters when nothing is selected", () => {
    const editor = makeEditor();
    editor.update(
      () => {
        expect($setSelectedMegaBlockVariant("quote")).toBe(false);
        expect($insertNestedMegaListItem()).toBe(false);
        expect($insertMegaCodeBlockSibling()).toBe(false);
        expect($insertMegaTableBlockSibling()).toBe(false);
        expect($insertMegaHrBlockSibling()).toBe(false);
      },
      { discrete: true },
    );
  });
});

describe("$ensureRootMegaBlockTree", () => {
  it("seeds a text block when the root is empty", () => {
    const editor = makeEditor();
    editor.update(
      () => {
        $ensureRootMegaBlockTree();
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(1);
      expect($isMegaBlockNode(children[0])).toBe(true);
    });
  });

  it("is a no-op when the root already has children", () => {
    const editor = makeEditor();
    seedTwoRootBlocks(editor, "a", "b");
    editor.update(
      () => {
        $ensureRootMegaBlockTree();
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      expect($getRoot().getChildren()).toHaveLength(2);
    });
  });
});

describe("$applyMegaBlockMarkdownPrefix", () => {
  const cases: Array<{ input: string; variant: string; strippedText: string; todoChecked?: boolean }> = [
    { input: "# ", variant: "h1", strippedText: "" },
    { input: "## Title", variant: "h2", strippedText: "Title" },
    { input: "### Title", variant: "h3", strippedText: "Title" },
    { input: "> Quote", variant: "quote", strippedText: "Quote" },
    { input: "- [ ] todo", variant: "todo", strippedText: "todo", todoChecked: false },
    { input: "- [x] done", variant: "todo", strippedText: "done", todoChecked: true },
  ];

  for (const testCase of cases) {
    it(`applies "${testCase.input}" as a ${testCase.variant} block`, () => {
      const editor = makeEditor();
      const blockId = generateBlockId();
      editor.update(
        () => {
          const block = $createMegaBlock("text", blockId);
          block.append($createTextNode(testCase.input));
          $getRoot().append(block);
          block.selectEnd();
        },
        { discrete: true },
      );
      editor.update(
        () => {
          expect($applyMegaBlockMarkdownPrefix(false)).toBe(true);
        },
        { discrete: true },
      );
      editor.getEditorState().read(() => {
        const [block] = $getRoot().getChildren();
        expect((block as MegaBlockNode).getVariant()).toBe(testCase.variant);
        expect($getMegaBlockInlineText(block as MegaBlockNode)).toBe(testCase.strippedText);
        if (testCase.todoChecked !== undefined) {
          expect((block as MegaBlockNode).getTodoChecked()).toBe(testCase.todoChecked);
        }
      });
    });
  }

  it("handles the pending-space variant (KEY_SPACE_COMMAND, before the space lands)", () => {
    const editor = makeEditor();
    const blockId = generateBlockId();
    editor.update(
      () => {
        const block = $createMegaBlock("text", blockId);
        block.append($createTextNode("#"));
        $getRoot().append(block);
        block.selectEnd();
      },
      { discrete: true },
    );
    editor.update(
      () => {
        expect($applyMegaBlockMarkdownPrefix(true)).toBe(true);
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      const [block] = $getRoot().getChildren();
      expect((block as MegaBlockNode).getVariant()).toBe("h1");
      expect($getMegaBlockInlineText(block as MegaBlockNode)).toBe("");
    });
  });

  it("returns false for plain text with no markdown prefix", () => {
    const editor = makeEditor();
    const blockId = generateBlockId();
    editor.update(
      () => {
        const block = $createMegaBlock("text", blockId);
        block.append($createTextNode("just text"));
        $getRoot().append(block);
        block.selectEnd();
      },
      { discrete: true },
    );
    editor.update(
      () => {
        expect($applyMegaBlockMarkdownPrefix(false)).toBe(false);
      },
      { discrete: true },
    );
  });

  it("returns false when nothing is selected", () => {
    const editor = makeEditor();
    editor.update(
      () => {
        expect($applyMegaBlockMarkdownPrefix(false)).toBe(false);
      },
      { discrete: true },
    );
  });
});
