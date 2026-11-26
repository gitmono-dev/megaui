import { describe, expect, it } from 'vitest'
import { extractBlocksFromEditorState } from './blocks'
import { extractEmbedsFromEditorState } from './embed'
import { extractRefsFromEditorState } from './links'
import { validateDocBodyJson } from './validation'

const block = (children: unknown[]) => ({
  type: 'mega-block', version: 1, blockId: 'abcdefghijkl', variant: 'text', collapsed: false,
  children, direction: null, format: '', indent: 0,
})
const body = (children: unknown[]) => JSON.stringify({ root: { type: 'root', version: 1, children: [block(children)] } })

describe('Roam document source indexes and validation', () => {
  it('indexes a TODO macro as a task', () => {
    const json = body([{ type: 'mega-roam-macro', version: 1, text: '{{[[TODO]]}}' }])
    expect(() => validateDocBodyJson(json)).not.toThrow()
    expect(extractBlocksFromEditorState(json)[0]?.variant).toBe('todo')
  })

  it('indexes macro embeds and preserves the target for cycle detection', () => {
    const json = body([{ type: 'mega-embed', version: 1, text: '{{[[embed]]: ((mnopqrstuvwx))}}', targetDocId: 'doc_target' }])
    expect(() => validateDocBodyJson(json)).not.toThrow()
    expect(extractEmbedsFromEditorState(json)).toEqual([{ targetDocId: 'doc_target', targetBlockId: 'mnopqrstuvwx' }])
    expect(extractRefsFromEditorState(json)).toEqual([expect.objectContaining({ targetId: 'doc_target:mnopqrstuvwx' })])
  })

  it('accepts safe image markdown and rejects unsafe image and unsupported macro sources', () => {
    expect(() => validateDocBodyJson(body([{ type: 'mega-image', version: 1, text: '![chart](https://example.com/chart.png)' }]))).not.toThrow()
    expect(() => validateDocBodyJson(body([{ type: 'mega-image', version: 1, text: '![x](javascript:alert(1))' }]))).toThrow()
    expect(() => validateDocBodyJson(body([{ type: 'mega-roam-macro', version: 1, text: '{{[[unknown]]}}' }]))).toThrow()
  })
})
