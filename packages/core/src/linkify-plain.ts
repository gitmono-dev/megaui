/**
 * megaui:libs/mega/linkify-plain.ts@0ff3a9d
 *
 * Replace the first plain-text occurrence of a title with a resolved
 * `mega-ref` node inside serialized Lexical editor-state JSON (CE-42).
 * Match is case-insensitive (aligned with unlinked detection); the ref node
 * stores the canonical `targetTitle`. Leaves already-linked `mega-ref`
 * nodes untouched. Operates on plain JSON only (no Lexical runtime
 * dependency), so it is safe to call from `core` on either side.
 */

export function linkifyPlainTitleInEditorState(
  editorStateJSON: string,
  target: { kind: 'doc' | 'issue' | 'cl'; targetId: string; targetTitle: string },
): { editorStateJSON: string; linked: boolean } {
  let root: LexNode
  try {
    const parsed = JSON.parse(editorStateJSON) as { root?: LexNode }
    root = parsed.root ?? { type: 'root', children: [] }
  } catch {
    return { editorStateJSON, linked: false }
  }

  const needle = target.targetTitle
  if (!needle.trim()) return { editorStateJSON, linked: false }
  const needleLower = needle.toLowerCase()

  let linked = false

  const visit = (node: LexNode): LexNode => {
    if (linked) return node
    if (node.type === 'mega-ref') return node

    if (typeof node.text === 'string' && node.type === 'text') {
      const match = findCaseInsensitiveMatch(node.text, needleLower)
      if (!match) return node
      linked = true
      const before = node.text.slice(0, match.start)
      const after = node.text.slice(match.end)
      const parts: LexNode[] = []
      if (before) parts.push({ ...node, text: before })
      parts.push({
        type: 'mega-ref',
        version: 1,
        ref: {
          kind: target.kind,
          targetTitle: target.targetTitle,
          targetId: target.targetId,
        },
      })
      if (after) parts.push({ ...node, text: after })
      // Parent walk replaces this text node with a fragment via children rewrite.
      return { type: '__linkify_fragment__', children: parts }
    }

    if (!node.children?.length) return node
    const nextChildren: LexNode[] = []
    for (const child of node.children) {
      const visited = visit(child)
      if (visited.type === '__linkify_fragment__' && visited.children) {
        nextChildren.push(...visited.children)
      } else {
        nextChildren.push(visited)
      }
    }
    return { ...node, children: nextChildren }
  }

  const nextRoot = visit(root)
  if (!linked) return { editorStateJSON, linked: false }
  return {
    editorStateJSON: JSON.stringify({ root: nextRoot }),
    linked: true,
  }
}

/**
 * Locates `needleLower` inside `text` case-insensitively, returning the
 * *original* UTF-16 offsets of the match (P2 fix).
 *
 * Lowercasing can change a character's length — e.g. U+0130 (LATIN CAPITAL
 * LETTER I WITH DOT ABOVE, `İ`) lowercases to `i` + a combining dot above
 * (2 code units) — so `text.toLowerCase()` can be longer than `text`
 * itself, and reusing an index found in the lowercased string directly
 * against the original string (as the previous `slice(index + needleLower.length)`
 * did) silently drops trailing characters whenever such a character
 * appears before or inside the match. This walks `text` one code point at
 * a time, case-folding each individually, to build a lowered-index →
 * original-offset map before searching, so the returned `start`/`end`
 * always land on original character boundaries.
 */
function findCaseInsensitiveMatch(text: string, needleLower: string): { start: number; end: number } | null {
  let lower = ''
  const originalOffsetAtLowerIndex: number[] = []
  let i = 0
  while (i < text.length) {
    const codePoint = text.codePointAt(i) ?? 0
    const charLength = codePoint > 0xffff ? 2 : 1
    const folded = text.slice(i, i + charLength).toLowerCase()
    for (let k = 0; k < folded.length; k++) originalOffsetAtLowerIndex.push(i)
    lower += folded
    i += charLength
  }

  const lowerIndex = lower.indexOf(needleLower)
  if (lowerIndex === -1) return null

  const lowerEnd = lowerIndex + needleLower.length
  const start = originalOffsetAtLowerIndex[lowerIndex]!
  // Exclusive end must be the next original code-point boundary after the last
  // matched fold unit (not originalOffsetAtLowerIndex[lowerEnd], which can still
  // point inside a multi-unit fold such as `İ` → `i` + combining dot).
  const lastMatchedOrig = originalOffsetAtLowerIndex[lowerEnd - 1]!
  const lastCp = text.codePointAt(lastMatchedOrig) ?? 0
  const end = lastMatchedOrig + (lastCp > 0xffff ? 2 : 1)
  return { start, end }
}

type LexNode = {
  type?: string
  text?: string
  version?: number
  ref?: {
    kind?: string
    targetTitle?: string
    targetId?: string
  }
  children?: LexNode[]
  [key: string]: unknown
}
