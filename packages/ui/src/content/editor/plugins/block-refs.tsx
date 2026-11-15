/**
 * megaui:libs/react-shared/components/mega/content/plugins/block-refs.tsx@0ff3a9d
 *
 * Ported verbatim; only the `$createBlockRefNode` import moves from the sibling
 * `../nodes/block-ref-node` (chip-less `@megaui/content` class) to `../nodes` (this
 * package's `EditorBlockRefNode`). Visual styling dropped (see `embeds.tsx` header note).
 */
"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { COMMAND_PRIORITY_HIGH, type TextNode } from "lexical";
import { LexicalTypeaheadMenuPlugin, MenuOption } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createEditorBlockRefNode } from "../nodes";

export interface BlockRefCandidate {
  targetDocId: string;
  targetBlockId: string;
  label: string;
  /** 「文档 › 路径 › 摘要」display line. */
  detail: string;
  sourcePath?: string;
}

export interface BlockRefsPluginLabels {
  ariaLabel: string;
  empty: string;
}

export interface BlockRefsPluginProps {
  labels: BlockRefsPluginLabels;
  search(query: string): Promise<readonly BlockRefCandidate[]>;
}

class BlockRefOption extends MenuOption {
  candidate: BlockRefCandidate;

  constructor(candidate: BlockRefCandidate) {
    super(`${candidate.targetDocId}:${candidate.targetBlockId}`);
    this.candidate = candidate;
  }
}

const TRIGGER_PATTERN = /\(\(([^)]{0,80})$/;

/** CE-51: `((` typeahead inserting BlockRefNodes from blocks/search. */
export function BlockRefsPlugin({ labels, search }: BlockRefsPluginProps) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<readonly BlockRefCandidate[]>([]);

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
        if (!cancelled) setCandidates(results.slice(0, 8));
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [query, search]);

  const options = useMemo(() => candidates.map((candidate) => new BlockRefOption(candidate)), [candidates]);

  const onSelectOption = useCallback(
    (option: BlockRefOption, nodeToRemove: TextNode | null, closeMenu: () => void) => {
      editor.update(() => {
        const refNode = $createEditorBlockRefNode({
          targetDocId: option.candidate.targetDocId,
          targetBlockId: option.candidate.targetBlockId,
          label: option.candidate.label,
          sourcePath: option.candidate.sourcePath,
          status: "ok",
        });
        if (nodeToRemove) {
          nodeToRemove.replace(refNode);
          refNode.selectNext();
        }
      });
      closeMenu();
    },
    [editor],
  );

  return (
    <LexicalTypeaheadMenuPlugin<BlockRefOption>
      commandPriority={COMMAND_PRIORITY_HIGH}
      menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorRef.current && (options.length > 0 || query !== null)
          ? createPortal(
              <ul aria-label={labels.ariaLabel} data-mega-content="block-ref-menu" role="listbox">
                {options.length === 0 ? (
                  <li data-mega-content="block-ref-empty">{labels.empty}</li>
                ) : (
                  options.map((option, index) => (
                    <li
                      aria-selected={selectedIndex === index}
                      data-mega-content="block-ref-option"
                      id={`typeahead-item-${index}`}
                      key={option.key}
                      onClick={() => {
                        setHighlightedIndex(index);
                        selectOptionAndCleanUp(option);
                      }}
                      onPointerMove={(event) => {
                        if (event.movementX === 0 && event.movementY === 0) return;
                        setHighlightedIndex(index);
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      ref={option.setRefElement}
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
