/**
 * Reader core (no embed-live / embed-renderer imports) so nested embed modules
 * can render MegaContentReader without circular deps (CMD-03 no-circular).
 *
 * Public wiring lives in `./reader.tsx`. Provenance of the surface:
 * megaui:libs/react-shared/components/mega/content/reader.tsx@0ff3a9d
 *
 * Diff vs upstream (GC-03, UI-07):
 * - Consumes `@megaui/content`'s node vocabulary (`MEGA_CONTENT_BLOCK_NODES`)
 *   plus this package's `./nodes` React-decorated `Reader*Node` subclasses,
 *   instead of react-shared's pre-split nodes-core (ADR-ARCH-01 cross-package
 *   diff called out on the UI-07 task card).
 * - Drops the `ContentPreset` (`document`/`comment`/`chat`) node-set switch
 *   and the block-hover-menu / focus-block-awareness editing plugins:
 *   `preset.ts` and those plugins live in the editable surface (UI-06,
 *   out of scope here per the task card) and were not part of this card's
 *   reference file list. This reader always registers the full block
 *   vocabulary (document-level) and is read-only.
 * - The Shiki code theme is resolved locally from the `.dark` root class
 *   instead of importing `code-view/theme.ts` (a UI-08 file, also out of
 *   this card's write set).
 * - `@megaui/content`'s code block (`MegaCodeBlockNode`) registers under its
 *   own Lexical type (`mega-code-block`), not `code`. `@lexical/code-shiki`'s
 *   `registerCodeHighlighting` keys its mutation listener / node transform to
 *   the exact `CodeNode` type string, so it never observes `mega-code-block`
 *   instances. Rather than silently ship a no-op highlighter, this module
 *   registers its own `MegaCodeBlockNode` transform that reuses
 *   `ShikiTokenizer.$tokenize` (the same tokenizer `registerCodeHighlighting`
 *   uses internally) to split code text into highlighted `CodeHighlightNode`
 *   children.
 * - Upstream prepends the todo-checkbox / collapse-toggle `<button>` directly
 *   into the reconciled block DOM. Lexical's root mutation observer reverts
 *   any child inserted into its managed subtree that isn't backed by a node
 *   in the `EditorState` (attribute changes on existing elements are left
 *   alone, but foreign child nodes are removed on the next microtask). This
 *   port renders those affordances as an absolutely-positioned overlay layer
 *   *outside* the `contentEditable` root instead, synced to block positions
 *   via `getBoundingClientRect` on every editor update / resize.
 * - Embed chip + live-slot factories are injected via props (not imported)
 *   so `embed-renderer` / `embed-live` can nest this core without cycles.
 */
'use client'

import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Klass, LexicalEditor, LexicalNode } from 'lexical'
import { isCodeLanguageLoaded, loadCodeLanguage, loadCodeTheme, ShikiTokenizer } from '@lexical/code-shiki'
import { LexicalComposer, type InitialConfigType } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { AutoLinkNode, LinkNode } from '@lexical/link'
import { ReaderImageNode } from './image-node'
import { TagReferencesPlugin } from '../tag-references'
import { EditorOutlineTableNode } from '../editor/outline-table-node'
import { MEGA_CONTENT_BLOCK_NODES, MegaCodeBlockNode } from '@megaui/content'
import { en, zhCN } from '@megaui/i18n'
import {
  BlockRefRouteContext,
  EmbedChipContext,
  ReaderBlockRefNode,
  ReaderEmbedNode,
  ReaderRefNode,
  type BlockRefRouteConfig,
  type EmbedChipComponent,
  type RefRouteConfig,
  RefRouteContext,
} from './nodes'
import {
  EmbedRouteContext,
  type EmbedLiveSlotArgs,
  type EmbedRendererLabels,
} from './embed-context'

const READER_NODES: Klass<LexicalNode>[] = [
  ReaderRefNode,
  ReaderEmbedNode,
  ReaderBlockRefNode,
  LinkNode,
  AutoLinkNode,
  ReaderImageNode,
  ...MEGA_CONTENT_BLOCK_NODES.filter((node) => node.getType() !== 'mega-outline-table'),
  EditorOutlineTableNode,
]

const READER_BLOCK_STYLES = `
[data-mega-content="reader"] [data-mega-block="h1"] { font-size: calc(var(--mega-density-font-size, 15px) + 11px); font-weight: 800; line-height: 1.25; margin: 0 0 14px; }
[data-mega-content="reader"] [data-mega-block="h2"] { font-size: calc(var(--mega-density-font-size, 15px) + 5px); font-weight: 700; line-height: 1.3; margin: 26px 0 10px; }
[data-mega-content="reader"] [data-mega-block="h3"] { font-size: calc(var(--mega-density-font-size, 15px) + 2px); font-weight: 700; line-height: 1.35; margin: 20px 0 8px; }
[data-mega-content="reader"] [data-mega-block="quote"] { border-left: 3px solid var(--mega-accent); color: var(--mega-muted); margin: 0 0 12px; padding: 2px 0 2px 14px; }
[data-mega-content="reader"] [data-mega-block="todo"] { margin: 0 0 8px; padding-left: 22px; position: relative; }
[data-mega-content="reader"] [data-has-collapse-toggle="true"] { padding-left: 18px; position: relative; }
[data-mega-content="reader-overlay"] [data-mega-content="todo-check"] {
  background: transparent; border: 1px solid var(--mega-border); border-radius: 4px; cursor: pointer;
  height: 14px; margin-top: 3px; padding: 0; width: 14px;
}
[data-mega-content="reader-overlay"] [data-mega-content="todo-check"][aria-pressed="true"] {
  background: var(--mega-accent); border-color: var(--mega-accent);
}
[data-mega-content="reader"] [data-list-kind="bullet"]::before { content: '• '; color: var(--mega-muted); }
[data-mega-content="reader"] [data-list-kind="ordered"]::before { content: attr(data-list-index) '. '; color: var(--mega-muted); }
[data-mega-content="reader"] [data-collapsed="true"] > [data-mega-block] { display: none; }
[data-mega-content="reader"] [data-mega-table-source="true"][data-collapsed="true"] { display: none; }
[data-mega-content="reader-overlay"] [data-mega-content="collapse-toggle"] {
  background: transparent; border: none; color: var(--mega-muted); cursor: pointer; font: inherit; padding: 0;
}
[data-mega-content="reader-overlay"] [data-table-outline="true"] {
  align-items: center; display: flex; height: 14px; justify-content: center; width: 14px;
}
[data-mega-content="reader-overlay"] [data-table-outline="true"]::before {
  border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid currentColor; content: "";
}
[data-mega-content="reader-overlay"] [data-table-outline="true"][aria-expanded="false"]::before { transform: rotate(-90deg); }
[data-mega-content="reader-overlay"] [data-table-outline="true"]:focus-visible {
  outline: 2px solid var(--mega-accent); outline-offset: 1px;
}
[data-mega-block-highlight="true"] {
  background: color-mix(in srgb, var(--mega-accent) 18%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--mega-accent) 55%, transparent);
  border-radius: 4px;
  transition: background 0.25s ease, box-shadow 0.25s ease;
}
`

/** Local light/dark resolution (no `code-view/theme.ts` dependency; see module header). */
function useReaderCodeTheme(): 'github-dark' | 'github-light' {
  const [isDark, setIsDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  )
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined
    const root = document.documentElement
    const observer = new MutationObserver(() => setIsDark(root.classList.contains('dark')))
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return isDark ? 'github-dark' : 'github-light'
}

/**
 * Tokenizes `MegaCodeBlockNode` text into highlighted `CodeHighlightNode`
 * children via Shiki. See the module-level "Diff vs upstream" note: this
 * exists because `registerCodeHighlighting` only watches the base `CodeNode`
 * type string, which `MegaCodeBlockNode` (type `mega-code-block`) never
 * matches.
 */
function registerMegaCodeHighlighting(editor: LexicalEditor, defaultTheme: string): () => void {
  const tokenizer = { ...ShikiTokenizer, defaultTheme }
  const lastSignature = new Map<string, string>()
  return editor.registerNodeTransform(MegaCodeBlockNode, (node) => {
    const key = node.getKey()
    const language = node.getLanguage() || undefined
    let theme = node.getTheme()
    if (!theme) {
      theme = tokenizer.defaultTheme
      node.setTheme(theme)
    }
    if (!language) {
      return
    }
    let pending = false
    if (!isCodeLanguageLoaded(language)) {
      loadCodeLanguage(language, editor, key)
      pending = true
    }
    if (loadCodeTheme(theme, editor, key)) {
      pending = true
    }
    if (pending) {
      return
    }
    const text = node.getTextContent()
    const signature = `${language}::${theme}::${text}`
    if (lastSignature.get(key) === signature) {
      return
    }
    const highlightNodes = tokenizer.$tokenize(node, language)
    node.splice(0, node.getChildrenSize(), highlightNodes)
    lastSignature.set(key, signature)
  })
}

function CodeShikiPlugin() {
  const [editor] = useLexicalComposerContext()
  const themeType = useReaderCodeTheme()
  useEffect(() => {
    return registerMegaCodeHighlighting(editor, themeType)
  }, [editor, themeType])
  return null
}

/**
 * Creates (once) or repositions an overlay button tracking `blockEl`. The
 * button lives in `overlay` (a sibling of the `contentEditable` root, see
 * module header), so Lexical's mutation observer never reverts it.
 */
function syncOverlayButton(
  overlay: HTMLElement,
  overlayKey: string,
  overlayRect: DOMRect,
  blockEl: HTMLElement,
  configure: (button: HTMLButtonElement, isNew: boolean) => void,
): HTMLButtonElement {
  let button = overlay.querySelector<HTMLButtonElement>(`[data-overlay-key="${overlayKey}"]`)
  const isNew = !button
  if (!button) {
    button = document.createElement('button')
    button.type = 'button'
    button.dataset.overlayKey = overlayKey
    button.style.position = 'absolute'
    button.style.pointerEvents = 'auto'
    overlay.appendChild(button)
  }
  const blockRect = blockEl.getBoundingClientRect()
  button.style.top = `${blockRect.top - overlayRect.top}px`
  button.style.left = `${blockRect.left - overlayRect.left}px`
  configure(button, isNew)
  return button
}

function syncInteractiveOverlay(
  rootElement: HTMLElement,
  overlay: HTMLElement,
  onTodoToggle?: (blockId: string, checked: boolean) => void,
  onCollapsedChange?: (blockId: string, collapsed: boolean) => void,
): void {
  const overlayRect = overlay.getBoundingClientRect()
  const seenKeys = new Set<string>()
  const tables = [...rootElement.querySelectorAll<HTMLElement>('[data-mega-outline-table][data-source-block-id]')]
  const collapseLabels = (rootElement.ownerDocument.documentElement.lang.startsWith('zh') ? zhCN : en).workspace.docEdit.blockCollapse

  rootElement.querySelectorAll('[data-mega-block="todo"][data-block-id]').forEach((element) => {
    const blockEl = element as HTMLElement
    const blockId = blockEl.getAttribute('data-block-id')
    if (!blockId || blockEl.parentElement?.closest('[data-collapsed="true"]')) {
      return
    }
    const overlayKey = `todo:${blockId}`
    seenKeys.add(overlayKey)
    syncOverlayButton(overlay, overlayKey, overlayRect, blockEl, (button, isNew) => {
      button.dataset.megaContent = 'todo-check'
      button.setAttribute('aria-pressed', blockEl.getAttribute('data-todo-checked') === 'true' ? 'true' : 'false')
      if (isNew) {
        button.addEventListener('click', (event) => {
          event.preventDefault()
          const checked = blockEl.getAttribute('data-todo-checked') !== 'true'
          blockEl.setAttribute('data-todo-checked', String(checked))
          button.setAttribute('aria-pressed', String(checked))
          onTodoToggle?.(blockId, checked)
        })
      }
    })
  })

  rootElement.querySelectorAll('[data-block-id]').forEach((element) => {
    const blockEl = element as HTMLElement
    const blockId = blockEl.getAttribute('data-block-id')
    const hasNestedBlocks = [...blockEl.children].some((child) => child.hasAttribute('data-mega-block'))
    if (!blockId || !hasNestedBlocks || blockEl.parentElement?.closest('[data-collapsed="true"]')) {
      blockEl.removeAttribute('data-has-collapse-toggle')
      return
    }
    blockEl.setAttribute('data-has-collapse-toggle', 'true')
    const overlayKey = `collapse:${blockId}`
    const table = blockEl.dataset.megaTableSource === 'true'
      ? tables.find((view) => view.dataset.sourceBlockId === blockId)
      : undefined
    seenKeys.add(overlayKey)
    syncOverlayButton(overlay, overlayKey, overlayRect, table ?? blockEl, (button, isNew) => {
      button.dataset.megaContent = 'collapse-toggle'
      button.dataset.tableOutline = String(Boolean(table))
      button.setAttribute('aria-expanded', String(blockEl.getAttribute('data-collapsed') !== 'true'))
      button.setAttribute('aria-label', blockEl.getAttribute('data-collapsed') === 'true' ? collapseLabels.expand : collapseLabels.collapse)
      if (table) {
        const tableRect = table.getBoundingClientRect()
        // Match the editable table's separate arrow and bullet lanes.
        button.style.left = `${tableRect.left - overlayRect.left - 36.5}px`
        button.style.top = `${tableRect.top - overlayRect.top + 7}px`
      }
      button.textContent = table ? '' : blockEl.getAttribute('data-collapsed') === 'true' ? '▸' : '▾'
      if (isNew) {
        button.addEventListener('click', (event) => {
          event.preventDefault()
          const collapsed = blockEl.getAttribute('data-collapsed') !== 'true'
          if (collapsed) {
            blockEl.setAttribute('data-collapsed', 'true')
          } else {
            blockEl.removeAttribute('data-collapsed')
          }
          onCollapsedChange?.(blockId, collapsed)
          syncInteractiveOverlay(rootElement, overlay, onTodoToggle, onCollapsedChange)
        })
      }
    })
  })

  overlay.querySelectorAll<HTMLElement>('[data-overlay-key]').forEach((button) => {
    const key = button.dataset.overlayKey
    if (key && !seenKeys.has(key)) {
      button.remove()
    }
  })
}

function ReaderBlockInteractionPlugin({
  onCollapsedChange,
  onTodoToggle,
  overlayRef,
}: {
  onCollapsedChange?: (blockId: string, collapsed: boolean) => void
  onTodoToggle?: (blockId: string, checked: boolean) => void
  overlayRef: React.RefObject<HTMLDivElement | null>
}) {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    const rootElement = editor.getRootElement()
    const overlay = overlayRef.current
    if (!rootElement || !overlay) {
      return undefined
    }

    const sync = () => syncInteractiveOverlay(rootElement, overlay, onTodoToggle, onCollapsedChange)
    sync()
    const unregisterUpdateListener = editor.registerUpdateListener(sync)

    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(sync)
      resizeObserver.observe(rootElement)
    }
    window.addEventListener('resize', sync)

    return () => {
      unregisterUpdateListener()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [editor, onCollapsedChange, onTodoToggle, overlayRef])

  return null
}

export interface MegaContentReaderCoreProps {
  stateJSON: string
  onCollapsedChange?: (blockId: string, collapsed: boolean) => void
  onTodoToggle?: (blockId: string, checked: boolean) => void
  /** Also emit legacy `data-mega-doc` attrs for docs E2E selectors (CE-34 parity). */
  compatDataMegaDoc?: boolean
  /** RefNode href base + optional live titles (CE-40). */
  workspaceBase?: string
  titleById?: Readonly<Record<string, string>>
  createLabel?: string
  /** BlockRef chrome label overrides (CE-51). */
  blockRefLabels?: {
    unresolved?: string
    forbidden?: string
  }
  /** Embed placeholder / loading labels (CE-53). */
  embedLabels?: Partial<EmbedRendererLabels>
  /** Embed chip renderer (injected to avoid nodes ↔ embed-renderer cycles). */
  renderEmbed: EmbedChipComponent
  /** Optional live-embed slot factory (injected to avoid reader ↔ embed-live cycles). */
  renderLiveSlot?: ((args: EmbedLiveSlotArgs) => React.ReactNode) | undefined
}

/** Read-only block-tree surface with outline-style todo/collapse affordances. */
export function MegaContentReaderCore({
  blockRefLabels,
  compatDataMegaDoc = false,
  createLabel,
  embedLabels,
  onCollapsedChange,
  onTodoToggle,
  renderEmbed,
  renderLiveSlot,
  stateJSON,
  titleById,
  workspaceBase = '/en/workspace',
}: MegaContentReaderCoreProps): React.JSX.Element {
  // LexicalComposer only applies initialConfig on mount; remount when stateJSON
  // changes so chat edit / live updates re-render. Unique namespace per instance
  // avoids colliding with sibling readers.
  const instanceId = useId()
  const initialConfig = useMemo<InitialConfigType>(() => ({
    editable: false,
    editorState: stateJSON,
    namespace: `mega-content-reader-${instanceId}`,
    nodes: READER_NODES,
    onError: (error: Error) => {
      throw error
    },
    theme: {},
  }), [instanceId, stateJSON])

  const refRouteValue = useMemo<RefRouteConfig>(
    () => ({ workspaceBase, titleById, createLabel }),
    [workspaceBase, titleById, createLabel],
  )

  const blockRefRouteValue = useMemo<BlockRefRouteConfig>(
    () => ({
      workspaceBase,
      unresolvedLabel: blockRefLabels?.unresolved,
      forbiddenLabel: blockRefLabels?.forbidden,
    }),
    [workspaceBase, blockRefLabels],
  )

  const embedRouteValue = useMemo(
    () => ({ workspaceBase, labels: embedLabels, renderLiveSlot }),
    [workspaceBase, embedLabels, renderLiveSlot],
  )

  const overlayRef = useRef<HTMLDivElement | null>(null)

  return (
    <LexicalComposer key={stateJSON} initialConfig={initialConfig}>
      <EmbedChipContext.Provider value={renderEmbed}>
        <RefRouteContext.Provider value={refRouteValue}>
          <BlockRefRouteContext.Provider value={blockRefRouteValue}>
            <EmbedRouteContext.Provider value={embedRouteValue}>
              <style>{READER_BLOCK_STYLES}</style>
              <div
                data-mega-content="reader"
                style={{ position: 'relative' }}
                {...(compatDataMegaDoc ? { 'data-mega-doc': 'reader' } : {})}
              >
                <RichTextPlugin
                  contentEditable={
                    <ContentEditable
                      data-mega-content="reader-content"
                      {...(compatDataMegaDoc ? { 'data-mega-doc': 'reader-content' } : {})}
                    />
                  }
                  ErrorBoundary={LexicalErrorBoundary}
                  placeholder={null}
                />
                <div
                  data-mega-content="reader-overlay"
                  ref={overlayRef}
                  style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                />
                <CodeShikiPlugin />
                <TagReferencesPlugin nodeClass={ReaderRefNode} />
                <ReaderBlockInteractionPlugin
                  onCollapsedChange={onCollapsedChange}
                  onTodoToggle={onTodoToggle}
                  overlayRef={overlayRef}
                />
              </div>
            </EmbedRouteContext.Provider>
          </BlockRefRouteContext.Provider>
        </RefRouteContext.Provider>
      </EmbedChipContext.Provider>
    </LexicalComposer>
  )
}
