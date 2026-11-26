// @vitest-environment happy-dom
import React, { useEffect } from 'react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { $createTextNode, $getRoot, PASTE_COMMAND, type LexicalEditor } from 'lexical'
import { afterEach, expect, it, vi } from 'vitest'
import { $createMegaBlock } from '@megaui/content'
import { getContentPresetConfig } from '../preset'
import { BlockEmbedPastePlugin } from './block-embed-paste'

afterEach(cleanup)

it('resolves typed block and page embed macros without changing the source', async () => {
  let editor!: LexicalEditor
  function Capture() {
    const [value] = useLexicalComposerContext()
    useEffect(() => { editor = value }, [value])
    return null
  }
  const resolve = vi.fn(async (target: { kind: 'block'; blockId: string } | { kind: 'page'; title: string }) =>
    target.kind === 'block' ? { targetDocId: 'doc_other', targetBlockId: target.blockId } : { targetDocId: 'doc_page', label: target.title })
  render(<LexicalComposer initialConfig={{ namespace: 'roam-embed-input', nodes: getContentPresetConfig('document').nodes, onError: error => { throw error } }}>
    <BlockEmbedPastePlugin currentDocId="doc_current" resolve={resolve} />
    <Capture />
  </LexicalComposer>)
  act(() => editor.update(() => {
    $getRoot().clear().append(
      $createMegaBlock('text', 'abcdefghijkl').append($createTextNode('{{[[embed]]: ((mnopqrstuvwx))}}')),
      $createMegaBlock('text', 'ABCDEFGHIJKL').append($createTextNode('{{[[embed]]: [[Project]]}}')),
    )
  }, { discrete: true }))
  await waitFor(() => {
    const json = JSON.stringify(editor.getEditorState().toJSON())
    expect(json).toContain('"targetDocId":"doc_other"')
    expect(json).toContain('"targetDocId":"doc_page"')
    expect(json).toContain('{{[[embed]]: ((mnopqrstuvwx))}}')
    expect(json).toContain('{{[[embed]]: [[Project]]}}')
  })
  act(() => editor.update(() => {
    const block = $createMegaBlock('text', 'ABCDEFGHIJ01')
    $getRoot().append(block)
    block.selectStart()
  }, { discrete: true }))
  const event = new ClipboardEvent('paste')
  Object.defineProperty(event, 'clipboardData', { value: {
    getData: (type: string) => type === 'text/plain' ? '{{[[embed]]: ((zyxwvutsrqpo))}}' : '',
  } })
  act(() => { editor.dispatchCommand(PASTE_COMMAND, event) })
  await waitFor(() => {
    const json = JSON.stringify(editor.getEditorState().toJSON())
    expect(json).toContain('"text":"{{[[embed]]: ((zyxwvutsrqpo))}}","targetDocId":"doc_other"')
  })
})
