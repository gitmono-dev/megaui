// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  createEmbedLiveRenderSlot,
  EmbedLiveContent,
  EmbedSnapshotFallback,
  shouldUseLiveEmbed,
  type DocCollabConnectionStatus,
  type LiveEmbedConnect,
  type LiveEmbedConnection,
} from './embed-live'

afterEach(() => {
  cleanup()
})

function snapshotStateJSON(text: string): string {
  return JSON.stringify({
    root: {
      type: 'root',
      version: 1,
      direction: null,
      format: '',
      indent: 0,
      children: [
        {
          type: 'mega-block',
          version: 1,
          blockId: 'live-1',
          variant: 'text',
          collapsed: false,
          todoChecked: false,
          direction: null,
          format: '',
          indent: 0,
          children: [
            { type: 'text', version: 1, text, detail: 0, format: 0, mode: 'normal', style: '' },
          ],
        },
      ],
    },
  })
}

/** A fully-controllable fake connection so tests never touch the network. */
function makeFakeConnect(): { connect: LiveEmbedConnect; emit: (status: DocCollabConnectionStatus) => void; destroy: ReturnType<typeof vi.fn> } {
  const listeners = new Set<(status: DocCollabConnectionStatus) => void>()
  let current: DocCollabConnectionStatus = 'connecting'
  const destroy = vi.fn()
  const connect: LiveEmbedConnect = (): LiveEmbedConnection => ({
    getStatus: () => current,
    onStatusChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    destroy,
  })
  return {
    connect,
    emit: (status) => {
      current = status
      listeners.forEach((listener) => listener(status))
    },
    destroy,
  }
}

describe('shouldUseLiveEmbed', () => {
  it('requires both a non-blank url and token', () => {
    expect(shouldUseLiveEmbed(null)).toBe(false)
    expect(shouldUseLiveEmbed(undefined)).toBe(false)
    expect(shouldUseLiveEmbed({ url: '', token: 'tok' })).toBe(false)
    expect(shouldUseLiveEmbed({ url: 'wss://x', token: '  ' })).toBe(false)
    expect(shouldUseLiveEmbed({ url: 'wss://x', token: 'tok' })).toBe(true)
  })
})

describe('EmbedLiveContent (third embed container, AC3)', () => {
  it('renders the embed-live container with connection-status chrome and the snapshot body', async () => {
    const { connect, emit } = makeFakeConnect()
    const { container } = render(
      <EmbedLiveContent
        connect={connect}
        containerBody={snapshotStateJSON('body')}
        liveCollab={{ url: 'wss://example', token: 'tok' }}
        snapshotBody={snapshotStateJSON('Live content')}
        title="Live doc"
        value={{ targetDocId: 'doc-1' }}
        workspaceBase="/en/workspace"
      />,
    )

    const root = container.querySelector('[data-mega-content="embed-live"]')
    expect(root).not.toBeNull()
    expect(root).toHaveAttribute('data-target-doc', 'doc-1')
    expect(root).toHaveAttribute('data-embed-kind', 'page')
    expect(root).toHaveAttribute('data-live-status', 'connecting')
    expect(container.querySelector('[data-mega-content="embed-live-chrome"]')).not.toBeNull()
    expect(container.querySelector('[data-mega-content="embed-live-status"]')).toHaveTextContent('connecting')

    await waitFor(() => {
      expect(screen.getByText('Live content')).toBeInTheDocument()
    })

    emit('connected')
    await waitFor(() => {
      expect(container.querySelector('[data-mega-content="embed-live"]')).toHaveAttribute(
        'data-live-status',
        'connected',
      )
    })
    expect(container.querySelector('[data-mega-content="embed-live-status"]')).toHaveTextContent('live')
  })

  it('marks block-level live embeds with data-embed-kind="block" and data-target-block', () => {
    const { connect } = makeFakeConnect()
    const { container } = render(
      <EmbedLiveContent
        connect={connect}
        containerBody={snapshotStateJSON('body')}
        liveCollab={{ url: 'wss://example', token: 'tok' }}
        snapshotBody={snapshotStateJSON('Block live')}
        title="Live block"
        value={{ targetDocId: 'doc-1', targetBlockId: 'b-9' }}
        workspaceBase="/en/workspace"
      />,
    )

    const root = container.querySelector('[data-mega-content="embed-live"]')
    expect(root).toHaveAttribute('data-embed-kind', 'block')
    expect(root).toHaveAttribute('data-target-block', 'b-9')
  })

  it('destroys the connection on unmount', () => {
    const { connect, destroy } = makeFakeConnect()
    const { unmount } = render(
      <EmbedLiveContent
        connect={connect}
        containerBody={snapshotStateJSON('body')}
        liveCollab={{ url: 'wss://example', token: 'tok' }}
        snapshotBody={snapshotStateJSON('Body')}
        title="Doc"
        value={{ targetDocId: 'doc-1' }}
      />,
    )
    expect(destroy).not.toHaveBeenCalled()
    unmount()
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})

describe('createEmbedLiveRenderSlot', () => {
  it('returns undefined when collab creds are unavailable (falls back to the static snapshot path)', () => {
    expect(createEmbedLiveRenderSlot(null)).toBeUndefined()
    expect(createEmbedLiveRenderSlot({ url: '', token: '' })).toBeUndefined()
  })

  it('returns a render function that mounts EmbedLiveContent when creds are present', async () => {
    const { connect } = makeFakeConnect()
    const renderLiveSlot = createEmbedLiveRenderSlot(
      { url: 'wss://example', token: 'tok' },
      { workspaceBase: '/en/workspace' },
      connect,
    )
    expect(renderLiveSlot).toBeTypeOf('function')

    const node = renderLiveSlot!({
      value: { targetDocId: 'doc-1' },
      snapshotBody: snapshotStateJSON('Slot content'),
      containerBody: snapshotStateJSON('Slot content'),
      title: 'Doc',
    })
    render(<>{node}</>)

    await waitFor(() => {
      expect(screen.getByText('Slot content')).toBeInTheDocument()
    })
  })
})

describe('EmbedSnapshotFallback', () => {
  it('renders the read-only snapshot with no live status chrome', async () => {
    const { container } = render(
      <EmbedSnapshotFallback snapshotBody={snapshotStateJSON('Fallback content')} workspaceBase="/en/workspace" />,
    )

    expect(container.querySelector('[data-mega-content="embed-snapshot-fallback"]')).not.toBeNull()
    expect(container.querySelector('[data-mega-content="embed-live"]')).toBeNull()
    await waitFor(() => {
      expect(screen.getByText('Fallback content')).toBeInTheDocument()
    })
  })
})
