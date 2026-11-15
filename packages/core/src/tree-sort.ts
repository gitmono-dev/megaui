/**
 * megaui:libs/mega/tree-sort.ts@0ff3a9d
 *
 * Canonical repo/doc tree ordering: directories before files, each group
 * sorted by name.
 */

import type { TreeNodeKind } from './types'

interface NamedTreeKind {
  kind: TreeNodeKind
  name: string
}

/** Directories first, then files; each group sorted by name. */
export function compareByDirectoryFirstThenName(left: NamedTreeKind, right: NamedTreeKind): number {
  return Number(right.kind === 'directory') - Number(left.kind === 'directory')
    || left.name.localeCompare(right.name)
}

export function sortTreeNodesByKindThenName<T extends NamedTreeKind>(nodes: readonly T[]): T[] {
  return [...nodes].sort(compareByDirectoryFirstThenName)
}
