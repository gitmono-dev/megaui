import { describe, expect, it } from 'vitest'
import { EMBED_MAX_DEPTH, extractBlockSubtreeJSON } from './embed-subtree'

function json(root: unknown): string {
  return JSON.stringify({ root })
}

describe('EMBED_MAX_DEPTH', () => {
  it('is the ADR-CE-11 constant of 3', () => {
    expect(EMBED_MAX_DEPTH).toBe(3)
  })
})

describe('extractBlockSubtreeJSON', () => {
  it('returns null for an empty tree (空树: no children)', () => {
    expect(extractBlockSubtreeJSON(json({ type: 'root', children: [] }), 'block-1')).toBeNull()
  })

  it('returns null when the blockId is not found', () => {
    const editorStateJSON = json({
      type: 'root',
      children: [{ type: 'mega-block', blockId: 'other', children: [] }],
    })
    expect(extractBlockSubtreeJSON(editorStateJSON, 'block-1')).toBeNull()
  })

  it('returns null for malformed JSON input', () => {
    expect(extractBlockSubtreeJSON('not json', 'block-1')).toBeNull()
  })

  it('extracts the matching block subtree wrapped in a fresh root', () => {
    const target = { type: 'mega-block', blockId: 'block-1', children: [{ type: 'text', text: 'hi' }] }
    const editorStateJSON = json({
      type: 'root',
      children: [
        { type: 'mega-block', blockId: 'other', children: [] },
        target,
      ],
    })
    const result = extractBlockSubtreeJSON(editorStateJSON, 'block-1')
    expect(result).not.toBeNull()
    expect(JSON.parse(result as string)).toEqual({
      root: { type: 'root', version: 1, children: [target] },
    })
  })

  it('finds a deeply nested block across several levels', () => {
    const target = { type: 'mega-code-block', blockId: 'deep', children: [] }
    const editorStateJSON = json({
      type: 'root',
      children: [{ type: 'mega-block', blockId: 'wrap', children: [{ type: 'group', children: [target] }] }],
    })
    const result = extractBlockSubtreeJSON(editorStateJSON, 'deep')
    expect(JSON.parse(result as string).root.children).toEqual([target])
  })

  it('ignores nodes lacking a recognized indexable block type', () => {
    const editorStateJSON = json({
      type: 'root',
      children: [{ type: 'paragraph', blockId: 'block-1', children: [] }],
    })
    expect(extractBlockSubtreeJSON(editorStateJSON, 'block-1')).toBeNull()
  })

  it('takes the first match when blockId collides across the tree', () => {
    const first = { type: 'mega-block', blockId: 'dup', children: [{ type: 'text', text: 'first' }] }
    const second = { type: 'mega-block', blockId: 'dup', children: [{ type: 'text', text: 'second' }] }
    const editorStateJSON = json({ type: 'root', children: [first, second] })
    const result = extractBlockSubtreeJSON(editorStateJSON, 'dup')
    expect(JSON.parse(result as string).root.children).toEqual([first])
  })

  it('includes an outline table source when extracting its view block', () => {
    const table = { type: 'mega-outline-table', blockId: 'table-1', sourceBlockId: 'source-1' }
    const source = { type: 'mega-block', blockId: 'source-1', tableSource: true, children: [{ type: 'mega-block', blockId: 'row-1', children: [{ type: 'text', text: 'Header' }] }] }
    const result = extractBlockSubtreeJSON(json({ type: 'root', children: [table, source] }), 'table-1')
    expect(JSON.parse(result as string).root.children).toEqual([table, source])
  })
})
