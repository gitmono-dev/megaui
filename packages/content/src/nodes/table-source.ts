import { $createTextNode, $getRoot, $isParagraphNode, $isTextNode, type LexicalNode } from 'lexical'
import {
  $createMegaBlock,
  $createMegaOutlineTable,
  $isMegaBlockNode,
  generateBlockId,
  type MegaBlockNode,
  type MegaOutlineTableNode,
} from './nodes-core'

/** A table view points at ordinary nested outliner blocks; no cell text is copied. */
export function $createOutlineTable(
  rows = 2,
  columns = 2,
  createTable: (blockId: string, sourceBlockId: string) => MegaOutlineTableNode = $createMegaOutlineTable,
): {
  table: MegaOutlineTableNode
  source: MegaBlockNode
  firstCell: MegaBlockNode
} {
  const source = $createMegaBlock('text', generateBlockId(), false, false, null, true)
  const table = createTable(generateBlockId(), source.getBlockId())
  let firstCell: MegaBlockNode | null = null
  for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
    const row = $createMegaBlock('text', generateBlockId())
    firstCell ??= row
    source.append(row)
    let cell = row
    for (let columnIndex = 1; columnIndex < columns; columnIndex++) {
      const next = $createMegaBlock('text', generateBlockId())
      cell.append(next)
      cell = next
    }
  }
  if (!firstCell) {
    firstCell = $createMegaBlock('text', generateBlockId())
    source.append(firstCell)
  }
  return { table, source, firstCell }
}

export function $findMegaBlockById(blockId: string, nodes: readonly LexicalNode[] = $getRoot().getChildren()): MegaBlockNode | null {
  for (const node of nodes) {
    if (!$isMegaBlockNode(node)) continue
    if (node.getBlockId() === blockId) return node
    const nested = $findMegaBlockById(blockId, node.getChildren())
    if (nested) return nested
  }
  return null
}

export function $tableRows(source: MegaBlockNode): MegaBlockNode[][] {
  return source.getChildren().filter($isMegaBlockNode).map((row) => {
    const cells = [row]
    let cell = row
    while (cells.length < 32) {
      const next = cell.getChildren().find($isMegaBlockNode)
      if (!next) break
      cells.push(next)
      cell = next
    }
    return cells
  })
}

export function $tableCellText(cell: MegaBlockNode): string {
  return cell.getChildren().filter((child) => !$isMegaBlockNode(child)).map((child) => child.getTextContent()).join('')
}

/** Complex inline nodes remain editable in the outliner, where their formatting is preserved. */
export function $isPlainTableCell(cell: MegaBlockNode): boolean {
  const inline = cell.getChildren().filter((child) => !$isMegaBlockNode(child))
  if (inline.length === 1 && $isParagraphNode(inline[0])) {
    const children = inline[0].getChildren()
    return children.length <= 1 && children.every($isTextNode)
  }
  return inline.length <= 1 && inline.every($isTextNode)
}

/** Edit the cell's inline text while keeping its nested column blocks. */
export function $setTableCellText(cell: MegaBlockNode, value: string): void {
  const inline = cell.getChildren().filter((child) => !$isMegaBlockNode(child))
  if (inline.length === 1 && $isParagraphNode(inline[0])) {
    const paragraph = inline[0]
    const children = paragraph.getChildren()
    if (children.length === 1 && $isTextNode(children[0])) children[0].setTextContent(value)
    else {
      paragraph.clear()
      if (value) paragraph.append($createTextNode(value))
    }
    return
  }
  if (inline.length === 1 && $isTextNode(inline[0])) {
    inline[0].setTextContent(value)
    return
  }
  for (const child of inline) child.remove()
  if (!value) return
  const text = $createTextNode(value)
  const firstNested = cell.getChildren().find($isMegaBlockNode)
  if (firstNested) firstNested.insertBefore(text)
  else cell.append(text)
}

export function $ensureTableCell(row: MegaBlockNode, column: number): MegaBlockNode {
  let cell = row
  for (let index = 0; index < column; index++) {
    let next = cell.getChildren().find($isMegaBlockNode)
    if (!next) {
      next = $createMegaBlock('text', generateBlockId())
      cell.append(next)
    }
    cell = next
  }
  return cell
}
