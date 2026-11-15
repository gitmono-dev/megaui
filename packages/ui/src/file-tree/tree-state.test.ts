import { describe, expect, it } from "vitest"

import { defaultExpandedPaths, findRowIndex, flattenTree, toggleExpanded, treeKeyboardAction } from "./tree-state"
import type { FileTreeNode } from "./types"

const TREE: readonly FileTreeNode[] = [
  {
    name: "src",
    path: "src",
    kind: "directory",
    expanded: true,
    children: [
      { name: "index.ts", path: "src/index.ts", kind: "file" },
      {
        name: "lib",
        path: "src/lib",
        kind: "directory",
        children: [{ name: "util.ts", path: "src/lib/util.ts", kind: "file" }],
      },
    ],
  },
  { name: "README.md", path: "README.md", kind: "file" },
]

describe("defaultExpandedPaths", () => {
  it("collects only directories flagged expanded", () => {
    expect(defaultExpandedPaths(TREE)).toEqual(new Set(["src"]))
  })
})

describe("flattenTree", () => {
  it("hides the subtree of collapsed directories", () => {
    const rows = flattenTree(TREE, new Set())
    expect(rows.map((row) => row.node.path)).toEqual(["src", "README.md"])
  })

  it("descends into expanded directories only", () => {
    const rows = flattenTree(TREE, new Set(["src"]))
    expect(rows.map((row) => row.node.path)).toEqual(["src", "src/index.ts", "src/lib", "README.md"])
  })

  it("recurses through nested expanded directories", () => {
    const rows = flattenTree(TREE, new Set(["src", "src/lib"]))
    expect(rows.map((row) => row.node.path)).toEqual(["src", "src/index.ts", "src/lib", "src/lib/util.ts", "README.md"])
  })

  it("marks depth and hasChildren correctly", () => {
    const rows = flattenTree(TREE, new Set(["src", "src/lib"]))
    const lib = rows.find((row) => row.node.path === "src/lib")
    expect(lib?.depth).toBe(1)
    expect(lib?.hasChildren).toBe(true)
    expect(lib?.parentPath).toBe("src")
    const util = rows.find((row) => row.node.path === "src/lib/util.ts")
    expect(util?.depth).toBe(2)
    expect(util?.isDirectory).toBe(false)
  })

  it("stays linear (does not explode) for a large flat directory", () => {
    const children: FileTreeNode[] = Array.from({ length: 10_000 }, (_, index) => ({
      name: `file-${index}.ts`,
      path: `big/file-${index}.ts`,
      kind: "file" as const,
    }))
    const big: readonly FileTreeNode[] = [{ name: "big", path: "big", kind: "directory", children }]
    const collapsedRows = flattenTree(big, new Set())
    expect(collapsedRows).toHaveLength(1)
    const expandedRows = flattenTree(big, new Set(["big"]))
    expect(expandedRows).toHaveLength(10_001)
  })
})

describe("toggleExpanded", () => {
  it("adds an absent path and removes a present one", () => {
    const opened = toggleExpanded(new Set(), "src")
    expect(opened.has("src")).toBe(true)
    const closed = toggleExpanded(opened, "src")
    expect(closed.has("src")).toBe(false)
  })

  it("never mutates the input set", () => {
    const original = new Set(["src"])
    toggleExpanded(original, "README.md")
    expect(original).toEqual(new Set(["src"]))
  })
})

describe("findRowIndex", () => {
  it("returns -1 for an undefined path or a miss", () => {
    const rows = flattenTree(TREE, new Set())
    expect(findRowIndex(rows, undefined)).toBe(-1)
    expect(findRowIndex(rows, "nope")).toBe(-1)
  })

  it("finds the matching row by path", () => {
    const rows = flattenTree(TREE, new Set())
    expect(findRowIndex(rows, "README.md")).toBe(1)
  })
})

describe("treeKeyboardAction", () => {
  const rows = flattenTree(TREE, new Set(["src"]))

  it("moves down/up within bounds and stops at the edges", () => {
    expect(treeKeyboardAction(rows, 0, "ArrowDown", new Set(["src"]))).toEqual({ type: "move", index: 1 })
    expect(treeKeyboardAction(rows, rows.length - 1, "ArrowDown", new Set(["src"]))).toEqual({ type: "none" })
    expect(treeKeyboardAction(rows, 0, "ArrowUp", new Set(["src"]))).toEqual({ type: "none" })
  })

  it("jumps to the first/last row on Home/End", () => {
    expect(treeKeyboardAction(rows, 2, "Home", new Set(["src"]))).toEqual({ type: "move", index: 0 })
    expect(treeKeyboardAction(rows, 0, "End", new Set(["src"]))).toEqual({ type: "move", index: rows.length - 1 })
  })

  it("expands a collapsed directory on ArrowRight, then moves into it once expanded", () => {
    const collapsed = new Set<string>()
    const collapsedRows = flattenTree(TREE, collapsed)
    expect(treeKeyboardAction(collapsedRows, 0, "ArrowRight", collapsed)).toEqual({ type: "expand", path: "src" })
    expect(treeKeyboardAction(rows, 0, "ArrowRight", new Set(["src"]))).toEqual({ type: "move", index: 1 })
  })

  it("does nothing on ArrowRight for a leaf row", () => {
    const leafIndex = rows.findIndex((row) => row.node.path === "src/index.ts")
    expect(treeKeyboardAction(rows, leafIndex, "ArrowRight", new Set(["src"]))).toEqual({ type: "none" })
  })

  it("collapses an expanded directory on ArrowLeft, else moves to the parent", () => {
    expect(treeKeyboardAction(rows, 0, "ArrowLeft", new Set(["src"]))).toEqual({ type: "collapse", path: "src" })
    const leafIndex = rows.findIndex((row) => row.node.path === "src/index.ts")
    expect(treeKeyboardAction(rows, leafIndex, "ArrowLeft", new Set(["src"]))).toEqual({ type: "move", index: 0 })
  })

  it("selects the row on Enter/Space", () => {
    const action = treeKeyboardAction(rows, 0, "Enter", new Set(["src"]))
    expect(action.type).toBe("select")
    expect(action.type === "select" && action.row.node.path).toBe("src")
    expect(treeKeyboardAction(rows, 0, " ", new Set(["src"])).type).toBe("select")
  })

  it("ignores unmapped keys and an out-of-range index", () => {
    expect(treeKeyboardAction(rows, 0, "Tab", new Set(["src"]))).toEqual({ type: "none" })
    expect(treeKeyboardAction(rows, 999, "ArrowDown", new Set(["src"]))).toEqual({ type: "none" })
  })
})
