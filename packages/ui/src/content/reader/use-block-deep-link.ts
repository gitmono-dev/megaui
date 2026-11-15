/**
 * megaui:libs/react-shared/components/mega/content/use-block-deep-link.ts@0ff3a9d
 *
 * Ported verbatim (no diff): scroll to and briefly highlight a block from
 * `?block=` deep links. Polls until the reader paints `[data-block-id]`
 * within the optional container.
 */
'use client'

import { useEffect, type RefObject } from 'react'

export function useBlockDeepLinkHighlight(
  blockParam: string,
  ready: boolean,
  containerRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!blockParam || !ready) return undefined

    let cancelled = false
    let clearTimer: number | undefined
    const startedAt = Date.now()

    const findTarget = (): HTMLElement | null => {
      const scope = containerRef?.current ?? document
      return scope.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockParam)}"]`)
        ?? (document.getElementById(`block-${blockParam}`) as HTMLElement | null)
    }

    const tryHighlight = () => {
      if (cancelled) return
      const target = findTarget()
      if (!target) {
        if (Date.now() - startedAt < 5_000) window.setTimeout(tryHighlight, 50)
        return
      }
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      target.setAttribute('data-mega-block-highlight', 'true')
      clearTimer = window.setTimeout(() => {
        target.removeAttribute('data-mega-block-highlight')
      }, 2_500)
    }

    tryHighlight()
    return () => {
      cancelled = true
      if (clearTimer !== undefined) window.clearTimeout(clearTimer)
    }
  }, [blockParam, ready, containerRef])
}
