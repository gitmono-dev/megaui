import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot, type LexicalNode } from 'lexical'
import { describe, expect, it } from 'vitest'
import {
  $createBlockRefNode,
  $isBlockRefNode,
  BlockRefNode,
  blockRefExportContract,
  blockRefHref,
  type BlockRefValue,
} from './block-ref-node'

describe('blockRefHref', () => {
  it('builds a doc+block query href', () => {
    expect(blockRefHref({ targetDocId: 'doc-1', targetBlockId: 'block-1', label: 'x' }, '/workspace')).toBe(
      '/workspace/docs/doc-1?block=block-1',
    )
  })
})

describe('blockRefExportContract', () => {
  const ok: BlockRefValue = { targetDocId: 'doc-1', targetBlockId: 'block-1', label: 'A summary' }

  it('resolves an ok block ref to an anchor', () => {
    const contract = blockRefExportContract(ok, { workspaceBase: '/workspace' })
    expect(contract).toMatchObject({ megaContent: 'block-ref', href: '/workspace/docs/doc-1?block=block-1', text: 'A summary' })
  })

  it('reports forbidden status with the forbidden label override', () => {
    const contract = blockRefExportContract({ ...ok, status: 'forbidden' }, { workspaceBase: '/workspace', forbiddenLabel: 'No access' })
    expect(contract.megaContent).toBe('block-ref-forbidden')
    expect(contract.text).toBe('No access')
    expect(contract.href).toBeUndefined()
  })

  it('reports unresolved status with the unresolved label override', () => {
    const contract = blockRefExportContract({ ...ok, status: 'unresolved' }, { workspaceBase: '/workspace', unresolvedLabel: 'Missing' })
    expect(contract.megaContent).toBe('block-ref-unresolved')
    expect(contract.text).toBe('Missing')
    expect(contract.href).toBeUndefined()
  })

  it('infers unresolved when targetDocId/targetBlockId is empty (非规则 slug), even with no explicit status', () => {
    const contract = blockRefExportContract({ targetDocId: '', targetBlockId: '', label: 'x' }, { workspaceBase: '/workspace' })
    expect(contract.megaContent).toBe('block-ref-unresolved')
  })

  it('infers ok when both ids are present and no explicit status is set', () => {
    const contract = blockRefExportContract(ok, { workspaceBase: '/workspace' })
    expect(contract.megaContent).toBe('block-ref')
  })
})

function findBlockRefNode(root: LexicalNode): BlockRefNode | null {
  if ($isBlockRefNode(root)) return root
  const children =
    'getChildren' in root && typeof (root as { getChildren: unknown }).getChildren === 'function'
      ? (root as unknown as { getChildren: () => LexicalNode[] }).getChildren()
      : []
  for (const child of children) {
    const found = findBlockRefNode(child)
    if (found) return found
  }
  return null
}

describe('BlockRefNode (headless editor)', () => {
  function makeEditor() {
    return createHeadlessEditor({ namespace: 'test', nodes: [BlockRefNode], onError: (error) => { throw error } })
  }

  it.each(['document', 'search'] as const)('round-trips %s binding through exportJSON/importJSON', (binding) => {
    const editor = makeEditor()
    const blockRef: BlockRefValue = { targetDocId: 'doc-1', targetBlockId: 'block-1', label: 'A summary', sourcePath: 'Doc › Section', binding }
    let serialized: unknown

    editor.update(() => {
      const node = $createBlockRefNode(blockRef)
      $getRoot().append(node)
      expect($isBlockRefNode(node)).toBe(true)
      expect(node.isInline()).toBe(true)
      serialized = node.exportJSON()
    }, { discrete: true })

    expect(serialized).toEqual({ type: 'mega-block-ref', version: 1, blockRef })

    const state = editor.getEditorState().toJSON()
    const restored = editor.parseEditorState(JSON.stringify(state))
    restored.read(() => {
      const found = findBlockRefNode($getRoot())
      expect($isBlockRefNode(found)).toBe(true)
      expect(found!.getBlockRef()).toEqual(blockRef)
      expect(found!.getTextContent()).toBe('A summary')
    })
  })

  it('setBlockRef returns a writable clone with the updated value', () => {
    const editor = makeEditor()
    editor.update(() => {
      const node = $createBlockRefNode({ targetDocId: 'doc-1', targetBlockId: 'block-1', label: 'old' })
      const updated = node.setBlockRef({ targetDocId: 'doc-1', targetBlockId: 'block-1', label: 'new' })
      expect(updated.getBlockRef().label).toBe('new')
    }, { discrete: true })
  })

  it('$isBlockRefNode returns false for null/undefined', () => {
    expect($isBlockRefNode(null)).toBe(false)
    expect($isBlockRefNode(undefined)).toBe(false)
  })
})
