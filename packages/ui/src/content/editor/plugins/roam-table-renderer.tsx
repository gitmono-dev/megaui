'use client'

import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { $getRoot, $isElementNode, type LexicalNode } from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $isMegaBlockNode, $isMegaOutlineTableNode, $isRoamMacroNode } from '@megaui/content'
import { OutlineTableView } from './outline-table'

type Target = { key: string; sourceId: string; element: HTMLElement }

/** Render the table macro as a view of its own child blocks, without a saved projection node. */
export function RoamTableRenderer(): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [targets, setTargets] = useState<Target[]>([])
  useEffect(() => {
    const sync = () => {
      const next: Target[] = []
      editor.getEditorState().read(() => {
        const walk = (nodes: LexicalNode[]) => {
          for (const node of nodes) {
            if ($isRoamMacroNode(node) && node.getMacro() === '{{[[table]]}}') {
              const source = node.getParent()
              const previous = source?.getPreviousSibling()
              const hasLegacyProjection = $isMegaOutlineTableNode(previous) && $isMegaBlockNode(source)
                && previous.getSourceBlockId() === source.getBlockId()
              const element = editor.getElementByKey(node.getKey())
              if ($isMegaBlockNode(source) && element && !hasLegacyProjection) {
                next.push({ key: node.getKey(), sourceId: source.getBlockId(), element })
              }
            }
            if ($isElementNode(node)) walk(node.getChildren())
          }
        }
        walk($getRoot().getChildren())
      })
      setTargets(current => current.length === next.length && current.every((target, index) =>
        target.key === next[index]?.key && target.sourceId === next[index]?.sourceId && target.element === next[index]?.element)
        ? current : next)
    }
    sync()
    return editor.registerUpdateListener(sync)
  }, [editor])
  return <>{targets.map(target => createPortal(
    <OutlineTableView nodeKey={target.key} sourceBlockId={target.sourceId} />,
    target.element,
    target.key,
  ))}</>
}
