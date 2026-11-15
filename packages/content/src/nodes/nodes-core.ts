/**
 * megaui:libs/react-shared/components/mega/content/nodes-core.ts@0ff3a9d
 *
 * Unlike `ref-node.ts` / `embed-node.ts` / `block-ref-node.ts` (DecoratorNode
 * chips split away from their React `decorate()` halves, GC-03 /
 * ADR-ARCH-01), the mega block vocabulary here is already React-free
 * upstream: `MegaBlockNode` / `MegaCodeBlockNode` / `MegaTableBlockNode` /
 * `MegaHrBlockNode` are plain Lexical `ElementNode` subclasses (their
 * `createDOM`/`updateDOM` reference `document`/`HTMLElement` the same way
 * Lexical's own built-in nodes do, but that only executes once an editor is
 * mounted to a real root element — never during `parseEditorState`/
 * `exportJSON`, so this file stays Node-importable). The core vocabulary is
 * ported from that reference; local table projections and empty-cell line
 * normalization extend it without changing the existing serialized types.
 */

import type {
  Klass,
  KlassConstructor,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedElementNode,
  Spread,
  SerializedLexicalNode,
} from 'lexical'
import { $applyNodeReplacement, $createParagraphNode, DecoratorNode, ElementNode } from 'lexical'
import { CodeHighlightNode, CodeNode, type SerializedCodeNode } from '@lexical/code-core'
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table'
import { generateBlockId } from '@megaui/core'
export { generateBlockId } from '@megaui/core'

/** Block body variant for MegaBlockNode (CE-30). */
export type MegaBlockVariant = 'text' | 'h1' | 'h2' | 'h3' | 'quote' | 'todo'

/** Nested list marker kind for outliner list items (CE-31). */
export type MegaListKind = 'bullet' | 'ordered'

export type SerializedMegaBlockNode = Spread<
  {
    blockId: string
    variant: MegaBlockVariant
    collapsed: boolean
    todoChecked: boolean
    listKind?: MegaListKind | null
    tableSource?: boolean
  },
  SerializedElementNode
>

export type SerializedMegaCodeBlockNode = Spread<
  {
    blockId: string
    language: string
  },
  SerializedCodeNode
>

export type SerializedMegaTableBlockNode = Spread<
  {
    blockId: string
  },
  SerializedElementNode
>

export type SerializedMegaOutlineTableNode = Spread<
  { blockId: string; sourceBlockId: string },
  SerializedLexicalNode
>

export type SerializedMegaHrBlockNode = Spread<
  {
    blockId: string
  },
  SerializedElementNode
>

function filterNestedBlockChildren(nodesToAppend: LexicalNode[]): LexicalNode[] {
  return nodesToAppend.filter((node) => !$isMegaBlockNode(node))
}

/**
 * CE-30 empty document seed: root holds a single empty text-variant block.
 * Nested representation follows ADR-CE-01: direct child MegaBlockNode children
 * (no grouping-container wrapper).
 *
 * Built as plain JSON (no Lexical createEditor) so Next.js / Node server paths
 * stay free of node-registration / ESM interop failures during empty-doc create.
 */
export function createEmptyMegaDocumentEditorStateJSON(): string {
  const blockId = generateBlockId()
  return JSON.stringify({
    root: {
      children: [
        {
          children: [],
          direction: null,
          format: '',
          indent: 0,
          type: 'mega-block',
          version: 1,
          blockId,
          variant: 'text',
          collapsed: false,
          todoChecked: false,
        },
      ],
      direction: null,
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  })
}

/**
 * Unified recursive block (CE-30). Own enumerable __* fields sync via @lexical/yjs
 * per workspace-collab-spike.md.
 */
export class MegaBlockNode extends ElementNode {
  declare ['constructor']: KlassConstructor<typeof MegaBlockNode>
  __blockId: string
  __variant: MegaBlockVariant
  __collapsed: boolean
  __todoChecked: boolean
  __listKind: MegaListKind | null
  __tableSource: boolean

  static getType(): string {
    return 'mega-block'
  }

  static clone(node: MegaBlockNode): MegaBlockNode {
    return new MegaBlockNode(
      node.__blockId,
      node.__variant,
      node.__collapsed,
      node.__todoChecked,
      node.__listKind,
      node.__tableSource,
      node.__key,
    )
  }

  constructor(
    blockId = '',
    variant: MegaBlockVariant = 'text',
    collapsed = false,
    todoChecked = false,
    listKind: MegaListKind | null = null,
    tableSource = false,
    key?: NodeKey,
  ) {
    super(key)
    this.__blockId = blockId
    this.__variant = variant
    this.__collapsed = collapsed
    this.__todoChecked = todoChecked
    this.__listKind = listKind
    this.__tableSource = tableSource
  }

  static importJSON(serialized: SerializedMegaBlockNode): MegaBlockNode {
    return $createMegaBlock(
      serialized.variant,
      serialized.blockId,
      serialized.collapsed,
      serialized.todoChecked,
      serialized.listKind ?? null,
      serialized.tableSource ?? false,
    )
  }

  exportJSON(): SerializedMegaBlockNode {
    return {
      ...super.exportJSON(),
      blockId: this.__blockId,
      variant: this.__variant,
      collapsed: this.__collapsed,
      todoChecked: this.__todoChecked,
      ...(this.__listKind ? { listKind: this.__listKind } : {}),
      ...(this.__tableSource ? { tableSource: true } : {}),
      type: 'mega-block',
      version: 1,
    }
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div')
    element.dataset.megaBlock = this.__variant
    element.dataset.blockId = this.__blockId
    if (this.__blockId) {
      element.id = `block-${this.__blockId}`
    }
    if (this.__collapsed) {
      element.dataset.collapsed = 'true'
    }
    if (this.__variant === 'todo') {
      element.dataset.todoChecked = String(this.__todoChecked)
    }
    if (this.__listKind) {
      element.dataset.listKind = this.__listKind
    }
    if (this.__tableSource) element.dataset.megaTableSource = 'true'
    return element
  }

  updateDOM(prevNode: MegaBlockNode, dom: HTMLElement): boolean {
    if (
      prevNode.__blockId !== this.__blockId
      || prevNode.__variant !== this.__variant
      || prevNode.__collapsed !== this.__collapsed
      || prevNode.__todoChecked !== this.__todoChecked
      || prevNode.__listKind !== this.__listKind
      || prevNode.__tableSource !== this.__tableSource
    ) {
      dom.dataset.megaBlock = this.__variant
      dom.dataset.blockId = this.__blockId
      if (this.__blockId) {
        dom.id = `block-${this.__blockId}`
      }
      if (this.__collapsed) {
        dom.dataset.collapsed = 'true'
      } else {
        dom.removeAttribute('data-collapsed')
      }
      if (this.__variant === 'todo') {
        dom.dataset.todoChecked = String(this.__todoChecked)
      } else {
        dom.removeAttribute('data-todo-checked')
      }
      if (this.__listKind) {
        dom.dataset.listKind = this.__listKind
      } else {
        dom.removeAttribute('data-list-kind')
      }
      if (this.__tableSource) dom.dataset.megaTableSource = 'true'
      else dom.removeAttribute('data-mega-table-source')
    }
    return false
  }

  getBlockId(): string {
    return this.getLatest().__blockId
  }

  setBlockId(blockId: string): this {
    const writable = this.getWritable()
    writable.__blockId = blockId
    return writable
  }

  getVariant(): MegaBlockVariant {
    return this.getLatest().__variant
  }

  setVariant(variant: MegaBlockVariant): this {
    const writable = this.getWritable()
    writable.__variant = variant
    return writable
  }

  getCollapsed(): boolean {
    return this.getLatest().__collapsed
  }

  setCollapsed(collapsed: boolean): this {
    const writable = this.getWritable()
    writable.__collapsed = collapsed
    return writable
  }

  getTodoChecked(): boolean {
    return this.getLatest().__todoChecked
  }

  setTodoChecked(todoChecked: boolean): this {
    const writable = this.getWritable()
    writable.__todoChecked = todoChecked
    return writable
  }

  getListKind(): MegaListKind | null {
    return this.getLatest().__listKind
  }

  setListKind(listKind: MegaListKind | null): this {
    const writable = this.getWritable()
    writable.__listKind = listKind
    return writable
  }

  getTableSource(): boolean {
    return this.getLatest().__tableSource
  }

  setTableSource(tableSource: boolean): this {
    this.getWritable().__tableSource = tableSource
    return this
  }

  canBeEmpty(): boolean {
    return true
  }

  isInline(): boolean {
    return false
  }

  /** Nested MegaBlockNode children are direct siblings of inline text (ADR-CE-01). */
  canInsertAfter(node: LexicalNode): boolean {
    return $isMegaBlockNode(node) || node.getType() === 'text' || node.getType() === 'linebreak'
  }
}

/** Leaf code container; cannot host nested MegaBlockNode children. */
export class MegaCodeBlockNode extends CodeNode {
  declare ['constructor']: KlassConstructor<typeof MegaCodeBlockNode>
  __blockId: string

  static getType(): string {
    return 'mega-code-block'
  }

  static clone(node: MegaCodeBlockNode): MegaCodeBlockNode {
    return new MegaCodeBlockNode(node.__blockId, node.__language ?? undefined, node.__key)
  }

  constructor(blockId = '', language?: string, key?: NodeKey) {
    super(language, key)
    this.__blockId = blockId
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode)
    this.__blockId = prevNode.__blockId
  }

  static importJSON(serialized: SerializedMegaCodeBlockNode): MegaCodeBlockNode {
    const node = $createMegaCodeBlock(serialized.blockId, serialized.language)
    node.updateFromJSON(serialized)
    return node
  }

  exportJSON(): SerializedMegaCodeBlockNode {
    return {
      ...super.exportJSON(),
      blockId: this.__blockId,
      language: this.getLanguage() ?? '',
      type: 'mega-code-block',
      version: 1,
    }
  }

  getBlockId(): string {
    return this.getLatest().__blockId
  }

  setBlockId(blockId: string): this {
    const writable = this.getWritable()
    writable.__blockId = blockId
    return writable
  }

  canInsertAfter(node: LexicalNode): boolean {
    return !$isMegaBlockNode(node) && super.canInsertAfter(node)
  }

  append(...nodesToAppend: LexicalNode[]): this {
    return super.append(...filterNestedBlockChildren(nodesToAppend))
  }
}

/** Leaf table container wrapping a Lexical TableNode subtree. */
export class MegaTableBlockNode extends ElementNode {
  declare ['constructor']: KlassConstructor<typeof MegaTableBlockNode>
  __blockId: string

  static getType(): string {
    return 'mega-table-block'
  }

  static clone(node: MegaTableBlockNode): MegaTableBlockNode {
    return new MegaTableBlockNode(node.__blockId, node.__key)
  }

  constructor(blockId = '', key?: NodeKey) {
    super(key)
    this.__blockId = blockId
  }

  static importJSON(serialized: SerializedMegaTableBlockNode): MegaTableBlockNode {
    const node = $createMegaTableBlock(serialized.blockId)
    node.updateFromJSON(serialized)
    return node
  }

  exportJSON(): SerializedMegaTableBlockNode {
    return {
      ...super.exportJSON(),
      blockId: this.__blockId,
      type: 'mega-table-block',
      version: 1,
    }
  }

  createDOM(): HTMLElement {
    const element = document.createElement('div')
    element.dataset.megaTableBlock = 'true'
    element.dataset.blockId = this.__blockId
    return element
  }

  updateDOM(prevNode: MegaTableBlockNode, dom: HTMLElement): boolean {
    if (prevNode.__blockId !== this.__blockId) {
      dom.dataset.blockId = this.__blockId
    }
    return false
  }

  getBlockId(): string {
    return this.getLatest().__blockId
  }

  setBlockId(blockId: string): this {
    const writable = this.getWritable()
    writable.__blockId = blockId
    return writable
  }

  canBeEmpty(): boolean {
    return false
  }

  isInline(): boolean {
    return false
  }

  canInsertAfter(node: LexicalNode): boolean {
    return !$isMegaBlockNode(node)
  }

  append(...nodesToAppend: LexicalNode[]): this {
    return super.append(...filterNestedBlockChildren(nodesToAppend))
  }
}

/** Table projection that reads ordinary outliner blocks by stable sourceBlockId. */
export class MegaOutlineTableNode extends DecoratorNode<unknown> {
  __blockId: string
  __sourceBlockId: string

  static getType(): string { return 'mega-outline-table' }

  static clone(node: MegaOutlineTableNode): MegaOutlineTableNode {
    return new MegaOutlineTableNode(node.__blockId, node.__sourceBlockId, node.__key)
  }

  constructor(blockId: string, sourceBlockId: string, key?: NodeKey) {
    super(key)
    this.__blockId = blockId
    this.__sourceBlockId = sourceBlockId
  }

  static importJSON(serialized: SerializedMegaOutlineTableNode): MegaOutlineTableNode {
    return new MegaOutlineTableNode(serialized.blockId, serialized.sourceBlockId)
  }

  exportJSON(): SerializedMegaOutlineTableNode {
    return {
      ...super.exportJSON(),
      blockId: this.__blockId,
      sourceBlockId: this.__sourceBlockId,
      type: 'mega-outline-table',
      version: 1,
    }
  }

  getBlockId(): string { return this.getLatest().__blockId }
  getSourceBlockId(): string { return this.getLatest().__sourceBlockId }
  setBlockId(blockId: string): this { this.getWritable().__blockId = blockId; return this }
  isInline(): boolean { return false }
}

export function $createMegaOutlineTable(blockId: string, sourceBlockId: string): MegaOutlineTableNode {
  return $applyNodeReplacement(new MegaOutlineTableNode(blockId, sourceBlockId))
}

export function $isMegaOutlineTableNode(node: LexicalNode | null | undefined): node is MegaOutlineTableNode {
  return node instanceof MegaOutlineTableNode
}

/** Leaf horizontal rule block (non-nesting). */
export class MegaHrBlockNode extends ElementNode {
  declare ['constructor']: KlassConstructor<typeof MegaHrBlockNode>
  __blockId: string

  static getType(): string {
    return 'mega-hr-block'
  }

  static clone(node: MegaHrBlockNode): MegaHrBlockNode {
    return new MegaHrBlockNode(node.__blockId, node.__key)
  }

  constructor(blockId = '', key?: NodeKey) {
    super(key)
    this.__blockId = blockId
  }

  static importJSON(serialized: SerializedMegaHrBlockNode): MegaHrBlockNode {
    const node = $createMegaHrBlock(serialized.blockId)
    node.updateFromJSON(serialized)
    return node
  }

  exportJSON(): SerializedMegaHrBlockNode {
    return {
      ...super.exportJSON(),
      blockId: this.__blockId,
      type: 'mega-hr-block',
      version: 1,
    }
  }

  createDOM(): HTMLElement {
    const element = document.createElement('hr')
    element.dataset.blockId = this.__blockId
    return element
  }

  updateDOM(prevNode: MegaHrBlockNode, dom: HTMLElement): boolean {
    if (prevNode.__blockId !== this.__blockId) {
      dom.dataset.blockId = this.__blockId
    }
    return false
  }

  getBlockId(): string {
    return this.getLatest().__blockId
  }

  setBlockId(blockId: string): this {
    const writable = this.getWritable()
    writable.__blockId = blockId
    return writable
  }

  canBeEmpty(): boolean {
    return true
  }

  isInline(): boolean {
    return false
  }

  canInsertAfter(node: LexicalNode): boolean {
    return !$isMegaBlockNode(node)
  }

  append(...nodesToAppend: LexicalNode[]): this {
    return super.append(...filterNestedBlockChildren(nodesToAppend))
  }
}

export function $createMegaBlock(
  variant: MegaBlockVariant = 'text',
  blockId = '',
  collapsed = false,
  todoChecked = false,
  listKind: MegaListKind | null = null,
  tableSource = false,
): MegaBlockNode {
  return $applyNodeReplacement(new MegaBlockNode(blockId, variant, collapsed, todoChecked, listKind, tableSource))
}

export function $isMegaBlockNode(node: LexicalNode | null | undefined): node is MegaBlockNode {
  return node instanceof MegaBlockNode
}

export function $createMegaCodeBlock(blockId = '', language = ''): MegaCodeBlockNode {
  const node = new MegaCodeBlockNode(blockId, language || undefined)
  return $applyNodeReplacement(node)
}

export function $isMegaCodeBlockNode(node: LexicalNode | null | undefined): node is MegaCodeBlockNode {
  return node instanceof MegaCodeBlockNode
}

export function $createMegaTableBlock(blockId = ''): MegaTableBlockNode {
  return $applyNodeReplacement(new MegaTableBlockNode(blockId))
}

export function $isMegaTableBlockNode(node: LexicalNode | null | undefined): node is MegaTableBlockNode {
  return node instanceof MegaTableBlockNode
}

export function $createMegaHrBlock(blockId = ''): MegaHrBlockNode {
  return $applyNodeReplacement(new MegaHrBlockNode(blockId))
}

export function $isMegaHrBlockNode(node: LexicalNode | null | undefined): node is MegaHrBlockNode {
  return node instanceof MegaHrBlockNode
}

export function $isMegaLeafContainerNode(node: LexicalNode | null | undefined): node is MegaCodeBlockNode | MegaTableBlockNode | MegaHrBlockNode {
  return $isMegaCodeBlockNode(node) || $isMegaTableBlockNode(node) || $isMegaHrBlockNode(node)
}

/** Builds a minimal one-cell table under a MegaTableBlockNode. */
export function $createMegaTableBlockWithEmptyGrid(blockId = ''): MegaTableBlockNode {
  const wrapper = $createMegaTableBlock(blockId)
  const table = new TableNode()
  const row = new TableRowNode()
  const cell = new TableCellNode()
  const paragraph = $createParagraphNode()
  cell.append(paragraph)
  row.append(cell)
  table.append(row)
  wrapper.append(table)
  return wrapper
}

/**
 * Node-safe block vocabulary (no React imports) for server-side headless editors
 * and markdown/import pipelines (ADR-WS-10 continuation).
 */
export const MEGA_CONTENT_BLOCK_NODES: Klass<LexicalNode>[] = [
  MegaBlockNode,
  MegaCodeBlockNode,
  MegaTableBlockNode,
  MegaOutlineTableNode,
  MegaHrBlockNode,
  TableNode,
  TableRowNode,
  TableCellNode,
  CodeNode,
  CodeHighlightNode,
]

type BlockIdCarrier = {
  getBlockId: () => string
  setBlockId: (blockId: string) => unknown
}

function isBlockIdCarrier(node: LexicalNode): node is LexicalNode & BlockIdCarrier {
  const carrier = node as unknown as BlockIdCarrier
  return typeof carrier.getBlockId === 'function' && typeof carrier.setBlockId === 'function'
}

function registerBlockIdTransform<T extends LexicalNode>(
  editor: LexicalEditor,
  klass: Klass<T>,
): () => void {
  return editor.registerNodeTransform(klass, (node) => {
    if (isBlockIdCarrier(node) && !node.getBlockId()) {
      node.setBlockId(generateBlockId())
    }
  })
}

/**
 * Headless-safe invariants for MEGA_CONTENT_BLOCK_NODES consumers (CE-33 importers,
 * server editors): auto-fill missing blockId, strip illegal leaf nesting,
 * and preserve an editable line in empty table cells with nested columns.
 */
export function registerMegaContentInvariants(editor: LexicalEditor): () => void {
  const unregisterBlockIds = [
    editor.hasNodes([MegaBlockNode]) ? registerBlockIdTransform(editor, MegaBlockNode) : () => {},
    editor.hasNodes([MegaCodeBlockNode]) ? registerBlockIdTransform(editor, MegaCodeBlockNode) : () => {},
    editor.hasNodes([MegaTableBlockNode]) ? registerBlockIdTransform(editor, MegaTableBlockNode) : () => {},
    editor.hasNodes([MegaOutlineTableNode]) ? registerBlockIdTransform(editor, MegaOutlineTableNode) : () => {},
    editor.hasNodes([MegaHrBlockNode]) ? registerBlockIdTransform(editor, MegaHrBlockNode) : () => {},
  ]

  const unregisterLeafGuard = editor.hasNodes([MegaBlockNode])
    ? editor.registerNodeTransform(MegaBlockNode, (node) => {
        const parent = node.getParent()
        if ($isMegaLeafContainerNode(parent)) {
          node.remove()
          return
        }
        const first = node.getFirstChild()
        if (!node.getTableSource() && $isMegaBlockNode(first)
          && node.getParents().some((ancestor) => $isMegaBlockNode(ancestor) && ancestor.getTableSource())) {
          // Without an inline line, the browser places clicks in the nested
          // column instead of this empty cell. ParagraphNode supplies a caret.
          first.insertBefore($createParagraphNode())
        }
      })
    : () => {}

  return () => {
    unregisterLeafGuard()
    for (const unregister of unregisterBlockIds) {
      unregister()
    }
  }
}
