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

export type SerializedEmbedNode = Spread<{ text?: string; targetDocId?: string; label?: string; embed?: EmbedValue }, SerializedLexicalNode>

export function formatRoamEmbed(value: EmbedValue): string {
  const target = value.targetBlockId ? `((${value.targetBlockId}))` : `[[${value.label ?? value.targetDocId}]]`
  return `{{[[embed]]: ${target}}}`
}

export function parseRoamEmbed(text: string, targetDocId: string, label?: string): EmbedValue | null {
  const block = /^\{\{\[\[embed\]\]:\s*\(\(([^()]+)\)\)\}\}$/.exec(text)
  if (block) return { targetDocId, targetBlockId: block[1]!, ...(label !== undefined ? { label } : {}) }
  const page = /^\{\{\[\[embed\]\]:\s*\[\[(.*)\]\]\}\}$/.exec(text)
  if (page) return { targetDocId, ...(label !== undefined ? { label } : {}) }
  return null
}

export function embedFromSerialized(serialized: SerializedEmbedNode): EmbedValue {
  const value = typeof serialized.text === 'string' && typeof serialized.targetDocId === 'string'
    ? parseRoamEmbed(serialized.text, serialized.targetDocId, serialized.label)
    : serialized.embed
  if (!value) throw new Error('Invalid embed source')
  return value
}

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
  __source: string
  __targetDocId: string
  __label: string | null

  static getType(): string {
    return 'mega-embed'
  }

  static clone(node: EmbedNode): EmbedNode {
    return new EmbedNode(node.getEmbed(), node.__key)
  }

  constructor(embed: EmbedValue = { targetDocId: '' }, key?: NodeKey) {
    super(key)
    this.__source = formatRoamEmbed(embed)
    this.__targetDocId = embed.targetDocId
    this.__label = embed.label ?? null
  }

  static importJSON(serialized: SerializedEmbedNode): EmbedNode {
    return $createEmbedNode(embedFromSerialized(serialized))
  }

  exportJSON(): SerializedEmbedNode {
    return {
      ...super.exportJSON(),
      text: this.__source,
      targetDocId: this.__targetDocId,
      ...(this.__label !== null ? { label: this.__label } : {}),
      type: 'mega-embed',
      version: 1,
    }
  }

  getEmbed(): EmbedValue {
    const latest = this.getLatest()
    const embed = parseRoamEmbed(latest.__source, latest.__targetDocId, latest.__label ?? undefined)
    if (!embed) throw new Error('Invalid embed source')
    return embed
  }

  setEmbed(embed: EmbedValue): this {
    const writable = this.getWritable()
    writable.__source = formatRoamEmbed(embed)
    writable.__targetDocId = embed.targetDocId
    writable.__label = embed.label ?? null
    return writable
  }

  getTextContent(): string {
    const embed = this.getEmbed()
    return embed.label ?? embed.targetDocId
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
