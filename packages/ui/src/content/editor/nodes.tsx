/**
 * megaui:libs/react-shared/components/mega/content/nodes/ref-node.tsx@0ff3a9d (decorate() chip only)
 * megaui:libs/react-shared/components/mega/content/nodes/embed-node.tsx@0ff3a9d (decorate() chip only)
 * megaui:libs/react-shared/components/mega/content/nodes/block-ref-node.tsx@0ff3a9d (decorate() chip only)
 *
 * `@megaui/content`'s `RefNode` / `EmbedNode` / `BlockRefNode` (PK-02) intentionally leave
 * `decorate()` at the Lexical `DecoratorNode` base-class default (unimplemented — throws if
 * ever invoked) so that package stays server-importable with zero React (ADR-ARCH-01). This
 * file is the UI-06 "other half" the `@megaui/content` README calls out: thin subclasses
 * that add a real React chip while keeping the exact upstream `getType()` string, so exported
 * JSON stays wire-compatible with `@megaui/content` / server consumers (PK-02, EG-03).
 *
 * Subclassing pitfall (why this can't be `decorate() { ... }` bolted onto the base class):
 * `LexicalNode.getWritable()` clones a node via `this.constructor.clone(this)`, and the
 * upstream `static clone()` on `RefNode`/`EmbedNode`/`BlockRefNode` hardcodes
 * `new RefNode(...)` (not `new this(...)`) — so a subclass that does not also override
 * `static clone()` (and `static importJSON()`, which upstream also hardcodes) would silently
 * downgrade back to the base, chip-less class on the very first edit. Every subclass below
 * overrides both.
 *
 * Route/title resolution (workspace-aware hrefs, live `titleById` lookups) is a UI-07 reader
 * concern and intentionally not ported here — chips render with a fixed workspace base and
 * the raw title/label text from the pure `*ExportContract` helpers.
 */
'use client'

import * as React from "react";
import { $createTextNode, $getNodeByKey, $getRoot, type LexicalNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $isBlockRefNode as $isBaseBlockRefNode,
  $isEmbedNode as $isBaseEmbedNode,
  $isRefNode as $isBaseRefNode,
  BlockRefNode,
  EmbedNode,
  RefNode,
  refExportContract,
  $createMegaBlock,
  $isMegaBlockNode,
  type BlockRefValue,
  type EmbedValue,
  type RefNodeValue,
  type SerializedBlockRefNode,
  type SerializedEmbedNode,
  type SerializedRefNode,
} from "@megaui/content";
import { ReferenceChip } from "../ref-chip";
import { BLOCK_ID_SOURCE } from "@megaui/core";
import { EmbedRouteContext } from "../reader/embed-context";
import { EmbedRenderer } from "../reader/embed-renderer";
import { $selectFollowingMegaBlock } from "./commands";
import { EditorBlockReferenceChip } from "./block-reference-chip";

/** Fixed workspace base for editor chips (route resolution is a UI-07 reader concern). */
const EDITOR_WORKSPACE_BASE = "/workspace";
const EMBED_MACRO = new RegExp(`^\\{\\{\\[\\[embed\\]\\]:\\s*\\(\\((${BLOCK_ID_SOURCE})\\)\\)\\}\\}$`);

/** CE-40: `[[wikilink]]` / entity reference chip. */
export class EditorRefNode extends RefNode {
  static getType(): string {
    return "mega-ref";
  }

  static clone(node: EditorRefNode): EditorRefNode {
    return new EditorRefNode(node.__ref, node.__key);
  }

  static importJSON(serialized: SerializedRefNode): EditorRefNode {
    return $createEditorRefNode(serialized.ref);
  }

  /** `DecoratorNode` slot host — the base `LexicalNode.createDOM`/`updateDOM` throw. */
  createDOM(): HTMLElement {
    return document.createElement("span");
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): React.JSX.Element {
    const contract = refExportContract(this.__ref, { workspaceBase: EDITOR_WORKSPACE_BASE });
    return (
      <span data-mega-content-chip="ref">
        <ReferenceChip contract={contract} nodeKey={this.getKey()} refTitle={this.__ref.targetTitle} notation={this.__ref.notation} />
      </span>
    );
  }
}

export function $createEditorRefNode(ref: RefNodeValue): EditorRefNode {
  return new EditorRefNode(ref);
}

export function $isEditorRefNode(node: LexicalNode | null | undefined): node is EditorRefNode {
  return node instanceof EditorRefNode;
}

export function $isAnyRefNode(node: LexicalNode | null | undefined): node is RefNode {
  return $isBaseRefNode(node);
}

const pendingMacroEditors = new Set<string>();

/** A pasted block embed starts as an editable Roam macro without losing its serialized target. */
export function showPastedEmbedMacro(nodeKey: string): void {
  pendingMacroEditors.add(nodeKey);
}

function EditorEmbedPreview({ nodeKey, value }: { readonly nodeKey: string; readonly value: EmbedValue }): React.JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [editing, setEditing] = React.useState(() => pendingMacroEditors.delete(nodeKey));
  const originalSyntax = `{{[[embed]]: ((${value.targetBlockId ?? ""}))}}`;
  const [draft, setDraft] = React.useState(originalSyntax);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const committedRef = React.useRef(false);
  React.useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(draft.length, draft.length);
  }, [editing]);

  const finishEditing = (createNextBlock = false) => {
    if (committedRef.current) return;
    committedRef.current = true;
    const match = EMBED_MACRO.exec(draft.trim());
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isEditorEmbedNode(node)) return;
      const parent = node.getParent();
      if (match) {
        node.setEmbed({ ...node.getEmbed(), targetBlockId: match[1] });
      } else {
        node.replace($createTextNode(draft));
      }
      if (createNextBlock && $isMegaBlockNode(parent)) {
        $selectFollowingMegaBlock(parent);
      }
    });
    setEditing(false);
    if (createNextBlock) queueMicrotask(() => editor.focus());
  };

  const pathname = typeof window === "undefined" ? "" : window.location.pathname;
  const docsIndex = pathname.indexOf("/workspace/docs/");
  const workspaceBase = docsIndex === -1 ? "/en/workspace" : pathname.slice(0, docsIndex + "/workspace".length);
  const isChinese = pathname.startsWith("/zh-CN/");
  const deleteEmbed = () => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isEditorEmbedNode(node)) return;
      const block = node.getParent();
      if (!$isMegaBlockNode(block) || block.getChildrenSize() > 1) {
        node.remove();
        if ($isMegaBlockNode(block)) block.selectEnd();
        return;
      }
      const next = block.getNextSibling();
      const previous = block.getPreviousSibling();
      block.remove();
      if ($isMegaBlockNode(next)) next.selectStart();
      else if ($isMegaBlockNode(previous)) previous.selectEnd();
      else {
        const empty = $createMegaBlock("text");
        $getRoot().append(empty);
        empty.selectStart();
      }
    });
    editor.focus();
  };
  if (editing) {
    return (
      <span data-mega-content="embed-macro">
        <input
          aria-label="Embed macro"
          onBlur={() => finishEditing()}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDownCapture={(event) => {
            // Lexical's Tab handler indents the containing block; the macro input owns its keys.
            event.stopPropagation();
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              finishEditing(true);
            } else if (event.key === "Escape") {
              event.preventDefault();
              committedRef.current = true;
              setEditing(false);
              editor.focus();
            }
          }}
          ref={inputRef}
          type="text"
          value={draft}
        />
      </span>
    );
  }
  return (
    <div
      aria-label={isChinese ? "嵌入块" : "Embedded block"}
      data-mega-content="editor-embed-shell"
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a, button, input")) return;
        event.currentTarget.focus();
      }}
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault();
          event.stopPropagation();
          editor.update(() => {
            const node = $getNodeByKey(nodeKey);
            const parent = node?.getParent();
            if ($isMegaBlockNode(parent)) $selectFollowingMegaBlock(parent);
          });
          queueMicrotask(() => editor.focus());
          return;
        }
        if (event.key !== "Backspace" && event.key !== "Delete") return;
        event.preventDefault();
        event.stopPropagation();
        deleteEmbed();
      }}
      role="group"
      tabIndex={0}
    >
      <EmbedRouteContext.Provider value={{ workspaceBase }}>
        <EmbedRenderer presentation="outline" value={value} />
      </EmbedRouteContext.Provider>
      <button
        aria-label={isChinese ? "删除嵌入" : "Delete embed"}
        data-mega-content="editor-embed-delete"
        onClick={deleteEmbed}
        onMouseDown={(event) => event.preventDefault()}
        type="button"
      >×</button>
    </div>
  );
}

/** CE-52/53: editor embeds show the resolved block/page subtree, not only a link. */
export class EditorEmbedNode extends EmbedNode {
  static getType(): string {
    return "mega-embed";
  }

  static clone(node: EditorEmbedNode): EditorEmbedNode {
    return new EditorEmbedNode(node.__embed, node.__key);
  }

  static importJSON(serialized: SerializedEmbedNode): EditorEmbedNode {
    return $createEditorEmbedNode(serialized.embed);
  }

  createDOM(): HTMLElement {
    return document.createElement("div");
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): React.JSX.Element {
    return <EditorEmbedPreview nodeKey={this.getKey()} value={this.__embed} />;
  }
}

export function $createEditorEmbedNode(embed: EmbedValue): EditorEmbedNode {
  return new EditorEmbedNode(embed);
}

export function $isEditorEmbedNode(node: LexicalNode | null | undefined): node is EditorEmbedNode {
  return node instanceof EditorEmbedNode;
}

export function $isAnyEmbedNode(node: LexicalNode | null | undefined): node is EmbedNode {
  return $isBaseEmbedNode(node);
}

/** CE-51: `((` block reference chip (`ok` / `unresolved` / `forbidden` status chrome). */
export class EditorBlockRefNode extends BlockRefNode {
  static getType(): string {
    return "mega-block-ref";
  }

  static clone(node: EditorBlockRefNode): EditorBlockRefNode {
    return new EditorBlockRefNode(node.__blockRef, node.__key);
  }

  static importJSON(serialized: SerializedBlockRefNode): EditorBlockRefNode {
    return $createEditorBlockRefNode(serialized.blockRef);
  }

  createDOM(): HTMLElement {
    return document.createElement("span");
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): React.JSX.Element {
    return <EditorBlockReferenceChip nodeKey={this.getKey()} value={this.__blockRef} />;
  }
}

export function $createEditorBlockRefNode(blockRef: BlockRefValue): EditorBlockRefNode {
  return new EditorBlockRefNode(blockRef);
}

export function $isEditorBlockRefNode(node: LexicalNode | null | undefined): node is EditorBlockRefNode {
  return node instanceof EditorBlockRefNode;
}

export function $isAnyBlockRefNode(node: LexicalNode | null | undefined): node is BlockRefNode {
  return $isBaseBlockRefNode(node);
}
