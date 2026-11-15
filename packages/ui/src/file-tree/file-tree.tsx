"use client"

/**
 * megaui:libs/react-shared/components/mega/file-tree/file-tree.tsx@0ff3a9d
 *
 * Adapted for this card's self-contained write set:
 * - `TreeNode` -> local `./types` (`@libs/mega/types` is app-domain, not a
 *   `@megaui/ui` dependency).
 * - `@tanstack/react-virtual` -> local `./virtualizer` (dependency-free
 *   fixed-row virtualizer; no package.json changes in this card).
 * - `MegaIcon`/`useMegaSettings` (icon-name registry + density context, not
 *   yet ported to `@megaui/ui`) -> `lucide-react` icons (existing
 *   `@megaui/ui` dependency) + a `density` prop.
 */
import { ChevronRight, File as FileGlyph, Filter, Folder, FolderOpen, GitBranch, MoreHorizontal } from "lucide-react"
import * as React from "react"
import { useCallback, useEffect, useId, useRef, useState } from "react"

import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "../tokens/mega-tokens"
import { findRowIndex, treeKeyboardAction, type FlatTreeRow } from "./tree-state"
import { useTreeState, type TreeState } from "./use-tree-state"
import type { FileTreeNode } from "./types"
import { useFixedRowVirtualizer } from "./virtualizer"

export interface MegaFileTreeLabels {
  treeAriaLabel: string
}

export type MegaFileTreeDensity = "comfortable" | "compact"

export interface MegaFileTreeProps {
  /** Highlighted file path (route-derived by the consumer). */
  activePath?: string
  /** Optional branch header row (design: branch name + filter/more glyphs). */
  branchName?: string
  defaultExpanded?: ReadonlySet<string>
  /** Defaults to `'comfortable'`; out-of-scope density context wiring is left to the consumer. */
  density?: MegaFileTreeDensity
  labels: MegaFileTreeLabels
  nodes: readonly FileTreeNode[]
  onSelect(node: FileTreeNode): void
  onDirectoryToggle?(path: string, expanded: boolean): void
  /** Defaults to a fixed sidebar width. */
  width?: number | string
}

const ROW_HEIGHTS: Record<MegaFileTreeDensity, number> = { comfortable: 26, compact: 22 }

interface TreeRowProps {
  active: boolean
  focused: boolean
  id: string
  onRowClick(row: FlatTreeRow): void
  row: FlatTreeRow
  rowHeight: number
  treeState: TreeState
}

function TreeRow({ active, focused, id, onRowClick, row, rowHeight, treeState }: TreeRowProps) {
  const expanded = row.isDirectory ? treeState.isExpanded(row.node.path) : undefined
  const DirectoryIcon = expanded ? FolderOpen : Folder

  return (
    <div
      aria-expanded={row.isDirectory ? expanded : undefined}
      aria-level={row.depth + 1}
      aria-selected={active || undefined}
      data-active={active ? "true" : "false"}
      data-focused={focused ? "true" : "false"}
      data-mega-tree="row"
      id={id}
      onClick={() => onRowClick(row)}
      role="treeitem"
      style={{
        alignItems: "center",
        borderRadius: 4,
        color: active ? MEGA_TOKENS.activeFg : MEGA_TOKENS.text,
        cursor: "pointer",
        display: "flex",
        fontSize: "calc(var(--mega-density-font-size) - 0.5px)",
        fontWeight: active ? 600 : 400,
        gap: MEGA_SPACING_TOKENS[4],
        height: rowHeight,
        paddingLeft: 4 + row.depth * 14,
        paddingRight: MEGA_SPACING_TOKENS[8],
      }}
    >
      <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0, width: 12 }}>
        {row.isDirectory && row.hasChildren ? (
          <span data-mega-tree="chevron" style={{ display: "inline-flex", transform: expanded ? "rotate(90deg)" : "none", transition: "transform .12s" }}>
            <ChevronRight color={MEGA_TOKENS.muted} size={11} />
          </span>
        ) : null}
      </span>
      {row.isDirectory ? (
        <DirectoryIcon aria-hidden="true" color={active ? MEGA_TOKENS.activeFg : MEGA_TOKENS.text} size={14} />
      ) : (
        <FileGlyph aria-hidden="true" color={active ? MEGA_TOKENS.activeFg : MEGA_TOKENS.muted} size={14} />
      )}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.node.name}</span>
    </div>
  )
}

/**
 * Virtualized workspace file tree with controlled expansion and the
 * WAI-ARIA tree keyboard contract. Directory clicks expand when collapsed
 * and report the node for routing; file clicks only select. Only the
 * visible window of rows mounts (virtual scroll), and collapsed subtrees
 * never flatten into rows at all (lazy expand) — both hold at 1e4+ node
 * scale (GC-10).
 */
export function MegaFileTree({
  activePath,
  branchName,
  defaultExpanded,
  density = "comfortable",
  labels,
  nodes,
  onDirectoryToggle,
  onSelect,
  width,
}: MegaFileTreeProps) {
  const rowHeight = ROW_HEIGHTS[density]
  const treeState = useTreeState({ defaultExpanded, nodes })
  const { rows } = treeState
  const scrollRef = useRef<HTMLDivElement>(null)
  const [focusIndex, setFocusIndex] = useState(0)
  const treeDomId = useId()
  const rowDomId = useCallback((index: number) => `${treeDomId}-row-${index}`, [treeDomId])

  const virtualizer = useFixedRowVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    rowHeight,
  })

  // Re-measure whenever the row height changes (density switch); `virtualizer` is a
  // fresh object each render, so it's intentionally excluded from the deps below.
  useEffect(() => {
    virtualizer.measure()
  }, [rowHeight])

  // URL sync: whenever the active path changes (e.g. a jump/search result),
  // its ancestor directories expand so the highlighted row is visible.
  // `treeState.expand` is stable across renders; this intentionally only reruns per `activePath`.
  useEffect(() => {
    if (!activePath) return
    const segments = activePath.split("/")
    for (let index = 1; index < segments.length; index += 1) {
      treeState.expand(segments.slice(0, index).join("/"))
    }
  }, [activePath])

  // Focus identity is the row's path. The ref is written synchronously in
  // the interaction handlers (never from a rows-derived effect, which would
  // overwrite the previous path before reconciliation can use it); when
  // rows reshuffle, the same node keeps focus and only a vanished node
  // falls back to the clamped index.
  const focusedPathRef = useRef<string | undefined>(undefined)

  const focusRow = useCallback(
    (index: number) => {
      focusedPathRef.current = rows[index]?.node.path
      setFocusIndex(index)
    },
    [rows]
  )

  useEffect(() => {
    const path = focusedPathRef.current
    if (path !== undefined) {
      const index = findRowIndex(rows, path)
      if (index >= 0) {
        setFocusIndex((current) => (current === index ? current : index))
        return
      }
      focusedPathRef.current = undefined
    }
    setFocusIndex((current) => (current >= rows.length ? Math.max(rows.length - 1, 0) : current))
  }, [rows])

  const handleRowClick = useCallback(
    (row: FlatTreeRow) => {
      const index = findRowIndex(rows, row.node.path)
      if (index >= 0) focusRow(index)
      if (row.isDirectory) {
        const expanded = treeState.isExpanded(row.node.path)
        if (!expanded) {
          treeState.expand(row.node.path)
          onDirectoryToggle?.(row.node.path, true)
        }
        onSelect(row.node)
      } else {
        onSelect(row.node)
      }
    },
    [focusRow, onDirectoryToggle, onSelect, rows, treeState]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const action = treeKeyboardAction(rows, focusIndex, event.key, treeState.expandedPaths)
      if (action.type === "none") return
      event.preventDefault()

      if (action.type === "move") {
        focusRow(action.index)
        virtualizer.scrollToIndex(action.index)
      } else if (action.type === "expand") {
        treeState.expand(action.path)
        onDirectoryToggle?.(action.path, true)
      } else if (action.type === "collapse") {
        treeState.collapse(action.path)
        onDirectoryToggle?.(action.path, false)
      } else {
        handleRowClick(action.row)
      }
    },
    [focusIndex, focusRow, handleRowClick, onDirectoryToggle, rows, treeState, virtualizer]
  )

  return (
    <div
      data-mega-tree="root"
      style={{
        background: MEGA_TOKENS.subtle,
        borderRight: `1px solid ${MEGA_TOKENS.border}`,
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        minHeight: 0,
        width: width ?? 280,
      }}
    >
      {branchName ? (
        <div
          data-mega-tree="header"
          style={{
            alignItems: "center",
            borderBottom: `1px solid ${MEGA_TOKENS.border}`,
            color: MEGA_TOKENS.muted,
            display: "flex",
            fontSize: "calc(var(--mega-density-font-size) - 1.5px)",
            gap: MEGA_SPACING_TOKENS[6],
            padding: `${MEGA_SPACING_TOKENS[8]} calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]} + ${MEGA_SPACING_TOKENS[1]})`,
          }}
        >
          <GitBranch aria-hidden="true" color={MEGA_TOKENS.muted} size={12} />
          <span style={{ fontWeight: 600 }}>{branchName}</span>
          <span style={{ flex: 1 }} />
          <Filter aria-hidden="true" color={MEGA_TOKENS.muted} size={13} />
          <MoreHorizontal aria-hidden="true" color={MEGA_TOKENS.muted} size={13} />
        </div>
      ) : null}
      {/* Focus stays on the container; aria-activedescendant tracks the roving row
          (virtualization-safe: the referenced row is scrolled into the DOM on move). */}
      <div
        aria-activedescendant={rows.length > 0 ? rowDomId(Math.min(focusIndex, rows.length - 1)) : undefined}
        aria-label={labels.treeAriaLabel}
        data-mega-tree="scroll"
        onKeyDown={handleKeyDown}
        ref={scrollRef}
        role="tree"
        style={{ flex: 1, minHeight: 0, overflow: "auto", padding: `${MEGA_SPACING_TOKENS[6]} ${MEGA_SPACING_TOKENS[4]}` }}
        tabIndex={0}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]
            if (!row) return null
            return (
              <div key={row.node.path} style={{ left: 0, position: "absolute", top: 0, transform: `translateY(${item.start}px)`, width: "100%" }}>
                <TreeRow
                  active={row.node.path === activePath}
                  focused={item.index === focusIndex}
                  id={rowDomId(item.index)}
                  onRowClick={handleRowClick}
                  row={row}
                  rowHeight={rowHeight}
                  treeState={treeState}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
