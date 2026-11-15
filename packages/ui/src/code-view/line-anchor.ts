/**
 * New for UI-08. Parses/formats `#L42` / `#L42-L50` blob deep-link
 * fragments into/from `@pierre/diffs`'s `SelectedLineRange`. Reading and
 * writing the actual browser hash is app-router-level (out of scope, see
 * WA-08) — this package only exposes pure helpers so a consumer page can
 * wire them into its own router.
 */
import type { SelectedLineRange } from "@pierre/diffs"

const LINE_ANCHOR_PATTERN = /^#?L(\d+)(?:-L(\d+))?$/u

export function parseLineAnchor(hash: string): SelectedLineRange | undefined {
  const match = LINE_ANCHOR_PATTERN.exec(hash)
  const startText = match?.[1]
  if (!startText) return undefined
  const start = Number(startText)
  const endText = match[2]
  const end = endText === undefined ? start : Number(endText)
  if (start < 1 || end < start) return undefined
  return { end, start }
}

export function formatLineAnchor(range: Pick<SelectedLineRange, "end" | "start">): string {
  return range.start === range.end ? `#L${range.start}` : `#L${range.start}-L${range.end}`
}
