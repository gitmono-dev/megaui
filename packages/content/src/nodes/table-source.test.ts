import { createHeadlessEditor } from '@lexical/headless'
import { $createParagraphNode, $createTextNode, $getRoot, $isParagraphNode } from 'lexical'
import { describe, expect, it } from 'vitest'
import { NODES_CORE } from './index'
import { registerMegaContentInvariants } from './nodes-core'
import { $createOutlineTable, $isPlainTableCell, $setTableCellText, $tableCellText, $tableRows } from './table-source'

describe('outline table cell editing', () => {
  it('keeps an editable empty first-column line before the next column and through save/load', () => {
    const editor = createHeadlessEditor({ namespace: 'table-cell-test', nodes: [...NODES_CORE], onError: (error) => { throw error } })
    const unregister = registerMegaContentInvariants(editor)
    editor.update(() => {
      const { table, source } = $createOutlineTable(2, 2)
      $getRoot().append(table, source)
      for (const row of $tableRows(source)) $setTableCellText(row[1]!, 'Second column')
    }, { discrete: true })
    editor.update(() => {
      const source = $getRoot().getChildren()[1] as ReturnType<typeof $createOutlineTable>['source']
      for (const [first, second] of $tableRows(source)) {
        expect($isParagraphNode(first!.getFirstChild())).toBe(true)
        expect($isPlainTableCell(first!)).toBe(true)
        $setTableCellText(first!, 'First column')
        expect($tableCellText(first!)).toBe('First column')
        $setTableCellText(first!, '')
        expect($tableCellText(first!)).toBe('')
        expect($isParagraphNode(first!.getFirstChild())).toBe(true)
        expect($tableCellText(second!)).toBe('Second column')
      }
    }, { discrete: true })
    editor.parseEditorState(JSON.stringify(editor.getEditorState().toJSON())).read(() => {
      const source = $getRoot().getChildren()[1] as ReturnType<typeof $createOutlineTable>['source']
      expect($tableRows(source).map((row) => row.map($tableCellText))).toEqual([['', 'Second column'], ['', 'Second column']])
    })
    unregister()
  })

  it('accepts a single plain paragraph but keeps mixed formatting protected', () => {
    const editor = createHeadlessEditor({ namespace: 'table-cell-format', nodes: [...NODES_CORE], onError: (error) => { throw error } })
    editor.update(() => {
      const { source, firstCell } = $createOutlineTable()
      $getRoot().append(source)
      const paragraph = $createParagraphNode().append($createTextNode('Plain'))
      firstCell.getFirstChild()!.insertBefore(paragraph)
      expect($isPlainTableCell(firstCell)).toBe(true)
      paragraph.append($createTextNode('Bold').toggleFormat('bold'))
      expect($isPlainTableCell(firstCell)).toBe(false)
    }, { discrete: true })
  })
})
