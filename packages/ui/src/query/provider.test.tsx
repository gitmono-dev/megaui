// @vitest-environment happy-dom
import { useQueryClient } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MegaQueryProvider } from './provider'

afterEach(() => {
  cleanup()
})

function Probe() {
  const client = useQueryClient()
  const options = client.getDefaultOptions()
  return (
    <div data-testid="probe">
      <span data-testid="stale-time">{String(options.queries?.staleTime)}</span>
      <span data-testid="retry">{String(options.queries?.retry)}</span>
      <span data-testid="refetch-on-focus">{String(options.queries?.refetchOnWindowFocus)}</span>
    </div>
  )
}

describe('MegaQueryProvider', () => {
  it('renders its children', () => {
    render(
      <MegaQueryProvider>
        <div data-testid="child">hello</div>
      </MegaQueryProvider>,
    )
    expect(screen.getByTestId('child').textContent).toBe('hello')
  })

  it('provides a QueryClient reachable via useQueryClient', () => {
    render(
      <MegaQueryProvider>
        <Probe />
      </MegaQueryProvider>,
    )
    expect(screen.getByTestId('probe')).toBeTruthy()
  })

  it('configures the default query options: 30s staleTime, 1 retry, no refetch-on-window-focus', () => {
    render(
      <MegaQueryProvider>
        <Probe />
      </MegaQueryProvider>,
    )
    expect(screen.getByTestId('stale-time').textContent).toBe('30000')
    expect(screen.getByTestId('retry').textContent).toBe('1')
    expect(screen.getByTestId('refetch-on-focus').textContent).toBe('false')
  })

  it('reuses the same QueryClient instance across re-renders (lazy useState singleton)', () => {
    const seen: unknown[] = []
    function Capture() {
      seen.push(useQueryClient())
      return null
    }
    const { rerender } = render(
      <MegaQueryProvider>
        <Capture />
      </MegaQueryProvider>,
    )
    rerender(
      <MegaQueryProvider>
        <Capture />
      </MegaQueryProvider>,
    )
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
  })
})
