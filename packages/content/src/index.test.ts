import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot } from 'lexical'
import { describe, expect, it } from 'vitest'
import { $isBlockRefNode, $isEmbedNode, $isRefNode, NODES_CORE } from './index'

describe('@megaui/content package entrypoint', () => {
  it('is importable in a node environment (no DOM globals required)', () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined')
    // 4 decorator nodes (ref/embed/block-ref/image) + 5 mega block/view nodes + 5
    // @lexical/code-core / @lexical/table support nodes (MEGA_CONTENT_BLOCK_NODES).
    expect(NODES_CORE).toHaveLength(14)
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
