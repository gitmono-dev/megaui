/**
 * megaui:libs/react-shared/components/mega/file-tree/tree-state.ts@0ff3a9d
 *
 * Adapted: `TreeNode` now comes from local `./types` instead of
 * `@libs/mega/types` (see that module's provenance note).
 */
import type { FileTreeNode } from "./types"

export interface FlatTreeRow {
  depth: number
  hasChildren: boolean
  isDirectory: boolean
  node: FileTreeNode
  parentPath?: string
}

interface FlattenFrame {
  depth: number
  index: number
  list: readonly FileTreeNode[]
  parentPath?: string
}

/**
 * Depth-first flattening that hides the subtree of every collapsed directory.
 * Iterative with a single accumulator: linear in visible rows and safe for
 * arbitrarily deep chains (no recursion, no per-ancestor array copying).
 */
export function flattenTree(
  nodes: readonly FileTreeNode[],
  expandedPaths: ReadonlySet<string>
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = []
  const stack: FlattenFrame[] = [{ depth: 0, index: 0, list: nodes, parentPath: undefined }]

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (!frame || frame.index >= frame.list.length) {
      stack.pop()
      continue
    }

    const node = frame.list[frame.index]
    frame.index += 1
    if (!node) continue
    const isDirectory = node.kind === "directory"
    // Directories are expandable even before lazy children load (WA-08 mega2).
    rows.push({ depth: frame.depth, hasChildren: isDirectory, isDirectory, node, parentPath: frame.parentPath })
    if (isDirectory && node.children && node.children.length > 0 && expandedPaths.has(node.path)) {
      stack.push({ depth: frame.depth + 1, index: 0, list: node.children, parentPath: node.path })
    }
  }

  return rows
}

/** Collects the `expanded` flags the fixture/consumer data marks as the default open set. */
export function defaultExpandedPaths(nodes: readonly FileTreeNode[]): Set<string> {
  const paths = new Set<string>()
  const stack: (readonly FileTreeNode[])[] = [nodes]

  while (stack.length > 0) {
    const list = stack.pop()
    if (!list) continue
    for (const node of list) {
      if (node.kind === "directory" && node.expanded) paths.add(node.path)
      if (node.children && node.children.length > 0) stack.push(node.children)
    }
  }

  return paths
}

export function toggleExpanded(expandedPaths: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(expandedPaths)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

export function findRowIndex(rows: readonly FlatTreeRow[], path: string | undefined): number {
  if (path === undefined) return -1
  return rows.findIndex((row) => row.node.path === path)
}

export type TreeKeyboardAction =
  | { type: "collapse"; path: string }
  | { type: "expand"; path: string }
  | { type: "move"; index: number }
  | { type: "select"; row: FlatTreeRow }
  | { type: "none" }

/**
 * WAI-ARIA tree keyboard contract over the flattened rows:
 * ↑/↓ move, → expands or enters, ← collapses or moves to the parent,
 * Enter selects, Home/End jump.
 */
export function treeKeyboardAction(
  rows: readonly FlatTreeRow[],
  index: number,
  key: string,
  expandedPaths: ReadonlySet<string>
): TreeKeyboardAction {
  const row = rows[index]
  if (!row) return { type: "none" }

  switch (key) {
    case "ArrowDown":
      return index < rows.length - 1 ? { type: "move", index: index + 1 } : { type: "none" }
    case "ArrowUp":
      return index > 0 ? { type: "move", index: index - 1 } : { type: "none" }
    case "Home":
      return rows.length > 0 ? { type: "move", index: 0 } : { type: "none" }
    case "End":
      return rows.length > 0 ? { type: "move", index: rows.length - 1 } : { type: "none" }
    case "ArrowRight": {
      if (!row.isDirectory) return { type: "none" }
      if (!expandedPaths.has(row.node.path)) return { type: "expand", path: row.node.path }
      // Expanded but children not yet loaded (lazy): stay put.
      if (!row.node.children || row.node.children.length === 0) return { type: "none" }
      return index < rows.length - 1 ? { type: "move", index: index + 1 } : { type: "none" }
    }
    case "ArrowLeft": {
      if (row.isDirectory && expandedPaths.has(row.node.path)) return { type: "collapse", path: row.node.path }
      const parentIndex = findRowIndex(rows, row.parentPath)
      return parentIndex >= 0 ? { type: "move", index: parentIndex } : { type: "none" }
    }
    case "Enter":
    case " ":
      return { type: "select", row }
    default:
      return { type: "none" }
  }
}
