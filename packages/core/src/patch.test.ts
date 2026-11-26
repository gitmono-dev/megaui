import { describe, expect, it } from 'vitest'
import { clFileForRange, clFilePatchForRange, normalizeRevRangeBounds, parseRevRange } from './patch'
import type { CLFile, Revision } from './types'

function revision(number: number): Revision {
  return {
    id: `rev-${number}`,
    number,
    sha: `sha${number}`,
    label: `v${number}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    rebased: false,
    forcePushed: false,
    commitList: [],
    reviewerState: [],
    summary: '',
    base: 'main',
    ci: 'passing',
    additions: 0,
    deletions: 0,
    filesChanged: 0,
  }
}

const revisions = [revision(1), revision(2), revision(4)]

describe('parseRevRange', () => {
  it('returns undefined for a null/undefined/empty value (空树: no range selected)', () => {
    expect(parseRevRange(undefined, revisions)).toBeUndefined()
    expect(parseRevRange(null, revisions)).toBeUndefined()
    expect(parseRevRange('', revisions)).toBeUndefined()
  })

  it('parses a valid ascending range with both bounds known', () => {
    expect(parseRevRange('1..2', revisions)).toEqual({ from: 1, to: 2 })
  })

  it('rejects malformed / non-规则 range strings', () => {
    expect(parseRevRange('2..1', revisions)).toBeUndefined() // descending
    expect(parseRevRange('1..1', revisions)).toBeUndefined() // equal
    expect(parseRevRange('01..2', revisions)).toBeUndefined() // leading zero
    expect(parseRevRange('a..b', revisions)).toBeUndefined()
    expect(parseRevRange('1-2', revisions)).toBeUndefined()
    expect(parseRevRange('1..2..3', revisions)).toBeUndefined()
  })

  it('rejects a range referencing an unknown revision number', () => {
    expect(parseRevRange('1..3', revisions)).toBeUndefined()
    expect(parseRevRange('3..4', revisions)).toBeUndefined()
  })

  it('handles an empty revisions list (空树)', () => {
    expect(parseRevRange('1..2', [])).toBeUndefined()
  })
})

describe('clFilePatchForRange', () => {
  const file: CLFile = {
    path: 'a.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch: 'full-patch',
    viewed: false,
    commentCount: 0,
    rangePatches: { '1..2': 'range-patch' },
  }

  it('returns the full patch when no range is given', () => {
    expect(clFilePatchForRange(file, undefined)).toBe('full-patch')
  })

  it('returns the matching range patch when present', () => {
    expect(clFilePatchForRange(file, { from: 1, to: 2 })).toBe('range-patch')
  })

  it('falls back to the full patch for a range the fixture does not carry', () => {
    expect(clFilePatchForRange(file, { from: 2, to: 4 })).toBe('full-patch')
  })

  it('falls back to the full patch when rangePatches is absent', () => {
    const bare: CLFile = { ...file, rangePatches: undefined }
    expect(clFilePatchForRange(bare, { from: 1, to: 2 })).toBe('full-patch')
  })

  it('updates file statistics with the selected patch and preserves totals for the full diff', () => {
    const patch = '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n context\n+added'
    const input = { ...file, additions: 25, deletions: 4, rangePatches: { '1..2': patch, '2..4': '' } }
    expect(clFileForRange(input, { from: 1, to: 2 })).toMatchObject({ patch, additions: 1, deletions: 0 })
    expect(clFileForRange(input, { from: 2, to: 4 })).toMatchObject({ patch: '', additions: 0, deletions: 0 })
    expect(clFileForRange(input, { from: 1, to: 4 })).toBe(input)
    expect(clFileForRange(input, undefined)).toBe(input)
  })
})

describe('normalizeRevRangeBounds', () => {
  it('returns undefined for identical picks', () => {
    expect(normalizeRevRangeBounds(3, 3)).toBeUndefined()
  })

  it('orders ascending picks as-is', () => {
    expect(normalizeRevRangeBounds(1, 4)).toEqual({ from: 1, to: 4 })
  })

  it('swaps descending picks into ascending order', () => {
    expect(normalizeRevRangeBounds(4, 1)).toEqual({ from: 1, to: 4 })
  })
})
