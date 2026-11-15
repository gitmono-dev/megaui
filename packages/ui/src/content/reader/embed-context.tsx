/**
 * megaui:libs/react-shared/components/mega/content/embed-context.tsx@0ff3a9d
 *
 * Diff vs upstream (GC-03, UI-07): `EmbedValue` / `embedHref` moved to
 * `@megaui/content`'s `embed-node.ts` under PK-02 (ADR-ARCH-01 sink of the
 * Lexical node vocabulary out of react-shared) — this module re-exports
 * them instead of redefining, and keeps only the reader-specific
 * route/chain/placeholder logic that stays a UI-package concern.
 * `EMBED_MAX_DEPTH` is imported from `@megaui/core` (also PK-02) rather
 * than redeclared.
 */
'use client'

import React, { createContext } from 'react'
import { EMBED_MAX_DEPTH } from '@megaui/core'
import { embedHref, type EmbedValue } from '@megaui/content'

export { embedHref, EMBED_MAX_DEPTH }
export type { EmbedValue }

export type EmbedChainEntry = {
  docId: string
  blockId: string | null
}

export interface EmbedRendererLabels {
  cycle: string
  tooDeep: string
  unresolved: string
  noAccess: string
  loading: string
  openSource: string
}

export const EmbedChainContext = createContext<readonly EmbedChainEntry[]>([])

export interface EmbedLiveSlotArgs {
  value: EmbedValue
  snapshotBody: string
  /** Full container body for A-type room seed (block embeds). */
  containerBody: string
  title: string
}

export const EmbedRouteContext = createContext<{
  workspaceBase: string
  labels?: Partial<EmbedRendererLabels>
  /** When set, nested embeds render a live slot instead of a static snapshot. */
  renderLiveSlot?: (args: EmbedLiveSlotArgs) => React.ReactNode
}>({ workspaceBase: '/en/workspace' })

/** Client-side cycle check mirroring the server's `wouldCycle` (CE-53). */
export function clientEmbedWouldCycle(
  chain: readonly EmbedChainEntry[],
  next: EmbedChainEntry,
): boolean {
  if (next.blockId) {
    return chain.some((entry) =>
      entry.docId === next.docId
      && (entry.blockId === null || entry.blockId === next.blockId),
    )
  }
  return chain.some((entry) => entry.docId === next.docId)
}

/** True when following `next` would exceed ADR-CE-11 max nest depth. */
export function clientEmbedWouldExceedDepth(
  chain: readonly EmbedChainEntry[],
  maxDepth: number = EMBED_MAX_DEPTH,
): boolean {
  // `chain.length` is the depth of the embed about to render (0 = top-level).
  return chain.length > maxDepth
}

export type EmbedPlaceholderKind = 'cycle' | 'too_deep' | 'unresolved' | 'no_access'

export function mapEmbedResolveToPlaceholder(result: {
  access: string
  status: string
  cycle: boolean
  tooDeep: boolean
}): EmbedPlaceholderKind | null {
  if (result.access === 'NO_ACCESS') return 'no_access'
  if (result.cycle || result.status === 'cycle') return 'cycle'
  if (result.tooDeep || result.status === 'too_deep') return 'too_deep'
  if (result.status === 'unresolved') return 'unresolved'
  return null
}
