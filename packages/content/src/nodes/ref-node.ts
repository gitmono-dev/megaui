/**
 * megaui:libs/react-shared/components/mega/content/nodes/ref-node.tsx@0ff3a9d
 *
 * Intentional diff vs upstream (GC-03 / ADR-ARCH-01): upstream bundles the
 * Lexical node class together with a React `decorate()` chip and a route
 * context, which is exactly the mega↔react-shared import cycle this task
 * sinks away from. This port keeps the Lexical `DecoratorNode` (JSON
 * import/export + the pure `refExportContract` route/label logic) here in
 * `@megaui/content` — server-importable, zero React — and leaves
 * `decorate()` at the Lexical base-class default (returns `null`); a future
 * UI package (UI-06) subclasses `RefNode` to add the real React chip.
 */

import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'

/** CE-40 unified wiki/entity reference kinds (BlockRef lands in CE-51). */
export type RefNodeKind = 'doc' | 'issue' | 'cl' | 'user' | 'block'
export type DocRefNotation = 'wikilink' | 'tag'

export interface RefNodeValue {
  kind: RefNodeKind
  /** Pages entered with `#` use tag notation; `[[` is the default. */
  notation?: DocRefNotation
  /** New tags own their hash; legacy tags store it in the preceding text node. */
  tagPrefix?: 'inline'
  targetTitle: string
  /** Empty / omitted means unresolved (create-page entry). */
  targetId?: string
}

export type SerializedRefNode = Spread<{ ref: RefNodeValue }, SerializedLexicalNode>

function resolvedHref(ref: RefNodeValue, workspaceBase: string): string | undefined {
  if (!ref.targetId) return undefined
  const base = workspaceBase.replace(/\/+$/, '') || '/workspace'
  switch (ref.kind) {
    case 'doc':
      return `${base}/docs/${encodeURIComponent(ref.targetId)}`
    case 'issue': {
      const number = Number(ref.targetId)
      return Number.isFinite(number) ? `${base}/issues/${number}` : undefined
    }
    case 'cl': {
      const number = Number(ref.targetId)
      return Number.isFinite(number) ? `${base}/cls/${number}` : undefined
    }
    case 'user':
      return `${base}/dm/${encodeURIComponent(ref.targetId)}`
    case 'block':
      // Block zoom routes arrive in CE-51; keep a stable docs-scoped fragment until then.
      return `${base}/docs/${encodeURIComponent(ref.targetId)}#block`
    default: {
      const _exhaustive: never = ref.kind
      return _exhaustive
    }
  }
}

function displayTitle(ref: RefNodeValue, titleById?: Readonly<Record<string, string>>): string {
  if (ref.targetId && titleById?.[ref.targetId]) return titleById[ref.targetId]!
  return ref.targetTitle
}

function referenceText(ref: RefNodeValue, title: string): string {
  if (ref.kind === 'doc' && ref.notation === 'tag' && ref.tagPrefix === 'inline') return `#${title}`
  return ref.kind === 'doc' && ref.notation !== 'tag' ? `[[${title}]]` : title
}

/** Pure export contract for headless tests and server/UI rendering alike (CE-40). */
export function refExportContract(
  ref: RefNodeValue,
  options: { workspaceBase: string; createLabel?: string; titleById?: Readonly<Record<string, string>> },
): {
  tagName: 'a' | 'span' | 'button'
  megaContent: 'ref' | 'ref-unresolved'
  kind: RefNodeKind
  href?: string
  text: string
} {
  const title = displayTitle(ref, options.titleById)
  if (!ref.targetId) {
    return {
      tagName: 'button',
      megaContent: 'ref-unresolved',
      kind: ref.kind,
      text: ref.kind === 'doc' && ref.notation === 'tag'
        ? referenceText(ref, title)
        : options.createLabel ? options.createLabel.replace('{title}', title) : `[[${title}]]`,
    }
  }
  const href = resolvedHref(ref, options.workspaceBase)
  return {
    tagName: href ? 'a' : 'span',
    megaContent: 'ref',
    kind: ref.kind,
    href,
    text: referenceText(ref, title),
  }
}

/** CE-40: unified `[[wikilink]]` / entity reference DecoratorNode. */
export class RefNode extends DecoratorNode<unknown> {
  __ref: RefNodeValue

  static getType(): string {
    return 'mega-ref'
  }

  static clone(node: RefNode): RefNode {
    return new RefNode(node.__ref, node.__key)
  }

  constructor(ref: RefNodeValue, key?: NodeKey) {
    super(key)
    this.__ref = ref
  }

  static importJSON(serialized: SerializedRefNode): RefNode {
    return $createRefNode(serialized.ref)
  }

  exportJSON(): SerializedRefNode {
    return { ...super.exportJSON(), ref: this.__ref, type: 'mega-ref', version: 1 }
  }

  getRef(): RefNodeValue {
    return this.__ref
  }

  setRef(ref: RefNodeValue): this {
    const writable = this.getWritable()
    writable.__ref = ref
    return writable
  }

  getTextContent(): string {
    return referenceText(this.__ref, this.__ref.targetTitle)
  }

  isInline(): boolean {
    return true
  }
}

export function $createRefNode(ref: RefNodeValue): RefNode {
  return new RefNode(ref)
}

export function $isRefNode(node: LexicalNode | null | undefined): node is RefNode {
  return node instanceof RefNode
}
