import { describe, expect, it } from 'vitest'
import { compareByDirectoryFirstThenName, sortTreeNodesByKindThenName } from './tree-sort'
import type { TreeNodeKind } from './types'

interface Node {
  kind: TreeNodeKind
  name: string
}

describe('sortTreeNodesByKindThenName', () => {
  it('returns an empty array for an empty tree (空树)', () => {
    expect(sortTreeNodesByKindThenName<Node>([])).toEqual([])
  })

  it('does not mutate the input array', () => {
    const input: Node[] = [{ kind: 'file', name: 'b.ts' }, { kind: 'directory', name: 'a' }]
    const snapshot = [...input]
    sortTreeNodesByKindThenName(input)
    expect(input).toEqual(snapshot)
  })

  it('orders directories before files', () => {
    const input: Node[] = [
      { kind: 'file', name: 'z.ts' },
      { kind: 'directory', name: 'a' },
    ]
    expect(sortTreeNodesByKindThenName(input)).toEqual([
      { kind: 'directory', name: 'a' },
      { kind: 'file', name: 'z.ts' },
    ])
  })

  it('sorts each kind group by name', () => {
    const input: Node[] = [
      { kind: 'file', name: 'b.ts' },
      { kind: 'file', name: 'a.ts' },
      { kind: 'directory', name: 'zeta' },
      { kind: 'directory', name: 'alpha' },
    ]
    expect(sortTreeNodesByKindThenName(input)).toEqual([
      { kind: 'directory', name: 'alpha' },
      { kind: 'directory', name: 'zeta' },
      { kind: 'file', name: 'a.ts' },
      { kind: 'file', name: 'b.ts' },
    ])
  })

  it('is stable for a single node', () => {
    const input: Node[] = [{ kind: 'file', name: 'only.ts' }]
    expect(sortTreeNodesByKindThenName(input)).toEqual(input)
  })
})

describe('compareByDirectoryFirstThenName', () => {
  it('treats equal-kind equal-name nodes as equal (0)', () => {
    expect(compareByDirectoryFirstThenName({ kind: 'file', name: 'x' }, { kind: 'file', name: 'x' })).toBe(0)
  })

  it('ranks a directory before a file regardless of name', () => {
    expect(compareByDirectoryFirstThenName({ kind: 'directory', name: 'z' }, { kind: 'file', name: 'a' })).toBeLessThan(0)
    expect(compareByDirectoryFirstThenName({ kind: 'file', name: 'a' }, { kind: 'directory', name: 'z' })).toBeGreaterThan(0)
  })
})
