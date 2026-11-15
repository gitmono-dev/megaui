/**
 * megaui:libs/react-shared/components/mega/content/reader.tsx@0ff3a9d
 *
 * Public reader entry: wires embed chip + live-slot factories onto
 * `MegaContentReaderCore` so nested embed modules can import the core without
 * forming circular deps with this barrel.
 */
'use client'

import React, { useMemo } from 'react'
import { EmbedRenderer } from './embed-renderer'
import { createEmbedLiveRenderSlot, type LiveEmbedCollabCreds } from './embed-live'
import {
  MegaContentReaderCore,
  type MegaContentReaderCoreProps,
} from './reader-core'
import type { EmbedRendererLabels } from './embed-context'

export type { MegaContentReaderCoreProps }
export { MegaContentReaderCore } from './reader-core'

export interface MegaContentReaderProps
  extends Omit<MegaContentReaderCoreProps, 'renderEmbed' | 'renderLiveSlot'> {
  /** When set, nested embeds subscribe to the target's live room (CE-54). */
  embedCollab?: LiveEmbedCollabCreds | null
  embedLabels?: Partial<EmbedRendererLabels>
}

/** Read-only block-tree surface with outline-style todo/collapse affordances. */
export function MegaContentReader({
  embedCollab,
  embedLabels,
  workspaceBase = '/en/workspace',
  ...rest
}: MegaContentReaderProps): React.JSX.Element {
  const renderLiveSlot = useMemo(
    () => createEmbedLiveRenderSlot(embedCollab, { workspaceBase, labels: embedLabels }),
    [embedCollab, workspaceBase, embedLabels],
  )

  return (
    <MegaContentReaderCore
      {...rest}
      embedLabels={embedLabels}
      renderEmbed={EmbedRenderer}
      renderLiveSlot={renderLiveSlot}
      workspaceBase={workspaceBase}
    />
  )
}
