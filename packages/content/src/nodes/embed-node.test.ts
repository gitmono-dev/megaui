import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot } from 'lexical'
import { describe, expect, it } from 'vitest'
import { $createEmbedNode, $isEmbedNode, EmbedNode, embedExportContract, embedHref, type EmbedValue } from './embed-node'

describe('embedHref', () => {
  it('builds a page-embed href', () => {
    expect(embedHref({ targetDocId: 'doc-1' }, '/en/workspace')).toBe('/en/workspace/docs/doc-1')
  })

  it('builds a block-embed href with a ?block= query param', () => {
    expect(embedHref({ targetDocId: 'doc-1', targetBlockId: 'block-1' }, '/workspace')).toBe('/workspace/docs/doc-1?block=block-1')
  })

  it('trims a trailing slash from workspaceBase', () => {
    expect(embedHref({ targetDocId: 'doc-1' }, '/workspace/')).toBe('/workspace/docs/doc-1')
  })

  it('encodes a non-规则 (irregular) doc id', () => {
    expect(embedHref({ targetDocId: 'doc/weird id' }, '/workspace')).toBe('/workspace/docs/doc%2Fweird%20id')
  })
})

describe('embedExportContract', () => {
  it('reports a page embed when there is no targetBlockId', () => {
    const contract = embedExportContract({ targetDocId: 'doc-1' }, { workspaceBase: '/workspace' })
    expect(contract).toMatchObject({ megaContent: 'embed-page', href: '/workspace/docs/doc-1', text: 'doc-1' })
  })

  it('reports a block embed when targetBlockId is set', () => {
    const contract = embedExportContract({ targetDocId: 'doc-1', targetBlockId: 'block-1' }, { workspaceBase: '/workspace' })
    expect(contract.megaContent).toBe('embed-block')
  })

  it('prefers the label over the docId for display text', () => {
    const contract = embedExportContract({ targetDocId: 'doc-1', label: 'My Embed' }, { workspaceBase: '/workspace' })
    expect(contract.text).toBe('My Embed')
  })
})

describe('EmbedNode (headless editor)', () => {
  function makeEditor() {
    return createHeadlessEditor({ namespace: 'test', nodes: [EmbedNode], onError: (error) => { throw error } })
  }

  it('round-trips through exportJSON/importJSON', () => {
    const editor = makeEditor()
    const embed: EmbedValue = { targetDocId: 'doc-1', targetBlockId: 'block-1', label: 'My Embed' }
    let serialized: unknown

    editor.update(() => {
      const node = $createEmbedNode(embed)
      $getRoot().append(node)
      expect($isEmbedNode(node)).toBe(true)
      expect(node.isInline()).toBe(false)
      serialized = node.exportJSON()
    }, { discrete: true })

    expect(serialized).toEqual({ type: 'mega-embed', version: 1, embed })

    const state = editor.getEditorState().toJSON()
    const restored = editor.parseEditorState(JSON.stringify(state))
    restored.read(() => {
      const [node] = $getRoot().getChildren()
      expect($isEmbedNode(node)).toBe(true)
      expect((node as EmbedNode).getEmbed()).toEqual(embed)
      expect((node as EmbedNode).getTextContent()).toBe('My Embed')
    })
  })

  it('getTextContent falls back to targetDocId when there is no label', () => {
    const editor = makeEditor()
    editor.update(() => {
      const node = $createEmbedNode({ targetDocId: 'doc-2' })
      expect(node.getTextContent()).toBe('doc-2')
    }, { discrete: true })
  })

  it('$isEmbedNode returns false for null/undefined', () => {
    expect($isEmbedNode(null)).toBe(false)
    expect($isEmbedNode(undefined)).toBe(false)
  })
})
