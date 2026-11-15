/**
 * megaui:libs/react-shared/components/mega/content/nodes/block-ref-node.tsx@0ff3a9d
 *
 * Intentional diff vs upstream (GC-03 / ADR-ARCH-01): same split as
 * `ref-node.ts` — the Lexical node (JSON import/export) and the pure
 * `blockRefExportContract` route/label/status logic live here in
 * `@megaui/content`; the React chip (with its live `resolveStatus`
 * effect) is a UI-06 concern and is not ported.
 * Local inline references persist document/search binding independently of
 * resolution status, so unavailable copied sources keep their identity.
 */

import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'

/** CE-51 block reference payload (two-id shape — not RefNode). */
export interface BlockRefValue {
  targetDocId: string
  targetBlockId: string
  label: string
  /** Optional breadcrumb path from blocks/search (doc › path › summary). */
  sourcePath?: string
  /** Explicit unresolved / forbidden states for placeholder chrome. */
  status?: 'ok' | 'unresolved' | 'forbidden'
  /** Omitted means an explicit document target; only bare syntax starts a search. */
  binding?: 'document' | 'search'
}

export type SerializedBlockRefNode = Spread<{ blockRef: BlockRefValue }, SerializedLexicalNode>

export type BlockRefLiveStatus = 'ok' | 'unresolved' | 'forbidden'

export function blockRefHref(value: BlockRefValue, workspaceBase: string): string {
  const base = workspaceBase.replace(/\/+$/, '') || '/workspace'
  return `${base}/docs/${encodeURIComponent(value.targetDocId)}?block=${encodeURIComponent(value.targetBlockId)}`
}

/** Pure export contract for headless tests and server/UI rendering alike (CE-51). */
export function blockRefExportContract(
  value: BlockRefValue,
  options: { workspaceBase: string; unresolvedLabel?: string; forbiddenLabel?: string },
): {
  megaContent: 'block-ref' | 'block-ref-unresolved' | 'block-ref-forbidden'
  href?: string
  text: string
  targetDocId: string
  targetBlockId: string
} {
  const status = value.status
    ?? (value.targetDocId && value.targetBlockId ? 'ok' : 'unresolved')
  if (status === 'forbidden') {
    return {
      megaContent: 'block-ref-forbidden',
      text: options.forbiddenLabel ?? value.label,
      targetDocId: value.targetDocId,
      targetBlockId: value.targetBlockId,
    }
  }
  if (status === 'unresolved' || !value.targetDocId || !value.targetBlockId) {
    return {
      megaContent: 'block-ref-unresolved',
      text: options.unresolvedLabel ?? value.label,
      targetDocId: value.targetDocId,
      targetBlockId: value.targetBlockId,
    }
  }
  return {
    megaContent: 'block-ref',
    href: blockRefHref(value, options.workspaceBase),
    text: value.label,
    targetDocId: value.targetDocId,
    targetBlockId: value.targetBlockId,
  }
}

/** CE-51: `((` block reference DecoratorNode (escaped readonly chrome). */
export class BlockRefNode extends DecoratorNode<unknown> {
  __blockRef: BlockRefValue

  static getType(): string {
    return 'mega-block-ref'
  }

  static clone(node: BlockRefNode): BlockRefNode {
    return new BlockRefNode(node.__blockRef, node.__key)
  }

  constructor(blockRef: BlockRefValue, key?: NodeKey) {
    super(key)
    this.__blockRef = blockRef
  }

  static importJSON(serialized: SerializedBlockRefNode): BlockRefNode {
    return $createBlockRefNode(serialized.blockRef)
  }

  exportJSON(): SerializedBlockRefNode {
    return {
      ...super.exportJSON(),
      blockRef: this.__blockRef,
      type: 'mega-block-ref',
      version: 1,
    }
  }

  getBlockRef(): BlockRefValue {
    return this.__blockRef
  }

  setBlockRef(blockRef: BlockRefValue): this {
    const writable = this.getWritable()
    writable.__blockRef = blockRef
    return writable
  }

  getTextContent(): string {
    return this.__blockRef.label
  }

  isInline(): boolean {
    return true
  }
}

export function $createBlockRefNode(blockRef: BlockRefValue): BlockRefNode {
  return new BlockRefNode(blockRef)
}

export function $isBlockRefNode(node: LexicalNode | null | undefined): node is BlockRefNode {
  return node instanceof BlockRefNode
}
