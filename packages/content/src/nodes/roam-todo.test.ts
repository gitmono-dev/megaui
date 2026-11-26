import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot } from 'lexical'
import { describe, expect, it } from 'vitest'
import { NODES_CORE } from './index'
import { $createMegaBlock, $isMegaBlockNode } from './nodes-core'

describe('Roam TODO source', () => {
  it('stores and restores the macro, and toggles it to DONE', () => {
    const editor = createHeadlessEditor({ namespace: 'roam-todo', nodes: [...NODES_CORE], onError: error => { throw error } })
    editor.update(() => {
      $getRoot().append($createMegaBlock('todo', 'abcdefghijkl'))
    }, { discrete: true })

    const todo = editor.getEditorState().toJSON()
    expect(todo.root.children[0]).toMatchObject({
      variant: 'text',
      children: [{ type: 'mega-roam-macro', text: '{{[[TODO]]}}' }],
    })
    expect(todo.root.children[0]).not.toHaveProperty('todoChecked')

    editor.setEditorState(editor.parseEditorState(JSON.stringify(todo)))
    editor.update(() => {
      const block = $getRoot().getFirstChild()
      if (!$isMegaBlockNode(block)) throw new Error('expected block')
      expect(block.getVariant()).toBe('todo')
      block.setTodoChecked(true)
    }, { discrete: true })
    expect(editor.getEditorState().toJSON().root.children[0]).toMatchObject({
      children: [{ type: 'mega-roam-macro', text: '{{[[DONE]]}}' }],
    })
  })

  it('keeps the table macro when a table block is also marked as a TODO', () => {
    const editor = createHeadlessEditor({ namespace: 'roam-todo-table', nodes: [...NODES_CORE], onError: error => { throw error } })
    editor.update(() => {
      const block = $createMegaBlock('text', 'abcdefghijkl', false, false, null, true)
      $getRoot().append(block)
      block.setVariant('todo').setTodoChecked(true)
      expect(block.getVariant()).toBe('todo')
      expect(block.getTableSource()).toBe(true)
      block.setVariant('text')
      expect(block.getTableSource()).toBe(true)
    }, { discrete: true })
  })
})
