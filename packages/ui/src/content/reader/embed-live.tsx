/**
 * megaui:libs/react-shared/components/mega/content/embed-live.tsx@0ff3a9d
 *
 * Diff vs upstream (GC-03, UI-07): upstream's live path binds a full
 * `CollaborationPlugin` Lexical↔Yjs editor (`libs/react-shared/.../plugins/
 * collab.tsx`) so the visible reader tracks remote edits block-by-block.
 * That plugin is a UI-06/CS-01 concern (editable collab surface, not built
 * yet) and is out of this card's write set. This port keeps the real
 * connection-status chrome (`@hocuspocus/provider` + `yjs`, both already
 * `packages/ui` dependencies) as the third embed container
 * (`data-mega-content="embed-live"`, AC3) but renders the *visible* body via
 * the read-only `MegaContentReader` against the resolved snapshot instead of
 * a live Yjs↔Lexical binding — connection status is real, live content sync
 * is deferred. The connector is injectable (`connect` prop) so callers/tests
 * never need a live network round-trip.
 */
'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { HocuspocusProvider, type WebSocketStatus } from '@hocuspocus/provider'
import * as Y from 'yjs'
import {
  EmbedRouteContext,
  type EmbedLiveSlotArgs,
  type EmbedRendererLabels,
  type EmbedValue,
} from './embed-context'
import { EmbedRenderer } from './embed-renderer'
import { MegaContentReaderCore } from './reader-core'

export type LiveEmbedCollabCreds = {
  url: string
  token: string
  userId?: string
  username?: string
}

export type DocCollabConnectionStatus = 'connecting' | 'connected' | 'disconnected'

/** True when browser collab URL + session token are present (CE-54 live path). */
export function shouldUseLiveEmbed(creds: LiveEmbedCollabCreds | null | undefined): boolean {
  return Boolean(creds?.url?.trim() && creds?.token?.trim())
}

function buildDocContainerRoomName(docId: string): string {
  return `container:doc:${docId}`
}

export interface LiveEmbedConnection {
  getStatus(): DocCollabConnectionStatus
  onStatusChange(listener: (status: DocCollabConnectionStatus) => void): () => void
  destroy(): void
}

export type LiveEmbedConnect = (config: {
  documentName: string
  url: string
  token: string
}) => LiveEmbedConnection

/** Default connector: a real Hocuspocus/Yjs room, used only for the status chrome (see module header). */
export const connectLiveEmbedRoom: LiveEmbedConnect = ({ documentName, url, token }) => {
  const doc = new Y.Doc()
  let status: DocCollabConnectionStatus = 'connecting'
  const listeners = new Set<(status: DocCollabConnectionStatus) => void>()
  const notify = (next: DocCollabConnectionStatus): void => {
    status = next
    listeners.forEach((listener) => listener(next))
  }
  const provider = new HocuspocusProvider({
    document: doc,
    name: documentName,
    token,
    url,
    onStatus: ({ status: nextStatus }: { status: WebSocketStatus }) => notify(nextStatus),
  })
  return {
    getStatus: () => status,
    onStatusChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    destroy: () => {
      provider.destroy()
      doc.destroy()
    },
  }
}

/**
 * Build `renderLiveSlot` for `EmbedRouteContext`. Returns undefined when
 * collab is unavailable so `EmbedRenderer` keeps the CE-53 snapshot path.
 */
export function createEmbedLiveRenderSlot(
  creds: LiveEmbedCollabCreds | null | undefined,
  options?: {
    workspaceBase?: string
    labels?: Partial<EmbedRendererLabels>
  },
  connect: LiveEmbedConnect = connectLiveEmbedRoom,
): ((args: EmbedLiveSlotArgs) => React.ReactNode) | undefined {
  if (!shouldUseLiveEmbed(creds) || !creds) return undefined
  const workspaceBase = options?.workspaceBase ?? '/en/workspace'
  const labels = options?.labels
  return ({ value, snapshotBody, containerBody, title }) => (
    <EmbedLiveContent
      connect={connect}
      containerBody={containerBody}
      labels={labels}
      liveCollab={creds}
      snapshotBody={snapshotBody}
      title={title}
      value={value}
      workspaceBase={workspaceBase}
    />
  )
}

function LiveStatusBadge({ status }: { status: DocCollabConnectionStatus }): React.JSX.Element {
  return (
    <span data-live-status={status} data-mega-content="embed-live-status">
      {status === 'connected' ? 'live' : status}
    </span>
  )
}

/**
 * Third embed container (AC3): live connection-status chrome around the
 * read-only snapshot reader. Unmounting disconnects the room.
 */
export function EmbedLiveContent({
  connect = connectLiveEmbedRoom,
  containerBody,
  labels,
  liveCollab,
  snapshotBody,
  title: _title,
  value,
  workspaceBase = '/en/workspace',
}: {
  value: EmbedValue
  snapshotBody: string
  /** Reserved for a future live Yjs↔Lexical seed (see module header); unused today. */
  containerBody: string
  title: string
  liveCollab: LiveEmbedCollabCreds
  workspaceBase?: string
  labels?: Partial<EmbedRendererLabels>
  connect?: LiveEmbedConnect
}): React.JSX.Element {
  const blockId = value.targetBlockId?.trim() || ''
  const isBlockEmbed = Boolean(blockId)
  const [status, setStatus] = useState<DocCollabConnectionStatus>('connecting')

  const documentName = useMemo(
    () => buildDocContainerRoomName(value.targetDocId),
    [value.targetDocId],
  )

  useEffect(() => {
    const connection = connect({ documentName, url: liveCollab.url, token: liveCollab.token })
    setStatus(connection.getStatus())
    const unsubscribe = connection.onStatusChange(setStatus)
    return () => {
      unsubscribe()
      connection.destroy()
    }
  }, [connect, documentName, liveCollab.token, liveCollab.url])

  const nestedRenderLiveSlot = useMemo(
    () => createEmbedLiveRenderSlot(liveCollab, { workspaceBase, labels }, connect),
    [connect, labels, liveCollab, workspaceBase],
  )
  const embedRouteValue = useMemo(
    () => ({ workspaceBase, labels, renderLiveSlot: nestedRenderLiveSlot }),
    [workspaceBase, labels, nestedRenderLiveSlot],
  )

  return (
    <EmbedRouteContext.Provider value={embedRouteValue}>
      <div
        data-embed-kind={isBlockEmbed ? 'block' : 'page'}
        data-live-status={status}
        data-mega-content="embed-live"
        data-target-doc={value.targetDocId}
        {...(isBlockEmbed ? { 'data-target-block': blockId } : {})}
      >
        <div data-mega-content="embed-live-chrome">
          <LiveStatusBadge status={status} />
        </div>
        <div data-mega-content="embed-live-visible">
          <MegaContentReaderCore
            embedLabels={labels}
            renderEmbed={EmbedRenderer}
            renderLiveSlot={nestedRenderLiveSlot}
            stateJSON={snapshotBody}
            workspaceBase={workspaceBase}
          />
        </div>
      </div>
    </EmbedRouteContext.Provider>
  )
}

/** Snapshot-only fallback used when collab is unavailable (no live status chrome). */
export function EmbedSnapshotFallback({
  labels,
  snapshotBody,
  workspaceBase = '/en/workspace',
}: {
  snapshotBody: string
  workspaceBase?: string
  labels?: Partial<EmbedRendererLabels>
}): React.JSX.Element {
  return (
    <div data-mega-content="embed-snapshot-fallback">
      <MegaContentReaderCore
        embedLabels={labels}
        renderEmbed={EmbedRenderer}
        stateJSON={snapshotBody}
        workspaceBase={workspaceBase}
      />
    </div>
  )
}
