import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot } from 'lexical'
import { describe, expect, it } from 'vitest'
import { NODES_CORE } from './index'
import {
  $createMegaBlock,
  $isMegaBlockNode,
  createEmptyMegaDocumentEditorStateJSON,
  generateBlockId,
  MegaBlockNode,
} from './nodes-core'

function makeEditor() {
  return createHeadlessEditor({ namespace: 'test', nodes: [...NODES_CORE], onError: (error) => { throw error } })
}

describe('createEmptyMegaDocumentEditorStateJSON', () => {
  it('generates exactly 12 URL-safe characters for every new block', () => {
    const ids = Array.from({ length: 2048 }, generateBlockId)
    expect(ids.every(id => /^[A-Za-z0-9_-]{12}$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    expect(JSON.parse(createEmptyMegaDocumentEditorStateJSON()).root.children[0].blockId).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })
  it('is parseable by an editor registered with NODES_CORE', () => {
    const editor = makeEditor()
    const json = createEmptyMegaDocumentEditorStateJSON()
    const state = editor.parseEditorState(json)
    state.read(() => {
      const children = $getRoot().getChildren()
      expect(children).toHaveLength(1)
      const [block] = children
      expect($isMegaBlockNode(block)).toBe(true)
      expect((block as MegaBlockNode).getVariant()).toBe('text')
      expect((block as MegaBlockNode).getBlockId()).not.toBe('')
      expect((block as MegaBlockNode).getChildren()).toHaveLength(0)
    })
  })

  it('mints a distinct blockId on every call', () => {
    const first = JSON.parse(createEmptyMegaDocumentEditorStateJSON())
    const second = JSON.parse(createEmptyMegaDocumentEditorStateJSON())
    expect(first.root.children[0].blockId).not.toBe(second.root.children[0].blockId)
  })
})

describe('MegaBlockNode (headless editor round-trip)', () => {
  it('round-trips variant/collapsed/todoChecked/listKind through exportJSON/importJSON', () => {
    const editor = makeEditor()
    const blockId = generateBlockId()
    let serialized: unknown

    editor.update(() => {
      const node = $createMegaBlock('todo', blockId, true, true, 'bullet')
      $getRoot().append(node)
      expect($isMegaBlockNode(node)).toBe(true)
      expect(node.isInline()).toBe(false)
      serialized = node.exportJSON()
    }, { discrete: true })

    expect(serialized).toMatchObject({
      type: 'mega-block',
      version: 1,
      blockId,
      variant: 'text',
      collapsed: true,
      listKind: 'bullet',
    })

    const state = editor.getEditorState().toJSON()
    const restored = editor.parseEditorState(JSON.stringify(state))
    restored.read(() => {
      const [node] = $getRoot().getChildren()
      expect($isMegaBlockNode(node)).toBe(true)
      const block = node as MegaBlockNode
      expect(block.getBlockId()).toBe(blockId)
      expect(block.getVariant()).toBe('todo')
      expect(block.getCollapsed()).toBe(true)
      expect(block.getTodoChecked()).toBe(true)
      expect(block.getListKind()).toBe('bullet')
    })
  })

  it('$isMegaBlockNode returns false for null/undefined', () => {
    expect($isMegaBlockNode(null)).toBe(false)
    expect($isMegaBlockNode(undefined)).toBe(false)
  })
})

describe('NODES_CORE (empty tree)', () => {
  it('parses an empty root with no children without error', () => {
    const editor = makeEditor()
    const json = JSON.stringify({
      root: { children: [], direction: null, format: '', indent: 0, type: 'root', version: 1 },
    })
    const state = editor.parseEditorState(json)
    state.read(() => {
      expect($getRoot().getChildren()).toHaveLength(0)
    })
  })
})
