import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot, type LexicalNode } from 'lexical'
import { describe, expect, it } from 'vitest'
import { $createRefNode, $isRefNode, RefNode, refExportContract, type RefNodeValue } from './ref-node'

describe('refExportContract', () => {
  it('renders a resolved doc ref as an anchor', () => {
    const contract = refExportContract(
      { kind: 'doc', targetTitle: 'Runbook', targetId: 'doc-1' },
      { workspaceBase: '/en/workspace' },
    )
    expect(contract).toEqual({ tagName: 'a', megaContent: 'ref', kind: 'doc', href: '/en/workspace/docs/doc-1', text: '[[Runbook]]' })
  })

  it('renders an unresolved ref (no targetId) as a create button', () => {
    const contract = refExportContract({ kind: 'doc', targetTitle: 'New Page' }, { workspaceBase: '/workspace' })
    expect(contract).toEqual({ tagName: 'button', megaContent: 'ref-unresolved', kind: 'doc', text: '[[New Page]]' })
  })

  it('formats the create label template when provided', () => {
    const contract = refExportContract(
      { kind: 'doc', targetTitle: 'New Page' },
      { workspaceBase: '/workspace', createLabel: 'Create "{title}"' },
    )
    expect(contract.text).toBe('Create "New Page"')
  })

  it('prefers a live titleById override over the stored targetTitle', () => {
    const contract = refExportContract(
      { kind: 'doc', targetTitle: 'Stale Title', targetId: 'doc-1' },
      { workspaceBase: '/workspace', titleById: { 'doc-1': 'Fresh Title' } },
    )
    expect(contract.text).toBe('[[Fresh Title]]')
  })

  it('keeps legacy tag text compatible with its external hash', () => {
    const contract = refExportContract(
      { kind: 'doc', notation: 'tag', targetTitle: 'Planning', targetId: 'doc-1' },
      { workspaceBase: '/workspace' },
    )
    expect(contract.text).toBe('Planning')
  })

  it.each(['doc-1', undefined])('renders a complete inline tag with target %s', (targetId) => {
    const ref: RefNodeValue = { kind: 'doc', notation: 'tag', tagPrefix: 'inline', targetTitle: 'Planning', targetId }
    expect(refExportContract(ref, { workspaceBase: '/workspace', createLabel: 'Create {title}' }).text).toBe('#Planning')
  })

  it.each([
    ['issue', '7', '/workspace/issues/7'],
    ['cl', '12', '/workspace/cls/12'],
    ['user', 'octocat', '/workspace/dm/octocat'],
  ] as const)('resolves an href for kind=%s', (kind, targetId, href) => {
    const contract = refExportContract({ kind, targetTitle: 'x', targetId }, { workspaceBase: '/workspace' })
    expect(contract).toMatchObject({ megaContent: 'ref', href })
  })

  it('resolves a block ref to a docs-scoped fragment', () => {
    const contract = refExportContract({ kind: 'block', targetTitle: 'x', targetId: 'block-1' }, { workspaceBase: '/workspace' })
    expect(contract.href).toBe('/workspace/docs/block-1#block')
  })

  it('falls back to a span when an issue/cl targetId is non-numeric (非规则 slug)', () => {
    const contract = refExportContract({ kind: 'issue', targetTitle: 'x', targetId: 'not-a-number' }, { workspaceBase: '/workspace' })
    expect(contract).toMatchObject({ tagName: 'span', megaContent: 'ref', href: undefined })
  })

  it('trims a trailing slash from workspaceBase', () => {
    const contract = refExportContract({ kind: 'doc', targetTitle: 'x', targetId: 'd1' }, { workspaceBase: '/workspace/' })
    expect(contract.href).toBe('/workspace/docs/d1')
  })

  it('handles a super-long title (超长标题)', () => {
    const longTitle = 'T'.repeat(4000)
    const contract = refExportContract({ kind: 'doc', targetTitle: longTitle }, { workspaceBase: '/workspace' })
    expect(contract.text).toBe(`[[${longTitle}]]`)
  })
})

function findRefNode(root: LexicalNode): RefNode | null {
  if ($isRefNode(root)) return root
  const children =
    'getChildren' in root && typeof (root as { getChildren: unknown }).getChildren === 'function'
      ? (root as unknown as { getChildren: () => LexicalNode[] }).getChildren()
      : []
  for (const child of children) {
    const found = findRefNode(child)
    if (found) return found
  }
  return null
}

describe('RefNode (headless editor)', () => {
  function makeEditor() {
    return createHeadlessEditor({ namespace: 'test', nodes: [RefNode], onError: (error) => { throw error } })
  }

  it('round-trips through exportJSON/importJSON with $createRefNode/$isRefNode', () => {
    const editor = makeEditor()
    const ref: RefNodeValue = { kind: 'doc', targetTitle: 'Runbook', targetId: 'doc-1' }
    let serialized: unknown

    editor.update(() => {
      const node = $createRefNode(ref)
      $getRoot().append(node)
      expect($isRefNode(node)).toBe(true)
      serialized = node.exportJSON()
    }, { discrete: true })

    expect(serialized).toEqual({
      type: 'mega-ref',
      version: 1,
      ref,
    })

    const state = editor.getEditorState().toJSON()
    const restored = editor.parseEditorState(JSON.stringify(state))
    restored.read(() => {
      // Inline DecoratorNodes may sit under a paragraph after parse; walk the tree.
      const found = findRefNode($getRoot())
      expect($isRefNode(found)).toBe(true)
      expect(found!.getRef()).toEqual(ref)
      expect(found!.getTextContent()).toBe('[[Runbook]]')
      expect(found!.isInline()).toBe(true)
    })
  })

  it('getRef/setRef roundtrip inside an update', () => {
    const editor = makeEditor()
    editor.update(() => {
      const node = $createRefNode({ kind: 'issue', targetTitle: 'Bug', targetId: '7' })
      const updated = node.setRef({ kind: 'issue', targetTitle: 'Bug (renamed)', targetId: '7' })
      expect(updated.getRef().targetTitle).toBe('Bug (renamed)')
    }, { discrete: true })
  })

  it('$isRefNode returns false for null/undefined/other nodes', () => {
    expect($isRefNode(null)).toBe(false)
    expect($isRefNode(undefined)).toBe(false)
  })
})
