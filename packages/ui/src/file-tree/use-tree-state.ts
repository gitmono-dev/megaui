"use client"

/**
 * megaui:libs/react-shared/components/mega/file-tree/use-tree-state.ts@0ff3a9d
 *
 * Adapted: `TreeNode` now comes from local `./types` instead of
 * `@libs/mega/types`.
 */
import { useCallback, useMemo, useState } from "react"

import { defaultExpandedPaths, flattenTree, toggleExpanded, type FlatTreeRow } from "./tree-state"
import type { FileTreeNode } from "./types"

export interface UseTreeStateOptions {
  /** Overrides the fixture/consumer default open set. */
  defaultExpanded?: ReadonlySet<string>
  nodes: readonly FileTreeNode[]
}

export interface TreeState {
  collapse(path: string): void
  expand(path: string): void
  expandedPaths: ReadonlySet<string>
  isExpanded(path: string): boolean
  rows: readonly FlatTreeRow[]
  toggle(path: string): void
}

/** Controlled expansion state (fixes the design's per-row useState defect). */
export function useTreeState({ defaultExpanded, nodes }: UseTreeStateOptions): TreeState {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => defaultExpanded ?? defaultExpandedPaths(nodes)
  )

  const rows = useMemo(() => flattenTree(nodes, expandedPaths), [expandedPaths, nodes])

  const toggle = useCallback((path: string) => {
    setExpandedPaths((current) => toggleExpanded(current, path))
  }, [])

  const expand = useCallback((path: string) => {
    setExpandedPaths((current) => (current.has(path) ? current : new Set([...current, path])))
  }, [])

  const collapse = useCallback((path: string) => {
    setExpandedPaths((current) => {
      if (!current.has(path)) return current
      const next = new Set(current)
      next.delete(path)
      return next
    })
  }, [])

  const isExpanded = useCallback((path: string) => expandedPaths.has(path), [expandedPaths])

  return { collapse, expand, expandedPaths, isExpanded, rows, toggle }
}
