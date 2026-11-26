'use client'

import { useEffect } from 'react'
import { $getEditor, TextNode } from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createMegaBlock, $isMegaBlockNode, generateBlockId } from '@megaui/content'
import { requestNewTableFocus } from './outline-table'
import { $createEditorImageNode } from '../image-node'
import { $selectFollowingMegaBlock } from '../commands'
import { parseRoamImage } from './images'

/** Convert completed source at the start of an outline block into its live component. */
export function $convertRoamSyntax(node: TextNode): boolean {
  const parent = node.getParent()
  if (!$isMegaBlockNode(parent) || node.getPreviousSibling() || parent.getVariant() !== 'text') return false
  const text = node.getTextContent()
  const image = parseRoamImage(text)
  if (image) {
    node.replace($createEditorImageNode(image))
    $selectFollowingMegaBlock(parent)
    return true
  }
  if (text === '{{[[table]]}}') {
    parent.setTableSource(true)
    node.remove()
    let first = parent.getChildren().find($isMegaBlockNode)
    if (!first) {
      for (let i = 0; i < 2; i++) {
        const row = $createMegaBlock('text', generateBlockId())
        row.append($createMegaBlock('text', generateBlockId()))
        parent.append(row)
        first ??= row
      }
    }
    if (first) {
      first.selectStart()
      requestNewTableFocus($getEditor(), parent.getBlockId(), first.getBlockId())
    }
    return true
  }
  const match = /^(\{\{\[\[(TODO|DONE)\]\]\}\})(?: ?)/.exec(text)
  if (!match) return false
  parent.setVariant('todo').setTodoChecked(match[2] === 'DONE')
  node.setTextContent(text.slice(match[0].length))
  return true
}

export function RoamSyntaxPlugin(): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => editor.registerNodeTransform(TextNode, $convertRoamSyntax), [editor])
  return null
}
