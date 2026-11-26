import { createHeadlessEditor } from '@lexical/headless'
import { $createTextNode, $getRoot } from 'lexical'
import { describe, expect, it } from 'vitest'
import { $createMegaBlock, NODES_CORE } from '@megaui/content'
import { $convertRoamSyntax } from './roam-syntax'
import { EditorImageNode } from '../image-node'

describe('Roam source input', () => {
  it.each([
    ['{{[[TODO]]}} Work', false],
    ['{{[[DONE]]}} Work', true],
  ])('converts %s into an editable task with the same source', (source, checked) => {
    const editor = createHeadlessEditor({ namespace: 'roam-input', nodes: [...NODES_CORE], onError: e => { throw e } })
    editor.update(() => {
      const block = $createMegaBlock('text', 'abcdefghijkl')
      const text = $createTextNode(source)
      block.append(text)
      $getRoot().append(block)
      expect($convertRoamSyntax(text)).toBe(true)
      expect(block.getVariant()).toBe('todo')
      expect(block.getTodoChecked()).toBe(checked)
      expect(block.getTextContent()).toBe('Work')
    }, { discrete: true })
    const state = editor.getEditorState().toJSON()
    expect(JSON.stringify(state)).toContain(checked ? '{{[[DONE]]}}' : '{{[[TODO]]}}')
  })
  it('turns the table macro into a table backed by nested blocks', () => {
    const editor = createHeadlessEditor({ namespace: 'roam-table-input', nodes: [...NODES_CORE], onError: e => { throw e } })
    editor.update(() => {
      const block = $createMegaBlock('text', 'abcdefghijkl')
      const text = $createTextNode('{{[[table]]}}')
      block.append(text)
      $getRoot().append(block)
      expect($convertRoamSyntax(text)).toBe(true)
      expect(block.getTableSource()).toBe(true)
      expect(block.getChildren().filter(child => child.getType() === 'mega-block')).toHaveLength(2)
    }, { discrete: true })
    const json = JSON.stringify(editor.getEditorState().toJSON())
    expect(json).toContain('{{[[table]]}}')
    expect(json).not.toContain('"type":"mega-outline-table"')
  })
  it('renders a complete image source as an image with the same Markdown source', () => {
    const editor = createHeadlessEditor({
      namespace: 'roam-image-input',
      nodes: NODES_CORE.map(node => node.getType() === 'mega-image' ? EditorImageNode : node),
      onError: e => { throw e },
    })
    editor.update(() => {
      const block = $createMegaBlock('text', 'abcdefghijkl')
      const text = $createTextNode('![chart](https://example.com/chart.png)')
      block.append(text)
      $getRoot().append(block)
      expect($convertRoamSyntax(text)).toBe(true)
    }, { discrete: true })
    expect(JSON.stringify(editor.getEditorState().toJSON())).toContain('![chart](https://example.com/chart.png)')
    expect(JSON.stringify(editor.getEditorState().toJSON())).toContain('"type":"mega-image"')
  })
})
