"use client";

import * as React from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createTextNode, $getNodeByKey, COMMAND_PRIORITY_LOW, KEY_ENTER_COMMAND, SELECTION_CHANGE_COMMAND } from "lexical";
import { $isBlockRefNode, blockRefExportContract, type BlockRefValue } from "@megaui/content";
import { en, zhCN } from "@megaui/i18n";
import { BLOCK_ID_SOURCE } from "@megaui/core";

const REFERENCE = new RegExp(`^([^]*?)\\(\\((${BLOCK_ID_SOURCE})\\)\\)([^]*)$`);

/** A reference stays an inline node while its syntax is edited; surrounding text stays in the owning row. */
export function EditorBlockReferenceChip({ nodeKey, value }: { nodeKey: string; value: BlockRefValue }): React.JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [activeLine, setActiveLine] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const syntax = `((${value.targetBlockId}))`;
  const [draft, setDraft] = React.useState(syntax);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const finished = React.useRef(false);
  const restoreFocus = React.useRef(false);
  const contract = blockRefExportContract(value, { workspaceBase: "/workspace" });
  const labels = typeof document !== "undefined" && document.documentElement.lang.startsWith("zh") ? zhCN : en;

  React.useEffect(() => {
    let interacting = Boolean(editor.getRootElement()?.contains(document.activeElement));
    const sync = () => {
      const root = editor.getRootElement();
      const anchor = root?.ownerDocument.getSelection()?.anchorNode;
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
      const reference = editor.getElementByKey(nodeKey);
      const line = reference?.closest('[data-mega-block], p');
      // Clicking a non-focusable heading may keep the editor as activeElement,
      // while the native caret has already left the row.
      setActiveLine(Boolean(interacting && root?.contains(document.activeElement) && line &&
        anchorElement?.closest('[data-mega-block], p') === line));
    };
    const unregisterUpdate = editor.registerUpdateListener(sync);
    const unregisterSelection = editor.registerCommand(SELECTION_CHANGE_COMMAND, () => { sync(); return false; }, COMMAND_PRIORITY_LOW);
    const blur = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !editor.getRootElement()?.contains(event.relatedTarget)) {
        interacting = false;
        setActiveLine(false);
      }
    };
    const activate = () => { interacting = true; sync(); };
    const pointer = (event: PointerEvent) => {
      interacting = event.target instanceof Node && Boolean(editor.getRootElement()?.contains(event.target));
      sync();
    };
    const unregisterRoot = editor.registerRootListener((root, previous) => {
      previous?.removeEventListener("focusout", blur);
      previous?.removeEventListener("focusin", sync);
      previous?.removeEventListener("keydown", activate);
      root?.addEventListener("focusout", blur);
      root?.addEventListener("focusin", sync);
      root?.addEventListener("keydown", activate);
    });
    document.addEventListener("selectionchange", sync);
    document.addEventListener("pointerdown", pointer);
    sync();
    return () => {
      unregisterUpdate(); unregisterSelection(); unregisterRoot();
      document.removeEventListener("selectionchange", sync);
      document.removeEventListener("pointerdown", pointer);
    };
  }, [editor, nodeKey]);

  React.useEffect(() => {
    if (!editing) {
      if (restoreFocus.current) {
        restoreFocus.current = false;
        editor.focus();
      }
      return;
    }
    const input = inputRef.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }, [editing, editor]);

  const finish = (move?: "before" | "after" | "next-line", cancel = false) => {
    if (finished.current) return;
    finished.current = true;
    restoreFocus.current = Boolean(move);
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isBlockRefNode(node)) return;
      const match = REFERENCE.exec(cancel ? syntax : draft);
      if (!match) {
        const text = $createTextNode(draft);
        node.replace(text);
        if (move) text.selectEnd();
      } else {
        const [, before, id, after] = match;
        if (id !== value.targetBlockId) node.setBlockRef({ ...value, targetBlockId: id!, label: `((${id}))`, status: "unresolved", binding: "search" });
        if (before) node.insertBefore($createTextNode(before));
        if (after) node.insertAfter($createTextNode(after));
        if (move === "before") node.selectPrevious();
        else if (move) node.selectNext(0, 0);
      }
      // Use the same focused-subtree placement as Enter in ordinary text.
      if (move === "next-line") editor.dispatchCommand(KEY_ENTER_COMMAND, null);
    }, { discrete: true });
    setEditing(false);
  };

  if (editing) return <input
    aria-label={labels.workspace.docEdit.quickCommands.blockReference}
    data-mega-content="block-ref-syntax"
    ref={inputRef}
    style={{ width: `${Math.max(6, draft.length)}ch` }}
    value={draft}
    onChange={event => setDraft(event.target.value)}
    onBlur={() => finish()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      const input = event.currentTarget;
      if (event.key === "Escape") { event.preventDefault(); finish("after", true); }
      else if (event.key === "Enter") { event.preventDefault(); finish("next-line"); }
      else if (event.key === "ArrowRight" && input.selectionStart === draft.length && input.selectionEnd === draft.length) { event.preventDefault(); finish("after"); }
      else if (event.key === "ArrowLeft" && input.selectionStart === 0 && input.selectionEnd === 0) { event.preventDefault(); finish("before"); }
    }}
  />;

  const edit = (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    setDraft(syntax);
    finished.current = false;
    setEditing(true);
  };
  return <span data-mega-content={contract.megaContent} data-mega-content-chip="block-ref" data-ref-editing={activeLine ? "true" : undefined}>
    <a href={contract.href} onClick={edit}>{activeLine ? syntax : contract.text}</a>
  </span>;
}
