import { describe, expect, it } from 'vitest'
import { EMBED_MAX_DEPTH } from '@megaui/core'
import {
  clientEmbedWouldCycle,
  clientEmbedWouldExceedDepth,
  embedHref,
  mapEmbedResolveToPlaceholder,
  type EmbedChainEntry,
} from './embed-context'

describe('embedHref / EMBED_MAX_DEPTH re-exports', () => {
  it('re-exports the same EMBED_MAX_DEPTH constant as @megaui/core', () => {
    expect(EMBED_MAX_DEPTH).toBeGreaterThan(0)
  })

  it('builds a page embed href without a block query param', () => {
    expect(embedHref({ targetDocId: 'doc-1' }, '/en/workspace')).toBe('/en/workspace/docs/doc-1')
  })

  it('builds a block embed href with a block query param', () => {
    expect(embedHref({ targetDocId: 'doc-1', targetBlockId: 'b-1' }, '/en/workspace')).toBe(
      '/en/workspace/docs/doc-1?block=b-1',
    )
  })
})

describe('clientEmbedWouldCycle', () => {
  it('is false for an empty chain', () => {
    expect(clientEmbedWouldCycle([], { docId: 'doc-1', blockId: null })).toBe(false)
  })

  it('detects a page-level cycle (same docId anywhere in the chain)', () => {
    const chain: EmbedChainEntry[] = [{ docId: 'doc-1', blockId: null }]
    expect(clientEmbedWouldCycle(chain, { docId: 'doc-1', blockId: null })).toBe(true)
  })

  it('does not flag a different docId as a cycle', () => {
    const chain: EmbedChainEntry[] = [{ docId: 'doc-1', blockId: null }]
    expect(clientEmbedWouldCycle(chain, { docId: 'doc-2', blockId: null })).toBe(false)
  })

  it('detects a block-level cycle against the same doc+block pair', () => {
    const chain: EmbedChainEntry[] = [{ docId: 'doc-1', blockId: 'b-1' }]
    expect(clientEmbedWouldCycle(chain, { docId: 'doc-1', blockId: 'b-1' })).toBe(true)
  })

  it('detects a block-level cycle against a whole-page ancestor of the same doc', () => {
    const chain: EmbedChainEntry[] = [{ docId: 'doc-1', blockId: null }]
    expect(clientEmbedWouldCycle(chain, { docId: 'doc-1', blockId: 'b-1' })).toBe(true)
  })

  it('does not flag a different block in the same doc as a block-level cycle', () => {
    const chain: EmbedChainEntry[] = [{ docId: 'doc-1', blockId: 'b-1' }]
    expect(clientEmbedWouldCycle(chain, { docId: 'doc-1', blockId: 'b-2' })).toBe(false)
  })
})

describe('clientEmbedWouldExceedDepth', () => {
  it('is false while chain length is within the max depth', () => {
    const chain: EmbedChainEntry[] = Array.from({ length: EMBED_MAX_DEPTH }, (_, i) => ({
      docId: `doc-${i}`,
      blockId: null,
    }))
    expect(clientEmbedWouldExceedDepth(chain)).toBe(false)
  })

  it('is true once chain length exceeds the max depth', () => {
    const chain: EmbedChainEntry[] = Array.from({ length: EMBED_MAX_DEPTH + 1 }, (_, i) => ({
      docId: `doc-${i}`,
      blockId: null,
    }))
    expect(clientEmbedWouldExceedDepth(chain)).toBe(true)
  })

  it('respects an explicit maxDepth override', () => {
    expect(clientEmbedWouldExceedDepth([{ docId: 'a', blockId: null }, { docId: 'b', blockId: null }], 1)).toBe(true)
    expect(clientEmbedWouldExceedDepth([{ docId: 'a', blockId: null }], 1)).toBe(false)
  })
})

describe('mapEmbedResolveToPlaceholder', () => {
  it('maps NO_ACCESS to no_access regardless of other flags', () => {
    expect(
      mapEmbedResolveToPlaceholder({ access: 'NO_ACCESS', status: 'ok', cycle: false, tooDeep: false }),
    ).toBe('no_access')
  })

  it('maps a cycle flag/status to cycle', () => {
    expect(mapEmbedResolveToPlaceholder({ access: 'ok', status: 'ok', cycle: true, tooDeep: false })).toBe('cycle')
    expect(mapEmbedResolveToPlaceholder({ access: 'ok', status: 'cycle', cycle: false, tooDeep: false })).toBe(
      'cycle',
    )
  })

  it('maps a too-deep flag/status to too_deep', () => {
    expect(mapEmbedResolveToPlaceholder({ access: 'ok', status: 'ok', cycle: false, tooDeep: true })).toBe(
      'too_deep',
    )
    expect(mapEmbedResolveToPlaceholder({ access: 'ok', status: 'too_deep', cycle: false, tooDeep: false })).toBe(
      'too_deep',
    )
  })

  it('maps an unresolved status to unresolved', () => {
    expect(
      mapEmbedResolveToPlaceholder({ access: 'ok', status: 'unresolved', cycle: false, tooDeep: false }),
    ).toBe('unresolved')
  })

  it('returns null for a clean resolve (no placeholder needed)', () => {
    expect(mapEmbedResolveToPlaceholder({ access: 'ok', status: 'ok', cycle: false, tooDeep: false })).toBeNull()
  })
})
