import { describe, expect, it } from "vitest";

import type { TreeNode } from "@megaui/core";

import { ancestorPaths, findNode, mergeTreeNodes, pathPrefixes, toFileTreeNodes } from "./code-path-tree";

const TREE: readonly TreeNode[] = [
  {
    kind: "directory",
    name: "src",
    path: "src",
  },
  {
    kind: "file",
    name: "README.md",
    path: "README.md",
  },
];

describe("code path tree model", () => {
  it("merges lazy children while retaining navigable ancestor paths", () => {
    // Given: the root tree and a lazily fetched child directory.
    const children = new Map<string, readonly TreeNode[]>([
      ["src", [{ kind: "file", name: "index.ts", path: "src/index.ts" }]],
    ]);

    // When: the route builds its merged navigation tree for a nested file.
    const merged = mergeTreeNodes(TREE, children);

    // Then: tree lookups, display conversion, and directory ancestry agree.
    expect(ancestorPaths("src/index.ts")).toEqual(["src"]);
    expect(pathPrefixes("src")).toEqual(["src"]);
    expect(pathPrefixes("src/index.ts")).toEqual(["src", "src/index.ts"]);
    expect(findNode(merged, "src/index.ts")?.name).toBe("index.ts");
    expect(toFileTreeNodes(merged)[0]?.children?.[0]?.path).toBe("src/index.ts");
  });
});
