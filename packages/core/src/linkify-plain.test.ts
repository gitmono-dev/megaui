import { describe, expect, it } from 'vitest'
import { linkifyPlainTitleInEditorState } from './linkify-plain'

function json(root: unknown): string {
  return JSON.stringify({ root })
}

describe('linkifyPlainTitleInEditorState', () => {
  it('links a plain-text occurrence of the title inside a text node', () => {
    const editorStateJSON = json({
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', text: 'See Runbook for details' }] },
      ],
    })
    const { editorStateJSON: next, linked } = linkifyPlainTitleInEditorState(editorStateJSON, {
      kind: 'doc',
      targetId: 'doc-1',
      targetTitle: 'Runbook',
    })
    expect(linked).toBe(true)
    const parsed = JSON.parse(next)
    const textChildren = parsed.root.children[0].children
    expect(textChildren).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'mega-ref', version: 1, ref: { kind: 'doc', targetTitle: 'Runbook', targetId: 'doc-1' } },
      { type: 'text', text: ' for details' },
    ])
  })

  it('matches case-insensitively', () => {
    const editorStateJSON = json({
      type: 'root',
      children: [{ type: 'text', text: 'see RUNBOOK now' }],
    })
    const { linked } = linkifyPlainTitleInEditorState(editorStateJSON, {
      kind: 'doc',
      targetId: 'doc-1',
      targetTitle: 'Runbook',
    })
    expect(linked).toBe(true)
  })

  it('leaves an already-linked mega-ref node untouched and does not double-link', () => {
    const editorStateJSON = json({
      type: 'root',
      children: [
        { type: 'mega-ref', version: 1, ref: { kind: 'doc', targetTitle: 'Runbook', targetId: 'doc-1' } },
      ],
    })
    const result = linkifyPlainTitleInEditorState(editorStateJSON, {
      kind: 'doc',
      targetId: 'doc-1',
      targetTitle: 'Runbook',
    })
    expect(result.linked).toBe(false)
    expect(result.editorStateJSON).toBe(editorStateJSON)
  })

  it('returns unlinked, unchanged for an empty tree (空树: no children)', () => {
    const editorStateJSON = json({ type: 'root', children: [] })
    const result = linkifyPlainTitleInEditorState(editorStateJSON, {
      kind: 'doc',
      targetId: 'doc-1',
      targetTitle: 'Runbook',
    })
    expect(result).toEqual({ editorStateJSON, linked: false })
  })

  it('returns unlinked, unchanged for malformed JSON input', () => {
    const editorStateJSON = 'not json'
    const result = linkifyPlainTitleInEditorState(editorStateJSON, {
      kind: 'doc',
      targetId: 'doc-1',
      targetTitle: 'Runbook',
    })
    expect(result).toEqual({ editorStateJSON, linked: false })
  })

  it('returns unlinked for a blank/whitespace-only title', () => {
    const editorStateJSON = json({ type: 'root', children: [{ type: 'text', text: 'hello' }] })
    const result = linkifyPlainTitleInEditorState(editorStateJSON, {
      kind: 'doc',
      targetId: 'doc-1',
      targetTitle: '   ',
    })
    expect(result).toEqual({ editorStateJSON, linked: false })
  })

  it('handles a super-long title (超长标题) that does not occur in the text', () => {
    const editorStateJSON = json({ type: 'root', children: [{ type: 'text', text: 'short text' }] })
    const result = linkifyPlainTitleInEditorState(editorStateJSON, {
      kind: 'doc',
      targetId: 'doc-1',
      targetTitle: 'X'.repeat(10000),
    })
    expect(result).toEqual({ editorStateJSON, linked: false })
  })

  it('does not drop trailing characters when lowercasing expands a Unicode char (İX regression, P2)', () => {
    // U+0130 (İ) lowercases to "i" + a combining dot above (2 UTF-16 code
    // units), so the lowercased haystack "i̇x" is longer than the original
    // "İX". A naive `slice(index + needleLower.length)` would compute the
    // wrong original offset and drop the trailing "X".
    const editorStateJSON = json({
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', text: 'İX' }] },
      ],
    })
    const { editorStateJSON: next, linked } = linkifyPlainTitleInEditorState(editorStateJSON, {
      kind: 'doc',
      targetId: 'doc-1',
      targetTitle: 'İ',
    })
    expect(linked).toBe(true)
    const parsed = JSON.parse(next)
    const textChildren = parsed.root.children[0].children
    expect(textChildren).toEqual([
      { type: 'mega-ref', version: 1, ref: { kind: 'doc', targetTitle: 'İ', targetId: 'doc-1' } },
      { type: 'text', text: 'X' },
    ])
  })

  it('consumes the full original code point when a short ASCII needle matches inside an expanded fold', () => {
    // Matching needle "i" against "İX" hits only the first lower unit of İ;
    // end must still advance past the whole İ so "İ" is not duplicated in after.
    const editorStateJSON = json({
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', text: 'İX' }] },
      ],
    })
    const { editorStateJSON: next, linked } = linkifyPlainTitleInEditorState(editorStateJSON, {
      kind: 'doc',
      targetId: 'doc-1',
      targetTitle: 'i',
    })
    expect(linked).toBe(true)
    const parsed = JSON.parse(next)
    const textChildren = parsed.root.children[0].children
    expect(textChildren.map((c: { type: string; text?: string }) => c.type + (c.text ?? ''))).toEqual([
      'mega-ref',
      'textX',
    ])
  })

  it('links only the first occurrence when the title repeats', () => {
    const editorStateJSON = json({
      type: 'root',
      children: [
        { type: 'text', text: 'Runbook and Runbook again' },
      ],
    })
    const { editorStateJSON: next } = linkifyPlainTitleInEditorState(editorStateJSON, {
      kind: 'doc',
      targetId: 'doc-1',
      targetTitle: 'Runbook',
    })
    const parsed = JSON.parse(next)
    const refCount = JSON.stringify(parsed).split('"mega-ref"').length - 1
    expect(refCount).toBe(1)
  })
})
