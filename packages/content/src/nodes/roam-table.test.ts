import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot } from 'lexical'
import { expect, it } from 'vitest'
import { NODES_CORE } from './index'
import { $createOutlineTable, $findMegaBlockById, $tableRows } from './table-source'

it('stores the table macro on its nested source block and restores the cells', () => {
  const editor = createHeadlessEditor({ namespace: 'roam-table', nodes: [...NODES_CORE], onError: error => { throw error } })
  let sourceId = ''
  editor.update(() => {
    const { table, source } = $createOutlineTable(2, 2)
    sourceId = source.getBlockId()
    $getRoot().append(table, source)
  }, { discrete: true })
  const state = editor.getEditorState().toJSON()
  expect((state.root.children[1] as unknown as { children: unknown[] }).children[0]).toMatchObject({ type: 'mega-roam-macro', text: '{{[[table]]}}' })
  expect(state.root.children[1]).not.toHaveProperty('tableSource')
  editor.setEditorState(editor.parseEditorState(JSON.stringify(state)))
  editor.getEditorState().read(() => {
    const source = $findMegaBlockById(sourceId)
    expect(source?.getTableSource()).toBe(true)
    expect(source && $tableRows(source).map(row => row.length)).toEqual([2, 2])
  })
})
