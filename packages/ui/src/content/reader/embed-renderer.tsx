/**
 * megaui:libs/react-shared/components/mega/content/embed-renderer.tsx@0ff3a9d
 *
 * Diff vs upstream (GC-03, UI-07): consumes `@megaui/content`'s `EmbedValue`
 * (via `./embed-context`, cross-package) instead of a react-shared local
 * type. Three embed containers, each with its own `data-mega-content` root
 * (AC3): `embed-page` / `embed-block` (this file, static snapshot) and
 * `embed-live` (`./embed-live`, live status chrome). All four resolve
 * failure modes (`unresolved` / `no_access` / `cycle` / `too_deep`) and the
 * react-query load failure share one explicit placeholder path — never a
 * silent empty render.
 */
'use client'

import React, { useContext, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { megaGet } from '../../query/fetcher'
import { megaQueryKeys } from '../../query/keys'
import type { EmbedValue } from './embed-context'
import { embedHref } from './embed-context'
import {
  clientEmbedWouldCycle,
  clientEmbedWouldExceedDepth,
  EMBED_MAX_DEPTH,
  EmbedChainContext,
  EmbedRouteContext,
  mapEmbedResolveToPlaceholder,
  type EmbedChainEntry,
  type EmbedPlaceholderKind,
  type EmbedRendererLabels,
} from './embed-context'
import { MegaContentReaderCore } from './reader-core'

export type { EmbedChainEntry, EmbedPlaceholderKind, EmbedRendererLabels }
export {
  clientEmbedWouldCycle,
  clientEmbedWouldExceedDepth,
  EmbedChainContext,
  EmbedRouteContext,
  mapEmbedResolveToPlaceholder,
} from './embed-context'

type EmbedResolvePayload = {
  access: 'ok' | 'NO_ACCESS'
  status: 'ok' | 'unresolved' | 'cycle' | 'too_deep'
  docId: string
  blockId: string | null
  title: string
  snapshotBody: string | null
  containerBody: string | null
  ancestorChain: EmbedChainEntry[]
  depth: number
  cycle: boolean
  tooDeep: boolean
  referenceCount?: number
}

const DEFAULT_LABELS: EmbedRendererLabels = {
  cycle: 'Circular embed',
  tooDeep: 'Embed too deep',
  unresolved: 'Unresolved embed',
  noAccess: 'No access',
  loading: 'Loading embed…',
  openSource: 'Open source',
}

/** Wraps a live-collab render slot so it shares the snapshot path's DOM shape. */
export function EmbedLiveSlot({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return <div data-mega-content="embed-live-slot">{children}</div>
}

function EmbedPlaceholder({
  kind,
  labels,
  href,
}: {
  kind: EmbedPlaceholderKind
  labels: EmbedRendererLabels
  href: string
}): React.JSX.Element {
  const text = kind === 'cycle'
    ? labels.cycle
    : kind === 'too_deep'
      ? labels.tooDeep
      : kind === 'no_access'
        ? labels.noAccess
        : labels.unresolved
  return (
    <div data-mega-content={`embed-placeholder-${kind}`}>
      <div data-mega-content="embed-placeholder-text">{text}</div>
      <a data-mega-content="embed-placeholder-open" href={href}>
        {labels.openSource}
      </a>
    </div>
  )
}

/** Nested snapshot embed with lazy resolve + client cycle guard (AC2/AC3). */
export function EmbedRenderer({ presentation = 'default', value }: { value: EmbedValue; presentation?: 'default' | 'outline' }): React.JSX.Element {
  const chain = useContext(EmbedChainContext)
  const { workspaceBase, labels: ctxLabels, renderLiveSlot } = useContext(EmbedRouteContext)
  const labels = { ...DEFAULT_LABELS, ...ctxLabels }
  const next: EmbedChainEntry = {
    docId: value.targetDocId,
    blockId: value.targetBlockId ?? null,
  }
  const href = embedHref(value, workspaceBase)
  const clientCycle = clientEmbedWouldCycle(chain, next)
  const clientTooDeep = clientEmbedWouldExceedDepth(chain, EMBED_MAX_DEPTH)

  const hostRef = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const el = hostRef.current
    if (!el || clientCycle || clientTooDeep) return
    // Leaving the viewport unmounts the live slot so its room can GC (CE-54).
    const observer = new IntersectionObserver(
      (entries) => {
        setInView(entries.some((entry) => entry.isIntersecting))
      },
      { root: null, rootMargin: '0px', threshold: 0 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [clientCycle, clientTooDeep])

  const resolveQuery = useQuery({
    queryKey: megaQueryKeys.embedResolve(value.targetDocId, value.targetBlockId),
    queryFn: () => megaGet<EmbedResolvePayload>(
      ['embed', 'resolve'],
      {
        doc: value.targetDocId,
        ...(value.targetBlockId ? { block: value.targetBlockId } : {}),
      },
    ),
    enabled: inView && !clientCycle && !clientTooDeep,
    staleTime: 30_000,
    retry: 1,
  })

  const containerKind = value.targetBlockId ? 'embed-block' : 'embed-page'

  if (clientCycle) {
    return <EmbedPlaceholder href={href} kind="cycle" labels={labels} />
  }
  if (clientTooDeep) {
    return <EmbedPlaceholder href={href} kind="too_deep" labels={labels} />
  }

  return (
    <div
      data-mega-content={containerKind}
      data-presentation={presentation}
      data-target-doc={value.targetDocId}
      ref={hostRef}
      {...(value.targetBlockId ? { 'data-target-block': value.targetBlockId } : {})}
    >
      {!inView ? (
        <div data-mega-content="embed-lazy">{labels.loading}</div>
      ) : null}
      {inView && resolveQuery.isLoading ? (
        <div data-mega-content="embed-loading">{labels.loading}</div>
      ) : null}
      {inView && resolveQuery.isError ? (
        // Fetch/transport failure: still an explicit placeholder, never a silent blank container.
        <EmbedPlaceholder href={href} kind="unresolved" labels={labels} />
      ) : null}
      {inView && resolveQuery.data ? (() => {
        const placeholder = mapEmbedResolveToPlaceholder(resolveQuery.data)
        if (placeholder) {
          return <EmbedPlaceholder href={href} kind={placeholder} labels={labels} />
        }
        if (!resolveQuery.data.snapshotBody) {
          return <EmbedPlaceholder href={href} kind="unresolved" labels={labels} />
        }
        const snapshotBody = resolveQuery.data.snapshotBody
        const containerBody = resolveQuery.data.containerBody ?? snapshotBody
        const title = resolveQuery.data.title
        const nestedChain = [...chain, next]
        return (
          <EmbedChainContext.Provider value={nestedChain}>
            {presentation === 'default' ? (
              <div data-mega-content="embed-snapshot">
                <a data-mega-content="embed-snapshot-title" href={href}>
                  {title || labels.openSource}
                </a>
              </div>
            ) : null}
            <div data-mega-content={presentation === 'outline' ? 'embed-outline-preview' : 'embed-default-preview'}>
              {presentation === 'outline' ? (
                <>
                  {value.targetBlockId ? (
                    <span data-mega-content="embed-reference-count" title="Block references">
                      {Math.max(1, resolveQuery.data.referenceCount ?? 0)}
                    </span>
                  ) : null}
                  <a aria-label={labels.openSource} data-mega-content="embed-outline-open" href={href} title={labels.openSource}>↗</a>
                </>
              ) : null}
              <EmbedLiveSlot>
                {renderLiveSlot
                  ? renderLiveSlot({ value, snapshotBody, containerBody, title })
                  : (
                    <MegaContentReaderCore
                      embedLabels={labels}
                      renderEmbed={EmbedRenderer}
                      stateJSON={snapshotBody}
                      workspaceBase={workspaceBase}
                    />
                  )}
              </EmbedLiveSlot>
            </div>
          </EmbedChainContext.Provider>
        )
      })() : null}
    </div>
  )
}
