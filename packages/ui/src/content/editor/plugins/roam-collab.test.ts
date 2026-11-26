import { createHeadlessEditor } from '@lexical/headless'
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs'
import { $getRoot } from 'lexical'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { $createEmbedNode, $createMegaBlock, $createMegaImageNode, $createRoamTable, $isEmbedNode, $isMegaBlockNode, $setTableCellText, $tableRows, NODES_CORE } from '@megaui/content'

const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on() {}, off() {}, setLocalState() {}, setLocalStateField() {} },
  on() {}, off() {}, connect() {}, disconnect() {},
} as unknown as Provider

describe('Roam source in Lexical Yjs collaboration', () => {
  it('synchronizes TODO, table, image and embed sources between two editors', async () => {
    const docs = [new Y.Doc(), new Y.Doc()]
    const forward = (target: Y.Doc) => (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') Y.applyUpdate(target, update, 'remote')
    }
    const forwardFirst = forward(docs[1]!)
    const forwardSecond = forward(docs[0]!)
    docs[0]!.on('update', forwardFirst)
    docs[1]!.on('update', forwardSecond)
    const makeEditor = (name: string) => createHeadlessEditor({ namespace: name, nodes: [...NODES_CORE], onError: error => { throw error } })
    const first = makeEditor('roam-yjs-first')
    const second = makeEditor('roam-yjs-second')
    const cleanup: Array<() => void> = []
    for (const [index, editor] of [first, second].entries()) {
      const doc = docs[index]!
      const binding = createBinding(editor, provider, 'doc', doc, new Map([['doc', doc]]))
      const root = binding.root.getSharedType()
      const onYjs = (events: Parameters<typeof syncYjsChangesToLexical>[2], transaction: Y.Transaction) => {
        if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events, false, () => {})
      }
      root.observeDeep(onYjs)
      const unlisten = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
        syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags)
      })
      cleanup.push(() => { root.unobserveDeep(onYjs); unlisten() })
    }
    try {
      first.update(() => {
        const todo = $createMegaBlock('todo', 'abcdefghijkl')
        const { source } = $createRoamTable()
        const image = $createMegaBlock('text', 'mnopqrstuvwx')
        image.append($createMegaImageNode({ src: 'https://example.com/a.png', alt: 'a' }))
        const embed = $createMegaBlock('text', 'ABCDEFGHIJKL')
        embed.append($createEmbedNode({ targetDocId: 'doc_target', targetBlockId: 'mnopqrstuvwx' }))
        $getRoot().append(todo, source, image, embed)
      }, { discrete: true })
      await vi.waitFor(() => expect(JSON.stringify(second.getEditorState().toJSON())).toContain('{{[[embed]]: ((mnopqrstuvwx))}}'))
      const remote = JSON.stringify(second.getEditorState().toJSON())
      expect(remote).toContain('{{[[TODO]]}}')
      expect(remote).toContain('{{[[table]]}}')
      expect(remote).toContain('![a](https://example.com/a.png)')
      second.update(() => {
        const todo = $getRoot().getFirstChild()
        if (!$isMegaBlockNode(todo)) throw new Error('expected task')
        todo.setTodoChecked(true)
        const table = $getRoot().getChildren()[1]
        if (!$isMegaBlockNode(table)) throw new Error('expected table')
        $setTableCellText($tableRows(table)[0]![0]!, 'shared cell')
        const embedBlock = $getRoot().getChildren()[3]
        const embed = $isMegaBlockNode(embedBlock) ? embedBlock.getFirstChild() : null
        if (!$isEmbedNode(embed)) throw new Error('expected embed')
        embed.setEmbed({ targetDocId: 'doc_new', targetBlockId: 'ABCDEFGHIJKL' })
      }, { discrete: true })
      expect(JSON.stringify(second.getEditorState().toJSON())).toContain('{{[[DONE]]}}')
      await vi.waitFor(() => expect(JSON.stringify(first.getEditorState().toJSON())).toContain('{{[[DONE]]}}'))
      await vi.waitFor(() => expect(JSON.stringify(first.getEditorState().toJSON())).toContain('shared cell'))
      await vi.waitFor(() => expect(JSON.stringify(first.getEditorState().toJSON())).toContain('{{[[embed]]: ((ABCDEFGHIJKL))}}'))
      expect(JSON.stringify(first.getEditorState().toJSON())).toContain('"targetDocId":"doc_new"')
    } finally {
      for (const close of cleanup) close()
      docs[0]!.off('update', forwardFirst)
      docs[1]!.off('update', forwardSecond)
      docs.forEach(doc => doc.destroy())
    }
  })
})
