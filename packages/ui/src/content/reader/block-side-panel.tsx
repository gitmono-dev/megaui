/**
 * megaui:libs/react-shared/components/mega/content/block-side-panel.tsx@0ff3a9d
 *
 * Diff vs upstream (GC-03, UI-07): upstream imports `ZoomCrumb` from a
 * sibling `zoom.ts` (block-zoom breadcrumb indexing) that is not part of
 * this card's reference file list / write set. This module declares the
 * minimal local `BlockSidePanelCrumb` shape it actually renders instead.
 */
'use client'

import React, { useEffect, useRef, type ReactNode } from 'react'
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from '../../tokens'

/** Minimal breadcrumb shape this panel renders (see module header). */
export interface BlockSidePanelCrumb {
  blockId: string
  label: string
}

export type BlockSidePanelLabels = {
  ariaLabel: string
  close: string
  invalid: string
  breadcrumbAriaLabel: string
  pageCrumb: string
}

export type BlockSidePanelProps = {
  labels: BlockSidePanelLabels
  /** When false/undefined, show the invalid empty state. */
  valid: boolean
  crumbs: BlockSidePanelCrumb[]
  onClose: () => void
  onNavigate: (blockId: string | null) => void
  /** Collapse when focus leaves the panel chrome/body (ADR-CE-16). */
  collapseOnBlur?: boolean
  children?: ReactNode
}

/** Roam-style right block panel chrome (breadcrumb + close + slot). */
export function BlockSidePanel({
  labels,
  valid,
  crumbs,
  onClose,
  onNavigate,
  collapseOnBlur = true,
  children,
}: BlockSidePanelProps): React.JSX.Element {
  const rootRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    if (!collapseOnBlur) return undefined
    const onFocusIn = (event: FocusEvent) => {
      const root = rootRef.current
      const target = event.target
      if (!(target instanceof Element) || !root) return
      if (root.contains(target)) return
      // Collapse only when focus moves into another contenteditable (main doc),
      // not on generic body/menu/handle/resizer focus transitions.
      const editable = target.closest(
        '[data-mega-doc="content-editable"], [data-mega-content="content-editable"]',
      )
      if (!editable) return
      onClose()
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [collapseOnBlur, onClose])

  return (
    <aside
      aria-label={labels.ariaLabel}
      data-mega-content="block-side-panel"
      ref={rootRef}
      style={{
        background: MEGA_TOKENS.bg,
        borderLeft: `1px solid ${MEGA_TOKENS.border}`,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        minWidth: 0,
      }}
    >
      <header
        style={{
          alignItems: 'center',
          borderBottom: `1px solid ${MEGA_TOKENS.border}`,
          display: 'flex',
          gap: MEGA_SPACING_TOKENS[6],
          padding: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]}) calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
        }}
      >
        <nav
          aria-label={labels.breadcrumbAriaLabel}
          data-mega-content="panel-breadcrumb"
          style={{
            alignItems: 'center',
            color: MEGA_TOKENS.muted,
            display: 'flex',
            flex: 1,
            flexWrap: 'wrap',
            fontSize: 'calc(var(--mega-density-font-size, 15px) - 1px)',
            gap: MEGA_SPACING_TOKENS[4],
            minWidth: 0,
          }}
        >
          <button
            data-mega-content="panel-crumb-page"
            onClick={() => onNavigate(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: MEGA_TOKENS.accent,
              cursor: 'pointer',
              font: 'inherit',
              padding: 0,
            }}
            type="button"
          >
            {labels.pageCrumb}
          </button>
          {crumbs.map((crumb, index) => (
            <React.Fragment key={crumb.blockId}>
              <span aria-hidden="true">›</span>
              {index === crumbs.length - 1 ? (
                <span data-mega-content="panel-crumb-current">{crumb.label}</span>
              ) : (
                <button
                  data-block-id={crumb.blockId}
                  data-mega-content="panel-crumb"
                  onClick={() => onNavigate(crumb.blockId)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: MEGA_TOKENS.accent,
                    cursor: 'pointer',
                    font: 'inherit',
                    padding: 0,
                  }}
                  type="button"
                >
                  {crumb.label}
                </button>
              )}
            </React.Fragment>
          ))}
        </nav>
        <button
          data-mega-content="panel-close"
          onClick={onClose}
          style={{
            background: MEGA_TOKENS.subtle,
            border: `1px solid ${MEGA_TOKENS.border}`,
            borderRadius: MEGA_RADIUS_TOKENS.pill,
            color: MEGA_TOKENS.text,
            cursor: 'pointer',
            font: 'inherit',
            fontSize: 'calc(var(--mega-density-font-size, 15px) - 2px)',
            padding: `${MEGA_SPACING_TOKENS[1]} calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]})`,
          }}
          type="button"
        >
          {labels.close}
        </button>
      </header>
      <div
        data-mega-content="panel-body"
        style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}
      >
        {valid ? children : (
          <p
            data-mega-content="panel-invalid"
            role="status"
            style={{ color: MEGA_TOKENS.muted, margin: 0 }}
          >
            {labels.invalid}
          </p>
        )}
      </div>
    </aside>
  )
}
