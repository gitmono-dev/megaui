/**
 * megaui:libs/react-shared/components/mega/content/nodes/ref-node.tsx@0ff3a9d
 * megaui:libs/react-shared/components/mega/content/nodes/embed-node.tsx@0ff3a9d
 * megaui:libs/react-shared/components/mega/content/nodes/block-ref-node.tsx@0ff3a9d
 *
 * Diff vs upstream (GC-03, UI-07): `@megaui/content`'s `RefNode` / `EmbedNode`
 * / `BlockRefNode` (PK-02) intentionally leave `decorate()` at the Lexical
 * base-class default (`null`) — the Lexical node + JSON round-trip lives in
 * the content package (server-importable, zero React); the React chip is a
 * UI-package concern. This module supplies that chip by subclassing each
 * base node.
 *
 * Because these are classic (non-`$config`) Lexical nodes:
 * - `static clone` / `static importJSON` must be overridden here too: the
 *   base classes' `importJSON` hard-codes `new RefNode(...)` (via
 *   `$createRefNode` etc.), not `new this(...)`, so parsed JSON would
 *   otherwise always produce base instances whose inherited (no-op)
 *   `decorate()` renders nothing.
 * - `static getType` must be re-declared as an *own* property (delegating
 *   to `super.getType()`, not duplicating the literal) — Lexical 0.49's
 *   reconciler only recognizes a subclass as a registered decorator type
 *   when it owns this method directly.
 * - `createDOM`/`updateDOM` must be implemented: `DecoratorNode` (this
 *   Lexical version) supplies the portal *content* via `decorate()` but not
 *   the *host* element — that is only auto-provided by the newer `$config()`
 *   node system, which the content-package base classes don't use.
 */
'use client'

import React, { createContext, useContext } from 'react'
import {
  blockRefExportContract,
  BlockRefNode,
  EmbedNode,
  refExportContract,
  RefNode,
  type BlockRefValue,
  type EmbedValue,
  type RefNodeValue,
  type SerializedBlockRefNode,
  type SerializedEmbedNode,
  type SerializedRefNode,
} from '@megaui/content'
import { ReferenceChip } from '../ref-chip'

export interface RefRouteConfig {
  workspaceBase: string
  titleById?: Readonly<Record<string, string>>
  createLabel?: string
}

export const RefRouteContext = createContext<RefRouteConfig>({ workspaceBase: '/en/workspace' })

/** Injected by MegaContentReader so nodes stay free of embed-renderer (no circular deps). */
export type EmbedChipComponent = (props: { value: EmbedValue }) => React.JSX.Element | null
export const EmbedChipContext = createContext<EmbedChipComponent | null>(null)

export interface BlockRefRouteConfig {
  workspaceBase: string
  unresolvedLabel?: string
  forbiddenLabel?: string
}

export const BlockRefRouteContext = createContext<BlockRefRouteConfig>({ workspaceBase: '/en/workspace' })

/** CE-40 wiki-link chip: resolved -> anchor/span, unresolved -> an explicit "dead link" affordance (never silent). */
function RefChip({ value }: { value: RefNodeValue }): React.JSX.Element {
  const { workspaceBase, titleById, createLabel } = useContext(RefRouteContext)
  const contract = refExportContract(value, { workspaceBase, titleById, createLabel })
  return <ReferenceChip contract={contract} notation={value.notation} />
}

export class ReaderRefNode extends RefNode {
  // Lexical's node registration requires each concrete class to declare its
  // own `getType` (not merely inherit it) to be recognized as a decorator
  // node at reconcile time; `super.getType()` avoids duplicating the literal.
  static getType(): string {
    return super.getType()
  }

  static clone(node: ReaderRefNode): ReaderRefNode {
    return new ReaderRefNode(node.getRef(), node.getKey())
  }

  static importJSON(serialized: SerializedRefNode): ReaderRefNode {
    return new ReaderRefNode(serialized.ref)
  }

  createDOM(): HTMLElement {
    return document.createElement('span')
  }

  updateDOM(): false {
    return false
  }

  decorate(): React.JSX.Element {
    return <RefChip value={this.getRef()} />
  }
}

function BlockRefChip({ value }: { value: BlockRefValue }): React.JSX.Element {
  const { workspaceBase, unresolvedLabel, forbiddenLabel } = useContext(BlockRefRouteContext)
  const contract = blockRefExportContract(value, { workspaceBase, unresolvedLabel, forbiddenLabel })

  if (contract.megaContent === 'block-ref' && contract.href) {
    return (
      <a
        data-mega-content={contract.megaContent}
        data-target-block={contract.targetBlockId}
        data-target-doc={contract.targetDocId}
        href={contract.href}
      >
        {contract.text}
      </a>
    )
  }
  return (
    <span
      data-mega-content={contract.megaContent}
      data-target-block={contract.targetBlockId}
      data-target-doc={contract.targetDocId}
    >
      {contract.text}
    </span>
  )
}

export class ReaderBlockRefNode extends BlockRefNode {
  static getType(): string {
    return super.getType()
  }

  static clone(node: ReaderBlockRefNode): ReaderBlockRefNode {
    return new ReaderBlockRefNode(node.getBlockRef(), node.getKey())
  }

  static importJSON(serialized: SerializedBlockRefNode): ReaderBlockRefNode {
    return new ReaderBlockRefNode(serialized.blockRef)
  }

  createDOM(): HTMLElement {
    return document.createElement('span')
  }

  updateDOM(): false {
    return false
  }

  decorate(): React.JSX.Element {
    return <BlockRefChip value={this.getBlockRef()} />
  }
}

export class ReaderEmbedNode extends EmbedNode {
  static getType(): string {
    return super.getType()
  }

  static clone(node: ReaderEmbedNode): ReaderEmbedNode {
    return new ReaderEmbedNode(node.getEmbed(), node.getKey())
  }

  static importJSON(serialized: SerializedEmbedNode): ReaderEmbedNode {
    return new ReaderEmbedNode(serialized.embed)
  }

  createDOM(): HTMLElement {
    return document.createElement('div')
  }

  updateDOM(): false {
    return false
  }

  decorate(): React.JSX.Element {
    return <EmbedChipHost value={this.getEmbed()} />
  }
}

function EmbedChipHost({ value }: { value: EmbedValue }): React.JSX.Element | null {
  const Chip = useContext(EmbedChipContext)
  if (!Chip) return null
  return <Chip value={value} />
}

export type { BlockRefValue, EmbedValue, RefNodeValue }
