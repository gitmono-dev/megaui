// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import React, { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useBlockDeepLinkHighlight } from './use-block-deep-link'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useFakeTimers()
})

function Harness({
  blockParam,
  ready,
  scoped = false,
}: {
  blockParam: string
  ready: boolean
  scoped?: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  useBlockDeepLinkHighlight(blockParam, ready, scoped ? containerRef : undefined)
  return (
    <div ref={containerRef} data-testid="scope">
      <div data-block-id="target">Target block</div>
    </div>
  )
}

describe('useBlockDeepLinkHighlight', () => {
  it('does nothing when blockParam is empty', () => {
    render(React.createElement(Harness, { blockParam: '', ready: true }))
    const target = document.querySelector('[data-block-id="target"]')
    expect(target).not.toHaveAttribute('data-mega-block-highlight')
  })

  it('does nothing when not ready', () => {
    render(React.createElement(Harness, { blockParam: 'target', ready: false }))
    act(() => {
      vi.advanceTimersByTime(200)
    })
    const target = document.querySelector('[data-block-id="target"]')
    expect(target).not.toHaveAttribute('data-mega-block-highlight')
  })

  it('scrolls to and highlights the matching block, then clears the highlight after a delay', () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})

    render(React.createElement(Harness, { blockParam: 'target', ready: true }))
    const target = document.querySelector('[data-block-id="target"]') as HTMLElement

    // Effect runs synchronously post-mount; the initial attempt should find the
    // already-rendered target without needing the retry loop.
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    expect(target).toHaveAttribute('data-mega-block-highlight', 'true')

    act(() => {
      vi.advanceTimersByTime(2_500)
    })
    expect(target).not.toHaveAttribute('data-mega-block-highlight')
  })

  it('polls until the block appears, then highlights it', () => {
    function DelayedHarness({ show }: { show: boolean }) {
      const containerRef = useRef<HTMLDivElement | null>(null)
      useBlockDeepLinkHighlight('late', true, containerRef)
      return (
        <div ref={containerRef} data-testid="scope">
          {show ? <div data-block-id="late">Late block</div> : null}
        </div>
      )
    }

    const { rerender } = render(React.createElement(DelayedHarness, { show: false }))
    expect(document.querySelector('[data-block-id="late"]')).toBeNull()

    rerender(React.createElement(DelayedHarness, { show: true }))
    act(() => {
      vi.advanceTimersByTime(50)
    })

    const target = document.querySelector('[data-block-id="late"]')
    expect(target).toHaveAttribute('data-mega-block-highlight', 'true')
  })

  it('gives up polling after the 5s timeout and never highlights a block that never appears', () => {
    render(React.createElement(Harness, { blockParam: 'never-exists', ready: true }))
    act(() => {
      vi.advanceTimersByTime(6_000)
    })
    // No matching element ever existed; nothing should have blown up, and no
    // stray highlight attribute should appear anywhere in the scope.
    expect(document.querySelector('[data-mega-block-highlight]')).toBeNull()
  })

  it('scopes lookup to containerRef when provided, ignoring matches outside it', () => {
    function ScopedOutsideHarness() {
      const containerRef = useRef<HTMLDivElement | null>(null)
      useBlockDeepLinkHighlight('dup', true, containerRef)
      return (
        <>
          <div data-block-id="dup" data-testid="outside">
            Outside
          </div>
          <div ref={containerRef} data-testid="scope">
            <div data-block-id="dup" data-testid="inside">
              Inside
            </div>
          </div>
        </>
      )
    }

    render(React.createElement(ScopedOutsideHarness))
    const outside = document.querySelector('[data-testid="outside"]')
    const inside = document.querySelector('[data-testid="inside"]')
    expect(inside).toHaveAttribute('data-mega-block-highlight', 'true')
    expect(outside).not.toHaveAttribute('data-mega-block-highlight')
  })
})
