/**
 * megaui:libs/react-shared/components/mega/content/plugins/embeds.tsx@0ff3a9d
 *
 * Ported verbatim; only the `$createEmbedNode` import moves from the sibling
 * `../nodes/embed-node` (chip-less `@megaui/content` class) to `../nodes` (this package's
 * `EditorEmbedNode`, which actually renders a chip — see `nodes.tsx` header). Visual styling
 * (menu positioning/theme CSS vars) is dropped along with the out-of-scope `block-hover-*` /
 * `doc-editor` theme files this task's write set excludes; `data-mega-content` selector hooks
 * are preserved.
 */
"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { TextNode } from "lexical";
import { $isMegaBlockNode } from "@megaui/content";
import { LexicalTypeaheadMenuPlugin, MenuOption } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createEditorEmbedNode } from "../nodes";
import { $selectFollowingMegaBlock } from "../commands";

export type EmbedCandidateKind = "page" | "block";

export interface EmbedCandidate {
  kind: EmbedCandidateKind;
  targetDocId: string;
  targetBlockId?: string;
  label: string;
  detail: string;
}

export interface EmbedsPluginLabels {
  ariaLabel: string;
  empty: string;
  pagesGroup: string;
  blocksGroup: string;
}

export interface EmbedsPluginProps {
  labels: EmbedsPluginLabels;
  /** Dual-mode search: pages (title index) + blocks (blocks/search). */
  search(query: string): Promise<readonly EmbedCandidate[]>;
}

class EmbedOption extends MenuOption {
  candidate: EmbedCandidate;

  constructor(candidate: EmbedCandidate) {
    super(candidate.kind === "block" ? `block:${candidate.targetDocId}:${candidate.targetBlockId}` : `page:${candidate.targetDocId}`);
    this.candidate = candidate;
  }
}

const TRIGGER_PATTERN = /\{\{([^}]{0,80})$/;

/** CE-52: `{{` typeahead inserting page or block EmbedNodes. */
export function EmbedsPlugin({ labels, search }: EmbedsPluginProps) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<readonly EmbedCandidate[]>([]);

  useEffect(() => {
    if (query === null) {
      setCandidates([]);
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    void search(trimmed)
      .then((results) => {
        if (!cancelled) setCandidates(results.slice(0, 12));
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [query, search]);

  const options = useMemo(() => candidates.map((candidate) => new EmbedOption(candidate)), [candidates]);

  const onSelectOption = useCallback(
    (option: EmbedOption, nodeToRemove: TextNode | null, closeMenu: () => void) => {
      editor.update(() => {
        const embedNode = $createEditorEmbedNode({
          targetDocId: option.candidate.targetDocId,
          targetBlockId: option.candidate.targetBlockId,
          label: option.candidate.label,
        });
        if (nodeToRemove) {
          nodeToRemove.replace(embedNode);
          const block = embedNode.getParent();
          if ($isMegaBlockNode(block)) $selectFollowingMegaBlock(block);
          else embedNode.selectNext();
        }
      });
      closeMenu();
      queueMicrotask(() => editor.focus());
    },
    [editor],
  );

  return (
    <LexicalTypeaheadMenuPlugin<EmbedOption>
      menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorRef.current && (options.length > 0 || query !== null)
          ? createPortal(
              <ul aria-label={labels.ariaLabel} data-mega-content="embed-menu" role="listbox">
                {options.length === 0 ? (
                  <li data-mega-content="embed-empty">{labels.empty}</li>
                ) : (
                  options.map((option, index) => (
                    <li
                      aria-selected={selectedIndex === index}
                      data-mega-content="embed-option"
                      data-embed-kind={option.candidate.kind}
                      key={option.key}
                      onClick={() => {
                        setHighlightedIndex(index);
                        selectOptionAndCleanUp(option);
                      }}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      role="option"
                    >
                      {option.candidate.label}
                    </li>
                  ))
                )}
              </ul>,
              anchorRef.current,
            )
          : null
      }
      onQueryChange={() => {}}
      onSelectOption={onSelectOption}
      options={options}
      triggerFn={(text) => {
        const found = TRIGGER_PATTERN.exec(text);
        if (!found) {
          setQuery(null);
          return null;
        }
        setQuery(found[1] ?? "");
        return {
          leadOffset: found.index,
          matchingString: found[1] ?? "",
          replaceableString: found[0],
        };
      }}
    />
  );
}
