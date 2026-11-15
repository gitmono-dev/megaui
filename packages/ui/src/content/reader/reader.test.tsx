// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import React, { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { $getRoot, type LexicalEditor } from 'lexical'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createMegaTableBlockWithEmptyGrid, MEGA_CONTENT_BLOCK_NODES } from '@megaui/content'
import { MegaContentReader } from './reader'
import { ReaderRefNode } from './nodes'

afterEach(() => {
  cleanup()
})

function rootState(children: unknown[]): string {
  return JSON.stringify({
    root: { type: 'root', version: 1, children, direction: null, format: '', indent: 0 },
  })
}

function textChild(text: string) {
  return { type: 'text', version: 1, text, detail: 0, format: 0, mode: 'normal', style: '' }
}

function megaBlock(overrides: Record<string, unknown>) {
  return {
    type: 'mega-block',
    version: 1,
    blockId: 'b-1',
    variant: 'text',
    collapsed: false,
    todoChecked: false,
    children: [],
    direction: null,
    format: '',
    indent: 0,
    ...overrides,
  }
}

/** Builds real Lexical JSON for node types too complex to hand-write safely (tables). */
function buildStateJSON(build: (editor: LexicalEditor) => void): string {
  let captured = ''
  function Capture() {
    const [editor] = useLexicalComposerContext()
    useEffect(() => {
      editor.update(() => build(editor), { discrete: true })
      captured = JSON.stringify(editor.getEditorState().toJSON())
    }, [editor])
    return null
  }
  const { unmount } = render(
    <LexicalComposer
      initialConfig={{
        namespace: 'reader-test-builder',
        editable: true,
        nodes: [ReaderRefNode, ...MEGA_CONTENT_BLOCK_NODES],
        onError: (error) => {
          throw error
        },
      }}
    >
      <Capture />
    </LexicalComposer>,
  )
  unmount()
  return captured
}

describe('MegaContentReader block types (AC1)', () => {
  it('renders heading, quote, and text variants with data-mega-block', () => {
    const stateJSON = rootState([
      megaBlock({ blockId: 'h1', variant: 'h1', children: [textChild('Title')] }),
      megaBlock({ blockId: 'h2', variant: 'h2', children: [textChild('Subtitle')] }),
      megaBlock({ blockId: 'h3', variant: 'h3', children: [textChild('Section')] }),
      megaBlock({ blockId: 'q1', variant: 'quote', children: [textChild('A quote')] }),
      megaBlock({ blockId: 't1', variant: 'text', children: [textChild('Plain text')] }),
    ])
    const { container } = render(<MegaContentReader stateJSON={stateJSON} />)

    expect(container.querySelector('[data-mega-block="h1"]')).toHaveTextContent('Title')
    expect(container.querySelector('[data-mega-block="h2"]')).toHaveTextContent('Subtitle')
    expect(container.querySelector('[data-mega-block="h3"]')).toHaveTextContent('Section')
    expect(container.querySelector('[data-mega-block="quote"]')).toHaveTextContent('A quote')
    expect(container.querySelector('[data-mega-block="text"]')).toHaveTextContent('Plain text')
  })

  it('renders a todo block with a checkbox affordance and toggles it on click', async () => {
    const user = userEvent.setup()
    const onTodoToggle = vi.fn()
    const stateJSON = rootState([
      megaBlock({ blockId: 'todo-1', variant: 'todo', todoChecked: false, children: [textChild('Buy milk')] }),
    ])
    const { container } = render(<MegaContentReader onTodoToggle={onTodoToggle} stateJSON={stateJSON} />)

    const block = container.querySelector('[data-mega-block="todo"]')
    expect(block).toHaveAttribute('data-todo-checked', 'false')
    // Rendered in the overlay layer (sibling of the editable root), not nested
    // inside the block: Lexical's mutation observer reverts foreign children
    // inserted into its managed subtree, so the checkbox lives outside it.
    const checkbox = container.querySelector('[data-mega-content="todo-check"]')
    expect(checkbox).not.toBeNull()

    await user.click(checkbox!)

    expect(onTodoToggle).toHaveBeenCalledWith('todo-1', true)
    expect(block).toHaveAttribute('data-todo-checked', 'true')
  })

  it('renders nested list markers via data-list-kind', () => {
    const stateJSON = rootState([
      megaBlock({ blockId: 'li-1', variant: 'text', listKind: 'bullet', children: [textChild('Item one')] }),
    ])
    const { container } = render(<MegaContentReader stateJSON={stateJSON} />)
    expect(container.querySelector('[data-list-kind="bullet"]')).toHaveTextContent('Item one')
  })

  it('renders a horizontal rule block', () => {
    const stateJSON = rootState([
      { type: 'mega-hr-block', version: 1, blockId: 'hr-1', direction: null, format: '', indent: 0, children: [] },
      megaBlock({ blockId: 'after', children: [textChild('after')] }),
    ])
    const { container } = render(<MegaContentReader stateJSON={stateJSON} />)
    const hr = container.querySelector('hr[data-block-id="hr-1"]')
    expect(hr).not.toBeNull()
  })

  it('renders a table block (@lexical/table) inside a mega-table-block container', () => {
    const stateJSON = buildStateJSON(() => {
      const table = $createMegaTableBlockWithEmptyGrid('table-1')
      $getRoot().clear().append(table)
    })
    const { container } = render(<MegaContentReader stateJSON={stateJSON} />)
    const tableContainer = container.querySelector('[data-mega-table-block="true"][data-block-id="table-1"]')
    expect(tableContainer).not.toBeNull()
    expect(tableContainer!.querySelector('table')).not.toBeNull()
  })

  it('renders an outline-backed table from the same serialized cell blocks', async () => {
    const user = userEvent.setup()
    const onCollapsedChange = vi.fn()
    const stateJSON = rootState([
      { type: 'mega-outline-table', version: 1, blockId: 'view-1', sourceBlockId: 'source-1' },
      megaBlock({ blockId: 'source-1', tableSource: true, children: [
        megaBlock({ blockId: 'row-1', children: [textChild('Header'), megaBlock({ blockId: 'cell-2', children: [textChild('Value')] })] }),
      ] }),
    ])
    const { container } = render(<MegaContentReader stateJSON={stateJSON} onCollapsedChange={onCollapsedChange} />)
    await waitFor(() => expect(container.querySelectorAll('[data-mega-outline-table] td')).toHaveLength(2))
    expect(container.querySelector('[data-mega-outline-table]')).toHaveTextContent('Header')
    expect(container.querySelector('[data-mega-outline-table]')).toHaveTextContent('Value')
    const toggle = container.querySelector<HTMLButtonElement>('[data-table-outline="true"]')
    expect(toggle).toBeInTheDocument()
    await user.click(toggle!)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('[data-mega-table-source]')).toHaveAttribute('data-collapsed', 'true')
    expect(onCollapsedChange).toHaveBeenLastCalledWith('source-1', true)
    await user.click(toggle!)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(onCollapsedChange).toHaveBeenLastCalledWith('source-1', false)
  })

  it('syntax-highlights a code block via Shiki (代码块高亮)', async () => {
    const stateJSON = rootState([
      {
        type: 'mega-code-block',
        version: 1,
        blockId: 'code-1',
        language: 'typescript',
        direction: null,
        format: '',
        indent: 0,
        children: [textChild('const x = 1;')],
      },
    ])
    const { container } = render(<MegaContentReader stateJSON={stateJSON} />)

    await waitFor(() => {
      expect(container.querySelectorAll('span[style]').length).toBeGreaterThan(0)
    })
  })

  it('collapses/expands a block with nested children on toggle click', async () => {
    const user = userEvent.setup()
    const onCollapsedChange = vi.fn()
    const stateJSON = rootState([
      megaBlock({
        blockId: 'parent',
        children: [
          textChild('Parent'),
          megaBlock({ blockId: 'child', children: [textChild('Child')] }),
        ],
      }),
    ])
    const { container } = render(<MegaContentReader onCollapsedChange={onCollapsedChange} stateJSON={stateJSON} />)

    // Overlay layer again (see the todo-toggle test above for why).
    const toggle = container.querySelector('[data-mega-content="collapse-toggle"]')
    expect(toggle).not.toBeNull()
    await user.click(toggle!)

    expect(onCollapsedChange).toHaveBeenCalledWith('parent', true)
    expect(container.querySelector('[data-block-id="parent"]')).toHaveAttribute('data-collapsed', 'true')
    expect(screen.getByText('Parent')).toBeVisible()
    expect(screen.getByText('Child')).not.toBeVisible()
    await user.click(toggle!)
    expect(screen.getByText('Child')).toBeVisible()
  })
})

describe('MegaContentReader wiki links (AC2)', () => {
  it('renders a resolved wiki link as a navigable anchor (exists)', () => {
    const stateJSON = rootState([
      megaBlock({
        blockId: 'p1',
        children: [
          textChild('See '),
          { type: 'mega-ref', version: 1, ref: { kind: 'doc', targetTitle: 'Runbook', targetId: 'doc-42' } },
        ],
      }),
    ])
    render(<MegaContentReader stateJSON={stateJSON} workspaceBase="/en/workspace" />)

    const link = screen.getByRole('link', { name: 'Runbook' })
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('data-mega-content', 'ref')
    expect(link).toHaveAttribute('href', '/en/workspace/docs/doc-42')
    expect(link).toHaveTextContent('Runbook')
  })

  it('renders a missing wiki link as an explicit dead-link affordance, never silently', () => {
    const stateJSON = rootState([
      megaBlock({
        blockId: 'p1',
        children: [
          { type: 'mega-ref', version: 1, ref: { kind: 'doc', targetTitle: 'Ghost Page' } },
        ],
      }),
    ])
    render(<MegaContentReader stateJSON={stateJSON} />)

    const dead = screen.getByRole('button', { name: 'Ghost Page' })
    expect(dead.tagName).toBe('BUTTON')
    expect(dead).toHaveAttribute('data-mega-content', 'ref-unresolved')
    expect(screen.getAllByText(/^\[\[$|^\]\]$/)).toHaveLength(2)
  })

  it('prefers a live titleById override over the stored title for a resolved link', () => {
    const stateJSON = rootState([
      megaBlock({
        blockId: 'p1',
        children: [
          { type: 'mega-ref', version: 1, ref: { kind: 'doc', targetTitle: 'Stale', targetId: 'doc-1' } },
        ],
      }),
    ])
    render(<MegaContentReader stateJSON={stateJSON} titleById={{ 'doc-1': 'Fresh' }} />)
    expect(screen.getByRole('link', { name: 'Fresh' })).toBeInTheDocument()
    expect(screen.getAllByText(/^\[\[$|^\]\]$/)).toHaveLength(2)
    expect(screen.queryByText('Stale')).not.toBeInTheDocument()
  })
})

describe('ReaderRefNode polymorphism', () => {
  it('static importJSON/clone produce ReaderRefNode instances so decorate() actually renders', () => {
    // Regression guard: the base RefNode.importJSON hard-codes `new RefNode(...)`;
    // without ReaderRefNode's own static override, parsed state would silently fall
    // back to the no-op base decorate() and render nothing.
    const stateJSON = buildStateJSON((editor) => {
      const node = ReaderRefNode.importJSON({
        type: 'mega-ref',
        version: 1,
        ref: { kind: 'doc', targetTitle: 'x' },
      })
      expect(node).toBeInstanceOf(ReaderRefNode)
      const cloned = ReaderRefNode.clone(node)
      expect(cloned).toBeInstanceOf(ReaderRefNode)
      void editor
    })
    expect(stateJSON).not.toBe('')
  })
})
