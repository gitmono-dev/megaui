// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EmbedChainContext, EmbedRouteContext, type EmbedChainEntry } from './embed-context'
import { EmbedRenderer } from './embed-renderer'

/** happy-dom has no IntersectionObserver; fire "intersecting" synchronously on observe(). */
class ImmediateIntersectionObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly scrollMargin = ''
  readonly thresholds: readonly number[] = []
  private readonly callback: IntersectionObserverCallback

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
  }

  observe(target: Element): void {
    const entry = { isIntersecting: true, target } as IntersectionObserverEntry
    this.callback([entry], this)
  }

  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

function renderWithProviders(
  ui: React.ReactElement,
  options: { chain?: readonly EmbedChainEntry[] } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 5 } } })
  return render(
    <QueryClientProvider client={client}>
      <EmbedChainContext.Provider value={options.chain ?? []}>
        <EmbedRouteContext.Provider value={{ workspaceBase: '/en/workspace' }}>
          {ui}
        </EmbedRouteContext.Provider>
      </EmbedChainContext.Provider>
    </QueryClientProvider>,
  )
}

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
          blockId: 'snap-1',
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

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('EmbedRenderer containers (AC3)', () => {
  it('renders the embed-page container for a page-level embed and resolves a snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          data: {
            access: 'ok',
            status: 'ok',
            docId: 'doc-1',
            blockId: null,
            title: 'Runbook',
            snapshotBody: snapshotStateJSON('Runbook body'),
            containerBody: null,
            ancestorChain: [],
            depth: 1,
            cycle: false,
            tooDeep: false,
          },
        }),
      ),
    )

    const { container } = renderWithProviders(<EmbedRenderer value={{ targetDocId: 'doc-1' }} />)

    expect(container.querySelector('[data-mega-content="embed-page"]')).not.toBeNull()
    expect(container.querySelector('[data-mega-content="embed-block"]')).toBeNull()

    await waitFor(() => {
      expect(container.querySelector('[data-mega-content="embed-snapshot"]')).not.toBeNull()
    })
    expect(screen.getByText('Runbook')).toHaveAttribute('href', '/en/workspace/docs/doc-1')
  })

  it('renders the embed-block container for a block-level embed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          data: {
            access: 'ok',
            status: 'ok',
            docId: 'doc-1',
            blockId: 'b-1',
            title: 'A block',
            snapshotBody: snapshotStateJSON('Block body'),
            containerBody: snapshotStateJSON('Block body'),
            ancestorChain: [],
            depth: 1,
            cycle: false,
            tooDeep: false,
          },
        }),
      ),
    )

    const { container } = renderWithProviders(
      <EmbedRenderer value={{ targetDocId: 'doc-1', targetBlockId: 'b-1' }} />,
    )

    const block = container.querySelector('[data-mega-content="embed-block"]')
    expect(block).not.toBeNull()
    expect(block).toHaveAttribute('data-target-doc', 'doc-1')
    expect(block).toHaveAttribute('data-target-block', 'b-1')

    await waitFor(() => {
      expect(container.querySelector('[data-mega-content="embed-snapshot"]')).not.toBeNull()
    })
  })

  it('shows an explicit load-failure placeholder (never a silent blank container) on fetch rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const { container } = renderWithProviders(<EmbedRenderer value={{ targetDocId: 'doc-1' }} />)

    await waitFor(
      () => {
        expect(container.querySelector('[data-mega-content="embed-placeholder-unresolved"]')).not.toBeNull()
      },
      { timeout: 3000 },
    )
    expect(container.querySelector('[data-mega-content="embed-placeholder-open"]')).toHaveAttribute(
      'href',
      '/en/workspace/docs/doc-1',
    )
  })

  it('shows an explicit load-failure placeholder on a non-ok HTTP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(500, { error: { code: 'BOOM', message: 'server error' } })),
    )

    const { container } = renderWithProviders(<EmbedRenderer value={{ targetDocId: 'doc-1' }} />)

    await waitFor(
      () => {
        expect(container.querySelector('[data-mega-content="embed-placeholder-unresolved"]')).not.toBeNull()
      },
      { timeout: 3000 },
    )
  })

  it('renders a client-side cycle placeholder without ever calling fetch', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { container } = renderWithProviders(<EmbedRenderer value={{ targetDocId: 'doc-1' }} />, {
      chain: [{ docId: 'doc-1', blockId: null }],
    })

    expect(container.querySelector('[data-mega-content="embed-placeholder-cycle"]')).not.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renders a client-side too-deep placeholder without ever calling fetch', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const deepChain: EmbedChainEntry[] = Array.from({ length: 4 }, (_, i) => ({
      docId: `ancestor-${i}`,
      blockId: null,
    }))

    const { container } = renderWithProviders(<EmbedRenderer value={{ targetDocId: 'doc-new' }} />, {
      chain: deepChain,
    })

    expect(container.querySelector('[data-mega-content="embed-placeholder-too_deep"]')).not.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a server-reported unresolved status to the unresolved placeholder', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          data: {
            access: 'ok',
            status: 'unresolved',
            docId: 'doc-missing',
            blockId: null,
            title: '',
            snapshotBody: null,
            containerBody: null,
            ancestorChain: [],
            depth: 1,
            cycle: false,
            tooDeep: false,
          },
        }),
      ),
    )

    const { container } = renderWithProviders(<EmbedRenderer value={{ targetDocId: 'doc-missing' }} />)

    await waitFor(() => {
      expect(container.querySelector('[data-mega-content="embed-placeholder-unresolved"]')).not.toBeNull()
    })
  })
})
