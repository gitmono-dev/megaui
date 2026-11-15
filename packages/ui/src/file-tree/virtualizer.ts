"use client"

/**
 * New for UI-08. @megaui/ui has no existing dependency on
 * @tanstack/react-virtual (upstream file tree uses it), and this card's
 * write set is limited to packages/ui/src/{code-view,file-tree} — no
 * package.json changes. This is a minimal, dependency-free replacement
 * scoped to the one case the tree needs: a uniform row height list.
 */
import { useCallback, useEffect, useState } from "react"

export interface FixedRowVirtualizerOptions {
  count: number
  rowHeight: number
  getScrollElement(): HTMLElement | null
  overscan?: number
  /**
   * Fallback viewport height used before layout/`ResizeObserver` reports a
   * real size. jsdom/happy-dom never compute real box sizes for unstyled
   * elements, so without this fallback the virtualizer would mount zero
   * rows under test.
   */
  initialHeight?: number
}

export interface VirtualRow {
  index: number
  start: number
}

export interface FixedRowVirtualizer {
  getVirtualItems(): VirtualRow[]
  getTotalSize(): number
  scrollToIndex(index: number): void
  measure(): void
}

const DEFAULT_OVERSCAN = 8
const DEFAULT_INITIAL_HEIGHT = 600

/** Fixed-row-height virtualizer: only the visible window (+ overscan) mounts. */
export function useFixedRowVirtualizer({
  count,
  rowHeight,
  getScrollElement,
  overscan = DEFAULT_OVERSCAN,
  initialHeight = DEFAULT_INITIAL_HEIGHT,
}: FixedRowVirtualizerOptions): FixedRowVirtualizer {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(initialHeight)

  // `getScrollElement` intentionally excluded from deps: it closes over a
  // stable ref for the mount's lifetime, and including it would re-create
  // `measure` (and re-run the effect below) every render if a caller passes
  // an inline arrow.
  const measure = useCallback(() => {
    const element = getScrollElement()
    if (!element) return
    setScrollTop(element.scrollTop)
    setViewportHeight(element.clientHeight > 0 ? element.clientHeight : initialHeight)
  }, [initialHeight])

  useEffect(() => {
    const element = getScrollElement()
    if (!element) return

    measure()

    const onScroll = () => setScrollTop(element.scrollTop)
    element.addEventListener("scroll", onScroll, { passive: true })

    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => measure())
      resizeObserver.observe(element)
    }

    return () => {
      element.removeEventListener("scroll", onScroll)
      resizeObserver?.disconnect()
    }
    // `getScrollElement` intentionally excluded: same rationale as `measure` above.
  }, [measure])

  const totalSize = count * rowHeight

  const getVirtualItems = useCallback((): VirtualRow[] => {
    if (count === 0 || rowHeight <= 0) return []
    const firstVisible = Math.floor(scrollTop / rowHeight)
    const visibleRowCount = Math.ceil(viewportHeight / rowHeight)
    const start = Math.max(0, firstVisible - overscan)
    const end = Math.min(count - 1, firstVisible + visibleRowCount + overscan)

    const items: VirtualRow[] = []
    for (let index = start; index <= end; index += 1) {
      items.push({ index, start: index * rowHeight })
    }
    return items
  }, [count, overscan, rowHeight, scrollTop, viewportHeight])

  const scrollToIndex = useCallback(
    (index: number) => {
      const element = getScrollElement()
      if (!element) return
      element.scrollTop = index * rowHeight
      setScrollTop(element.scrollTop)
    },
    [getScrollElement, rowHeight]
  )

  return {
    getVirtualItems,
    getTotalSize: () => totalSize,
    measure,
    scrollToIndex,
  }
}
