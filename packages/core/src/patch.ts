/**
 * megaui:libs/mega/patch.ts@0ff3a9d
 *
 * CL file-diff range helpers: parse a `"a..b"` revision-range deep link,
 * pick the right stored patch for that range, and normalize two user-picked
 * revision numbers into a valid range.
 */

import type { CLFile, Revision } from './types'

/** "a..b" with 1 <= a < b — the only range shape CL-03 links produce. */
const RANGE_PATTERN = /^([1-9]\d*)\.\.([1-9]\d*)$/u

export interface RevRange {
  from: number
  to: number
}

export function parseRevRange(value: string | null | undefined, revisions: readonly Revision[]): RevRange | undefined {
  if (!value) return undefined
  const match = RANGE_PATTERN.exec(value)
  if (!match) return undefined
  const from = Number(match[1])
  const to = Number(match[2])
  const known = new Set(revisions.map((revision) => revision.number))
  if (from >= to || !known.has(from) || !known.has(to)) return undefined
  return { from, to }
}

/**
 * The fixture patch for a rev range (GC-02 single selection rule): ranges the
 * fixture does not carry fall back to the file's full patch — the mock layer
 * never computes diffs.
 */
export function clFilePatchForRange(file: CLFile, range: RevRange | undefined): string {
  if (!range) return file.patch
  return file.rangePatches?.[`${range.from}..${range.to}`] ?? file.patch
}

/** Keep the rendered patch and its file statistics on the same revision range. */
export function clFileForRange(file: CLFile, range: RevRange | undefined): CLFile {
  const patch = clFilePatchForRange(file, range)
  return patch === file.patch ? file : { ...file, patch, ...countDiffLines(patch) }
}

/**
 * Orders two user-picked revision numbers into a valid range; identical picks
 * produce no range (the CompareBar falls back to the full span).
 */
export function normalizeRevRangeBounds(a: number, b: number): RevRange | undefined {
  if (a === b) return undefined
  return a < b ? { from: a, to: b } : { from: b, to: a }
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function countDiffLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let hasHunk = false;

  for (const line of patch.split("\n")) {
    if (oldRemaining === 0 && newRemaining === 0) {
      const match = HUNK_HEADER_RE.exec(line);
      if (match) {
        hasHunk = true;
        oldRemaining = match[2] !== undefined ? Number(match[2]) : 1;
        newRemaining = match[4] !== undefined ? Number(match[4]) : 1;
      }
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
      if (newRemaining > 0) newRemaining -= 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
      if (oldRemaining > 0) oldRemaining -= 1;
    } else if (line.startsWith(" ")) {
      if (oldRemaining > 0) oldRemaining -= 1;
      if (newRemaining > 0) newRemaining -= 1;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" does not consume hunk line counts.
    }
  }

  if (!hasHunk) {
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++ ")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("--- ")) deletions += 1;
    }
  }

  return { additions, deletions };
}
