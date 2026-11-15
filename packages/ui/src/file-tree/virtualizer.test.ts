// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { useFixedRowVirtualizer } from "./virtualizer"

function makeScrollElement({ clientHeight = 0, scrollTop = 0 } = {}) {
  const element = document.createElement("div")
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight })
  Object.defineProperty(element, "scrollTop", { configurable: true, value: scrollTop, writable: true })
  return element
}

describe("useFixedRowVirtualizer", () => {
  it("computes total size from count * rowHeight", () => {
    const { result } = renderHook(() =>
      useFixedRowVirtualizer({ count: 10_000, getScrollElement: () => null, rowHeight: 26 })
    )
    expect(result.current.getTotalSize()).toBe(260_000)
  })

  it("falls back to initialHeight when the scroll element reports zero (jsdom/happy-dom default)", () => {
    const element = makeScrollElement({ clientHeight: 0 })
    const { result } = renderHook(() =>
      useFixedRowVirtualizer({ count: 10_000, getScrollElement: () => element, initialHeight: 260, rowHeight: 26 })
    )
    // 260 / 26 = 10 visible rows + default overscan (8) on each side, clamped to count.
    const items = result.current.getVirtualItems()
    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThan(40)
    expect(items[0]?.index).toBe(0)
  })

  it("only mounts the visible window (+ overscan) for a huge list, not all 10k rows", () => {
    const element = makeScrollElement({ clientHeight: 300 })
    const { result } = renderHook(() =>
      useFixedRowVirtualizer({ count: 10_000, getScrollElement: () => element, overscan: 4, rowHeight: 30 })
    )
    const items = result.current.getVirtualItems()
    // 300 / 30 = 10 visible + 4 overscan each side = 18, plus the fencepost row.
    expect(items.length).toBeLessThanOrEqual(19)
    expect(items.length).toBeGreaterThan(0)
  })

  it("scrollToIndex sets scrollTop and shifts the visible window", () => {
    const element = makeScrollElement({ clientHeight: 100 })
    const { result } = renderHook(() =>
      useFixedRowVirtualizer({ count: 10_000, getScrollElement: () => element, overscan: 0, rowHeight: 10 })
    )

    act(() => result.current.scrollToIndex(500))
    expect(element.scrollTop).toBe(5000)
    const items = result.current.getVirtualItems()
    expect(items[0]?.index).toBe(500)
  })

  it("returns no items for an empty list", () => {
    const { result } = renderHook(() => useFixedRowVirtualizer({ count: 0, getScrollElement: () => null, rowHeight: 26 }))
    expect(result.current.getVirtualItems()).toEqual([])
    expect(result.current.getTotalSize()).toBe(0)
  })

  it("clamps the visible window to the last row near the end of the list", () => {
    const element = makeScrollElement({ clientHeight: 100 })
    const { result } = renderHook(() =>
      useFixedRowVirtualizer({ count: 20, getScrollElement: () => element, overscan: 2, rowHeight: 10 })
    )
    act(() => result.current.scrollToIndex(19))
    const items = result.current.getVirtualItems()
    expect(items.at(-1)?.index).toBe(19)
    expect(items.every((item) => item.index < 20)).toBe(true)
  })
})
