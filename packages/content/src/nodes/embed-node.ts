/**
 * megaui:libs/react-shared/components/mega/content/nodes/embed-node.tsx@0ff3a9d
 * megaui:libs/react-shared/components/mega/content/embed-context.tsx@0ff3a9d (embedHref only)
 *
 * Intentional diff vs upstream (GC-03 / ADR-ARCH-01): same split as
 * `ref-node.ts` — the Lexical node (JSON import/export) and the pure
 * `embedExportContract` route/label logic live here in `@megaui/content`;
 * the React `<Suspense>` lazy renderer and route context are a UI-06
 * concern and are not ported.
 */

import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'


function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1
  return value.slice(0, end)
}

/** CE-52 embed payload — page embed omits targetBlockId; block embed sets it. */
export interface EmbedValue {
  targetDocId: string
  targetBlockId?: string
  label?: string
}

export type SerializedEmbedNode = Spread<{ embed: EmbedValue }, SerializedLexicalNode>

export function embedHref(value: EmbedValue, workspaceBase: string): string {
  const base = trimTrailingSlashes(workspaceBase) || '/workspace'
  const docPath = `${base}/docs/${encodeURIComponent(value.targetDocId)}`
  if (value.targetBlockId) {
    return `${docPath}?block=${encodeURIComponent(value.targetBlockId)}`
  }
  return docPath
}

/** Pure export contract for headless tests and server/UI rendering alike (CE-52). */
export function embedExportContract(
  value: EmbedValue,
  options: { workspaceBase: string },
): {
  megaContent: 'embed-page' | 'embed-block'
  href: string
  text: string
  targetDocId: string
  targetBlockId?: string
} {
  const isBlock = Boolean(value.targetBlockId)
  return {
    megaContent: isBlock ? 'embed-block' : 'embed-page',
    href: embedHref(value, options.workspaceBase),
    text: value.label ?? value.targetDocId,
    targetDocId: value.targetDocId,
    targetBlockId: value.targetBlockId,
  }
}

/** CE-52/53: `{{` embed DecoratorNode — nested snapshot via a UI-package renderer. */
export class EmbedNode extends DecoratorNode<unknown> {
  __embed: EmbedValue

  static getType(): string {
    return 'mega-embed'
  }

  static clone(node: EmbedNode): EmbedNode {
    return new EmbedNode(node.__embed, node.__key)
  }

  constructor(embed: EmbedValue, key?: NodeKey) {
    super(key)
    this.__embed = embed
  }

  static importJSON(serialized: SerializedEmbedNode): EmbedNode {
    return $createEmbedNode(serialized.embed)
  }

  exportJSON(): SerializedEmbedNode {
    return {
      ...super.exportJSON(),
      embed: this.__embed,
      type: 'mega-embed',
      version: 1,
    }
  }

  getEmbed(): EmbedValue {
    return this.__embed
  }

  setEmbed(embed: EmbedValue): this {
    const writable = this.getWritable()
    writable.__embed = embed
    return writable
  }

  getTextContent(): string {
    return this.__embed.label ?? this.__embed.targetDocId
  }

  isInline(): boolean {
    return false
  }
}

export function $createEmbedNode(embed: EmbedValue): EmbedNode {
  return new EmbedNode(embed)
}

export function $isEmbedNode(node: LexicalNode | null | undefined): node is EmbedNode {
  return node instanceof EmbedNode
}
