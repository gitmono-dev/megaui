/**
 * megaui:libs/mega/embed-subtree.ts@0ff3a9d
 *
 * Client-safe embed subtree helpers (no DB / Node builtins): extract the
 * Lexical JSON subtree rooted at a given block id, for `{{` embed
 * resolution (server) and live embeds (browser) alike.
 */

/** ADR-CE-11 / CE-52: max nest depth (edges from resolve start). */
export const EMBED_MAX_DEPTH = 3

type LexicalWalkNode = {
  type?: string
  blockId?: string
  sourceBlockId?: string
  children?: LexicalWalkNode[]
}

const INDEXABLE_BLOCK_TYPES = new Set([
  'mega-block',
  'mega-code-block',
  'mega-table-block',
  'mega-outline-table',
  'mega-hr-block',
])

function isIndexableBlock(node: LexicalWalkNode): boolean {
  return Boolean(node.blockId && node.type && INDEXABLE_BLOCK_TYPES.has(node.type))
}

/** Return Lexical JSON containing only the subtree rooted at `blockId`, or null. */
export function extractBlockSubtreeJSON(editorStateJSON: string, blockId: string): string | null {
  let root: LexicalWalkNode
  try {
    const parsed = JSON.parse(editorStateJSON) as { root?: LexicalWalkNode }
    root = parsed.root ?? {}
  } catch {
    return null
  }

  let found: LexicalWalkNode | null = null
  const walk = (node: LexicalWalkNode): void => {
    if (found) return
    if (isIndexableBlock(node) && node.blockId === blockId) {
      found = node
      return
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  const selected = found as LexicalWalkNode | null
  if (!selected) return null
  let source: LexicalWalkNode | null = null
  if (selected.type === 'mega-outline-table' && selected.sourceBlockId) {
    const sourceId = selected.sourceBlockId
    const findSource = (node: LexicalWalkNode): void => {
      if (source) return
      if (node.type === 'mega-block' && node.blockId === sourceId) {
        source = node
        return
      }
      for (const child of node.children ?? []) findSource(child)
    }
    findSource(root)
  }
  return JSON.stringify({
    root: {
      type: 'root',
      version: 1,
      children: source ? [selected, source] : [selected],
    },
  })
}
