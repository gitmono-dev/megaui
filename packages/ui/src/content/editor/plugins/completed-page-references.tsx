"use client";

import { useCallback, useEffect, useRef } from "react";
import { $getNodeByKey, $getRoot, TextNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createEditorRefNode, $isEditorRefNode } from "../nodes";

export interface CompletedPageReference {
  readonly kind: "doc";
  readonly targetId: string;
  readonly targetTitle: string;
}

export interface CompletedPageReferencesPluginProps {
  readonly createPage: (title: string) => Promise<CompletedPageReference>;
  readonly onCreateError: (error: unknown) => void;
  readonly onNavigate: (targetId: string) => void;
}

const COMPLETED_WIKILINK_PATTERN = /^\[\[([^\]]{1,80})\]\]$/;

function completedPageTitle(text: string): string | null {
  const match = COMPLETED_WIKILINK_PATTERN.exec(text);
  const title = match?.[1]?.trim() ?? "";
  return title || null;
}

/** Converts a completed `[[Title]]` into a link-like reference that creates on activation. */
export function CompletedPageReferencesPlugin({
  createPage,
  onCreateError,
  onNavigate,
}: CompletedPageReferencesPluginProps): null {
  const [editor] = useLexicalComposerContext();
  const pendingNodeKeys = useRef(new Set<string>());

  const createAndNavigate = useCallback(
    async (nodeKey: string, title: string): Promise<void> => {
      if (pendingNodeKeys.current.has(nodeKey)) return;
      pendingNodeKeys.current.add(nodeKey);

      try {
        const target = await createPage(title);
        let shouldNavigate = false;
        editor.update(() => {
          const node = $getNodeByKey(nodeKey);
          if (!$isEditorRefNode(node)) return;
          const ref = node.getRef();
          if (ref.kind !== "doc" || ref.targetId || ref.targetTitle !== title) return;
          node.setRef({ ...ref, targetId: target.targetId });
          shouldNavigate = true;
        });
        if (shouldNavigate) onNavigate(target.targetId);
      } finally {
        pendingNodeKeys.current.delete(nodeKey);
      }
    },
    [createPage, editor, onNavigate],
  );

  useEffect(() => {
    const unregisterTransform = editor.registerNodeTransform(TextNode, (node) => {
      const title = completedPageTitle(node.getTextContent());
      if (title === null) return;
      node.replace($createEditorRefNode({ kind: "doc", targetTitle: title }));
    });
    editor.update(() => {
      $getRoot().getAllTextNodes().forEach((node) => node.getWritable());
    });
    return unregisterTransform;
  }, [editor]);

  useEffect(() => {
    const onReferenceClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const reference = event.target.closest<HTMLElement>('[data-mega-content="ref-unresolved"][data-ref-kind="doc"]');
      const nodeKey = reference?.dataset.nodeKey;
      const title = reference?.dataset.refTitle;
      if (!reference || !nodeKey || !title) return;

      event.preventDefault();
      void createAndNavigate(nodeKey, title).catch(onCreateError);
    };
    return editor.registerRootListener((root, previousRoot) => {
      previousRoot?.removeEventListener("click", onReferenceClick);
      root?.addEventListener("click", onReferenceClick);
    });
  }, [createAndNavigate, editor, onCreateError]);

  return null;
}
