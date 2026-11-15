// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { useTreeState } from "./use-tree-state"
import type { FileTreeNode } from "./types"

const TREE: readonly FileTreeNode[] = [
  {
    name: "src",
    path: "src",
    kind: "directory",
    children: [{ name: "index.ts", path: "src/index.ts", kind: "file" }],
  },
]

describe("useTreeState", () => {
  it("starts fully collapsed by default", () => {
    const { result } = renderHook(() => useTreeState({ nodes: TREE }))
    expect(result.current.rows.map((row) => row.node.path)).toEqual(["src"])
    expect(result.current.isExpanded("src")).toBe(false)
  })

  it("honors an explicit defaultExpanded override", () => {
    const { result } = renderHook(() => useTreeState({ defaultExpanded: new Set(["src"]), nodes: TREE }))
    expect(result.current.rows.map((row) => row.node.path)).toEqual(["src", "src/index.ts"])
  })

  it("expand/collapse/toggle update rows reactively", () => {
    const { result } = renderHook(() => useTreeState({ nodes: TREE }))

    act(() => result.current.expand("src"))
    expect(result.current.isExpanded("src")).toBe(true)
    expect(result.current.rows).toHaveLength(2)

    act(() => result.current.collapse("src"))
    expect(result.current.isExpanded("src")).toBe(false)
    expect(result.current.rows).toHaveLength(1)

    act(() => result.current.toggle("src"))
    expect(result.current.isExpanded("src")).toBe(true)
    act(() => result.current.toggle("src"))
    expect(result.current.isExpanded("src")).toBe(false)
  })

  it("expand/collapse are no-ops when already in the target state", () => {
    const { result } = renderHook(() => useTreeState({ nodes: TREE }))
    act(() => result.current.collapse("src"))
    expect(result.current.isExpanded("src")).toBe(false)
    act(() => result.current.expand("src"))
    act(() => result.current.expand("src"))
    expect(result.current.isExpanded("src")).toBe(true)
  })
})
