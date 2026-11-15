"use client";

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNodeByKey, $getRoot, $getSelection, $isElementNode, $isRangeSelection, $isTextNode, COMMAND_PRIORITY_HIGH, PASTE_COMMAND, TextNode, type LexicalNode } from "lexical";
import { $isMegaBlockNode, type BlockRefValue } from "@megaui/content";
import { BLOCK_ID_SOURCE } from "@megaui/core";
import { $createEditorBlockRefNode, $isEditorBlockRefNode } from "../nodes";

const REFERENCE = new RegExp(`\\(\\((${BLOCK_ID_SOURCE})\\)\\)`);

function walk(node: LexicalNode): LexicalNode[] {
  return [node, ...($isElementNode(node) ? node.getChildren().flatMap(walk) : [])];
}

/** Completed syntax and copied IDs share the same inline node and ACL-protected resolution. */
export function BlockReferenceSyntaxPlugin({ currentDocId, resolve }: {
  currentDocId: string;
  resolve(blockId: string, docHint: string, exactDoc: boolean): Promise<BlockRefValue>;
}): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    let disposed = false;
    const attempted = new Set<string>();
    const signatureFor = (key: string, value: BlockRefValue) => `${key}:${value.targetDocId}:${value.targetBlockId}:${value.binding ?? "document"}`;
    const resolveNodes = () => {
      const pending = editor.getEditorState().read(() => walk($getRoot()).flatMap(node => {
        if (!$isEditorBlockRefNode(node)) return [];
        const value = node.getBlockRef();
        const signature = signatureFor(node.getKey(), value);
        if (attempted.has(signature)) return [];
        attempted.add(signature);
        return [{ key: node.getKey(), value, exactDoc: value.binding !== "search" }];
      }));
      for (const { key, value, exactDoc } of pending) {
        const local = editor.getEditorState().read(() => {
          if (value.targetDocId !== currentDocId) return null;
          const target = walk($getRoot()).find(node => $isMegaBlockNode(node) && node.getBlockId() === value.targetBlockId);
          if (!$isMegaBlockNode(target)) return null;
          return { ...value, label: target.getChildren().filter(child => !$isMegaBlockNode(child)).map(child => child.getTextContent()).join(""), status: "ok" as const };
        });
        void (local ? Promise.resolve(local) : resolve(value.targetBlockId, value.targetDocId, exactDoc)).then(result => {
          if (disposed) return;
          editor.update(() => {
            const node = $getNodeByKey(key);
            if (!$isEditorBlockRefNode(node)) return;
            const current = node.getBlockRef();
            if (signatureFor(key, current) !== signatureFor(key, value)) return;
            const resolved: BlockRefValue = { ...result, binding: exactDoc || result.status === "ok" ? "document" : "search" };
            attempted.add(signatureFor(key, resolved));
            if (JSON.stringify(current) !== JSON.stringify(resolved)) node.setBlockRef(resolved);
          }, { tag: "block-reference-resolve" });
        }).catch(() => { /* Keep the explicit unresolved syntax; never substitute another target. */ });
      }
    };
    const create = (blockId: string, docHint?: string) => $createEditorBlockRefNode({ targetDocId: docHint ?? currentDocId, targetBlockId: blockId, label: `((${blockId}))`, status: "unresolved", binding: docHint ? "document" : "search" });
    const unregisterPaste = editor.registerCommand(PASTE_COMMAND, event => {
      if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
      if (event.target instanceof Element && event.target.closest("input, textarea")) return false;
      const text = event.clipboardData.getData("text/plain").trim();
      const match = REFERENCE.exec(text);
      const selection = $getSelection();
      if (!match || match[0] !== text || !$isRangeSelection(selection)) return false;
      // A click followed immediately by paste can precede selectionchange.
      const root = editor.getRootElement();
      const domSelection = root?.ownerDocument.getSelection();
      if (domSelection?.rangeCount) {
        const range = domSelection.getRangeAt(0);
        if (root?.contains(range.commonAncestorContainer)) selection.applyDOMRange(range);
      }
      const marker = new DOMParser().parseFromString(event.clipboardData.getData("text/html"), "text/html")
        .querySelector<HTMLElement>("[data-mega-block-ref-doc][data-mega-block-ref-block]");
      const docHint = marker && marker.dataset.megaBlockRefBlock === match[1] ? marker.dataset.megaBlockRefDoc : undefined;
      const node = create(match[1]!, docHint && docHint.length <= 256 ? docHint : undefined);
      selection.insertNodes([node]);
      node.selectNext();
      event.preventDefault();
      return true;
    }, COMMAND_PRIORITY_HIGH);
    const unregisterTransform = editor.registerNodeTransform(TextNode, node => {
      if (!node.isSimpleText() || node.hasFormat("code") || node.getParents().some(parent => parent.getType() === "mega-code-block")) return;
      const text = node.getTextContent();
      if (text.includes("{{")) return;
      const match = REFERENCE.exec(text);
      if (!match) return;
      const parts = node.splitText(match.index, match.index + match[0].length);
      const target = parts[match.index === 0 ? 0 : 1];
      if ($isTextNode(target)) target.replace(create(match[1]!));
    });
    const unregisterUpdate = editor.registerUpdateListener(resolveNodes);
    editor.update(() => $getRoot().getAllTextNodes().forEach(node => node.getWritable()));
    resolveNodes();
    return () => { disposed = true; unregisterPaste(); unregisterTransform(); unregisterUpdate(); };
  }, [currentDocId, editor, resolve]);
  return null;
}
