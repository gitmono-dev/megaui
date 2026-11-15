// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BlockSidePanel, type BlockSidePanelLabels } from './block-side-panel'

afterEach(() => {
  cleanup()
})

const labels: BlockSidePanelLabels = {
  ariaLabel: 'Block panel',
  close: 'Close',
  invalid: 'This block no longer exists',
  breadcrumbAriaLabel: 'Breadcrumb',
  pageCrumb: 'Page',
}

describe('BlockSidePanel', () => {
  it('renders children with breadcrumbs when valid', () => {
    render(
      <BlockSidePanel
        crumbs={[{ blockId: 'a', label: 'Ancestor' }, { blockId: 'b', label: 'Current' }]}
        labels={labels}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        valid
      >
        <div data-testid="panel-content">Block body</div>
      </BlockSidePanel>,
    )

    expect(screen.getByTestId('panel-content')).toBeInTheDocument()
    expect(screen.getByText('Page')).toBeInTheDocument()
    expect(screen.getByText('Ancestor')).toBeInTheDocument()
    // Last crumb renders as plain (non-interactive) current-location text.
    const current = screen.getByText('Current')
    expect(current.tagName).toBe('SPAN')
    expect(current).toHaveAttribute('data-mega-content', 'panel-crumb-current')
    expect(screen.queryByText(labels.invalid)).not.toBeInTheDocument()
  })

  it('shows the invalid empty state instead of children when not valid', () => {
    render(
      <BlockSidePanel crumbs={[]} labels={labels} onClose={vi.fn()} onNavigate={vi.fn()} valid={false}>
        <div data-testid="panel-content">Block body</div>
      </BlockSidePanel>,
    )

    expect(screen.queryByTestId('panel-content')).not.toBeInTheDocument()
    expect(screen.getByText(labels.invalid)).toBeInTheDocument()
    expect(screen.getByText(labels.invalid)).toHaveAttribute('role', 'status')
  })

  it('calls onNavigate(null) when the page crumb is clicked', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    render(
      <BlockSidePanel
        crumbs={[{ blockId: 'a', label: 'Ancestor' }]}
        labels={labels}
        onClose={vi.fn()}
        onNavigate={onNavigate}
        valid
      />,
    )

    await user.click(screen.getByText('Page'))
    expect(onNavigate).toHaveBeenCalledWith(null)
  })

  it('calls onNavigate(blockId) when a non-terminal crumb is clicked', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    render(
      <BlockSidePanel
        crumbs={[{ blockId: 'a', label: 'Ancestor' }, { blockId: 'b', label: 'Current' }]}
        labels={labels}
        onClose={vi.fn()}
        onNavigate={onNavigate}
        valid
      />,
    )

    await user.click(screen.getByText('Ancestor'))
    expect(onNavigate).toHaveBeenCalledWith('a')
  })

  it('calls onClose when the close button is clicked', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<BlockSidePanel crumbs={[]} labels={labels} onClose={onClose} onNavigate={vi.fn()} valid />)

    await user.click(screen.getByText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose on Escape keydown anywhere in the window', () => {
    const onClose = vi.fn()
    render(<BlockSidePanel crumbs={[]} labels={labels} onClose={onClose} onNavigate={vi.fn()} valid />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('collapses when focus moves into the main content-editable surface', () => {
    const onClose = vi.fn()
    render(
      <>
        <div data-mega-content="content-editable" tabIndex={-1} data-testid="editor-surface" />
        <BlockSidePanel crumbs={[]} labels={labels} onClose={onClose} onNavigate={vi.fn()} valid />
      </>,
    )

    fireEvent.focusIn(screen.getByTestId('editor-surface'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not collapse on unrelated focus transitions outside the panel', () => {
    const onClose = vi.fn()
    render(
      <>
        <button data-testid="unrelated-button" type="button">
          Unrelated
        </button>
        <BlockSidePanel crumbs={[]} labels={labels} onClose={onClose} onNavigate={vi.fn()} valid />
      </>,
    )

    fireEvent.focusIn(screen.getByTestId('unrelated-button'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not collapse on content-editable focus when collapseOnBlur is false', () => {
    const onClose = vi.fn()
    render(
      <>
        <div data-mega-content="content-editable" tabIndex={-1} data-testid="editor-surface" />
        <BlockSidePanel
          collapseOnBlur={false}
          crumbs={[]}
          labels={labels}
          onClose={onClose}
          onNavigate={vi.fn()}
          valid
        />
      </>,
    )

    fireEvent.focusIn(screen.getByTestId('editor-surface'))
    expect(onClose).not.toHaveBeenCalled()
  })
})
