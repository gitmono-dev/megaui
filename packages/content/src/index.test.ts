import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot } from 'lexical'
import { describe, expect, it } from 'vitest'
import { $isBlockRefNode, $isEmbedNode, $isRefNode, NODES_CORE, RoamMacroNode } from './index'

describe('@megaui/content package entrypoint', () => {
  it('is importable in a node environment (no DOM globals required)', () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined')
    // Four decorators, six Mega block/macro nodes and five Lexical support nodes.
    expect(NODES_CORE).toHaveLength(15)
    expect(NODES_CORE).toContain(RoamMacroNode)
  })

  it('registers all nodes-core classes on a single headless editor', () => {
    const editor = createHeadlessEditor({ namespace: 'test', nodes: [...NODES_CORE], onError: (error) => { throw error } })
    editor.update(() => {
      const root = $getRoot()
      expect(root.getChildrenSize()).toBe(0) // 空树: freshly created editor state
      const [node] = root.getChildren()
      expect($isRefNode(node)).toBe(false)
      expect($isEmbedNode(node)).toBe(false)
      expect($isBlockRefNode(node)).toBe(false)
    }, { discrete: true })
  })
})
