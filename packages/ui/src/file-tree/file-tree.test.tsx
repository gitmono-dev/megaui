// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { MegaFileTree } from "./file-tree"
import type { FileTreeNode } from "./types"

afterEach(() => {
  cleanup()
})

const LABELS = { treeAriaLabel: "Files" }

const SMALL_TREE: readonly FileTreeNode[] = [
  {
    name: "src",
    path: "src",
    kind: "directory",
    expanded: true,
    children: [
      { name: "index.ts", path: "src/index.ts", kind: "file" },
      { name: "lib", path: "src/lib", kind: "directory", children: [{ name: "util.ts", path: "src/lib/util.ts", kind: "file" }] },
    ],
  },
  { name: "README.md", path: "README.md", kind: "file" },
]

/** 10 top-level directories x 1,000 files each = 1e4 nodes (GC-10 scale target). */
function buildLargeTree(dirCount = 10, filesPerDir = 1_000): readonly FileTreeNode[] {
  return Array.from({ length: dirCount }, (_, dirIndex) => ({
    name: `package-${dirIndex}`,
    path: `package-${dirIndex}`,
    kind: "directory" as const,
    children: Array.from({ length: filesPerDir }, (_, fileIndex) => ({
      name: `file-${fileIndex}.ts`,
      path: `package-${dirIndex}/file-${fileIndex}.ts`,
      kind: "file" as const,
    })),
  }))
}

describe("MegaFileTree", () => {
  it("renders the default-expanded rows and hides collapsed subtrees", () => {
    render(<MegaFileTree labels={LABELS} nodes={SMALL_TREE} onSelect={vi.fn()} />)
    expect(screen.getByText("src")).toBeInTheDocument()
    expect(screen.getByText("index.ts")).toBeInTheDocument()
    expect(screen.getByText("lib")).toBeInTheDocument()
    expect(screen.getByText("README.md")).toBeInTheDocument()
    // "lib" starts collapsed: its child never mounts (lazy expand).
    expect(screen.queryByText("util.ts")).not.toBeInTheDocument()
  })

  it("lazily expands a directory on click, mounting its children on demand", () => {
    render(<MegaFileTree labels={LABELS} nodes={SMALL_TREE} onSelect={vi.fn()} />)
    expect(screen.queryByText("util.ts")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("lib"))
    expect(screen.getByText("util.ts")).toBeInTheDocument()
  })

  it("calls onSelect with the clicked node", () => {
    const onSelect = vi.fn()
    render(<MegaFileTree labels={LABELS} nodes={SMALL_TREE} onSelect={onSelect} />)
    fireEvent.click(screen.getByText("index.ts"))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: "src/index.ts" }))
  })

  it("notifies onDirectoryToggle only when a collapsed directory is opened", () => {
    const onDirectoryToggle = vi.fn()
    render(<MegaFileTree labels={LABELS} nodes={SMALL_TREE} onDirectoryToggle={onDirectoryToggle} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByText("lib"))
    expect(onDirectoryToggle).toHaveBeenCalledWith("src/lib", true)
    onDirectoryToggle.mockClear()
    // "src" is already expanded; clicking again re-selects but does not re-toggle.
    fireEvent.click(screen.getByText("src"))
    expect(onDirectoryToggle).not.toHaveBeenCalled()
  })

  it("expands the active path's ancestor chain so the highlighted row is visible", () => {
    render(<MegaFileTree activePath="src/lib/util.ts" labels={LABELS} nodes={SMALL_TREE} onSelect={vi.fn()} />)
    expect(screen.getByText("util.ts")).toBeInTheDocument()
  })

  it("opens the active directory itself, even when its data is not flagged expanded", async () => {
    const nodes: readonly FileTreeNode[] = [
      {
        name: "project",
        path: "project",
        kind: "directory",
        children: [{ name: ".gitkeep", path: "project/.gitkeep", kind: "file" }],
      },
    ]
    render(<MegaFileTree activePath="project" labels={LABELS} nodes={nodes} onSelect={vi.fn()} />)
    expect(await screen.findByText(".gitkeep")).toBeInTheDocument()
  })

  it("toggles a directory from its chevron without selecting it", () => {
    const onDirectoryToggle = vi.fn()
    const onSelect = vi.fn()
    render(<MegaFileTree labels={LABELS} nodes={SMALL_TREE} onDirectoryToggle={onDirectoryToggle} onSelect={onSelect} />)
    const chevron = document.querySelector("[data-mega-tree='chevron']")
    if (!chevron) throw new Error("expected a directory chevron")
    fireEvent.click(chevron)
    expect(onDirectoryToggle).toHaveBeenCalledWith("src", false)
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument()
  })

  it("supports keyboard navigation (ArrowDown moves focus, Enter selects)", () => {
    const onSelect = vi.fn()
    render(<MegaFileTree labels={LABELS} nodes={SMALL_TREE} onSelect={onSelect} />)
    const tree = screen.getByRole("tree")
    fireEvent.keyDown(tree, { key: "ArrowDown" })
    fireEvent.keyDown(tree, { key: "Enter" })
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: "src/index.ts" }))
  })

  it("renders a branch header row when branchName is provided", () => {
    render(<MegaFileTree branchName="main" labels={LABELS} nodes={SMALL_TREE} onSelect={vi.fn()} />)
    expect(screen.getByText("main")).toBeInTheDocument()
  })

  describe("at 1e4-node scale", () => {
    const LARGE_TREE = buildLargeTree()

    it("virtualizes: only a small window of rows mounts, never all 10,000", () => {
      const { container } = render(<MegaFileTree defaultExpanded={new Set(["package-0"])} labels={LABELS} nodes={LARGE_TREE} onSelect={vi.fn()} />)
      const rows = container.querySelectorAll('[data-mega-tree="row"]')
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.length).toBeLessThan(100)
    })

    it("lazy expand: collapsed directories contribute zero mounted rows for their children", () => {
      const { container } = render(<MegaFileTree labels={LABELS} nodes={LARGE_TREE} onSelect={vi.fn()} />)
      // Fully collapsed: only the 10 top-level directory rows should exist.
      const rows = container.querySelectorAll('[data-mega-tree="row"]')
      expect(rows.length).toBe(10)
    })

    it("lazy expand: opening one directory only mounts that directory's window, not the other 9,000 files", () => {
      const { container } = render(<MegaFileTree labels={LABELS} nodes={LARGE_TREE} onSelect={vi.fn()} />)
      fireEvent.click(screen.getByText("package-0"))
      const rows = container.querySelectorAll('[data-mega-tree="row"]')
      // 1 directory row + a virtualized window of its 1,000 children, well under the full 1,001.
      expect(rows.length).toBeGreaterThan(1)
      expect(rows.length).toBeLessThan(100)
    })
  })
})
