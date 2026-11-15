/**
 * megaui:libs/react-shared/components/mega/content/plugins/wikilinks.tsx@0ff3a9d
 *
 * Adapted to this package's React-decorated EditorRefNode. Page tags own their
 * hash in the reference rather than leaving a separately editable prefix;
 * numeric #N continues to select Issue references.
 */
"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { COMMAND_PRIORITY_HIGH, $getNodeByKey, type NodeKey, type TextNode } from "lexical";
import { LexicalTypeaheadMenuPlugin, MenuOption } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { RefNodeKind } from "@megaui/content";
import { $createEditorRefNode, $isEditorRefNode } from "../nodes";

export interface WikilinkCandidate {
  kind: RefNodeKind;
  targetTitle: string;
  targetId?: string;
  detail?: string;
}

export interface WikilinksPluginLabels {
  ariaLabel: string;
  createPage: string;
  empty: string;
}

export interface WikilinksPluginProps {
  labels: WikilinksPluginLabels;
  /** Fixture or title-index lookup (server search endpoint owns the real query). */
  search(query: string): Promise<readonly WikilinkCandidate[]>;
  /** Resolves a user-confirmed create offer before its reference is inserted. */
  createPage?(title: string): Promise<WikilinkCandidate>;
  /** When false, suppress `[[` create-page offers (chat: user/CL only). Default true. */
  allowCreate?: boolean;
}

class WikilinkOption extends MenuOption {
  candidate: WikilinkCandidate;
  isCreate: boolean;

  constructor(candidate: WikilinkCandidate, isCreate = false) {
    super(isCreate ? `create:${candidate.targetTitle}` : `${candidate.kind}:${candidate.targetId ?? candidate.targetTitle}`);
    this.candidate = candidate;
    this.isCreate = isCreate;
  }
}

const TRIGGER_PATTERN = /\[\[([^\]]{0,80})$/;
const TAG_TRIGGER_PATTERN = /(?:^|\s)#([^\s#]{0,80})$/;
const DIRECT_REF_TRIGGER_PATTERN = /(?:^|\s)(#([0-9]*)|!([0-9]*)|@([\w-]*))$/;
type WikilinkTriggerKind = "wikilink" | "tag" | "issue" | "cl" | "user";

function isPageTrigger(triggerKind: WikilinkTriggerKind): boolean {
  return triggerKind === "wikilink" || triggerKind === "tag";
}

/** CE-40/62: `[[`, `#tag`, `#N`, and `!N` typeahead inserting RefNodes. */
export function WikilinksPlugin({ allowCreate = true, createPage, labels, search }: WikilinksPluginProps) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const [triggerKind, setTriggerKind] = useState<WikilinkTriggerKind>("wikilink");
  const [candidates, setCandidates] = useState<readonly WikilinkCandidate[]>([]);

  useEffect(() => {
    if (query === null) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    void search(query)
      .then((results) => {
        if (!cancelled) {
          const filtered = isPageTrigger(triggerKind)
            ? triggerKind === "tag"
              ? results.filter((candidate) => candidate.kind === "doc")
              : results
            : results.filter((candidate) => candidate.kind === triggerKind);
          setCandidates(filtered.slice(0, 8));
        }
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [query, search, triggerKind]);

  const options = useMemo(() => {
    const matched = candidates.map((candidate) => new WikilinkOption(candidate));
    const trimmed = (query ?? "").trim();
    if (!allowCreate || !trimmed || !isPageTrigger(triggerKind)) {
      return matched;
    }
    const exact = candidates.some((candidate) => candidate.targetTitle.toLowerCase() === trimmed.toLowerCase());
    if (!exact) {
      matched.push(new WikilinkOption({ kind: "doc", targetTitle: trimmed }, true));
    }
    return matched;
  }, [allowCreate, candidates, query, triggerKind]);

  const replaceTriggerWithReference = useCallback(
    (nodeToRemove: TextNode | null, candidate: WikilinkCandidate, isTag: boolean): NodeKey | null => {
      if (!nodeToRemove) return null;
      const refNode = $createEditorRefNode({
        kind: candidate.kind,
        notation: isTag ? "tag" : "wikilink",
        ...(isTag ? { tagPrefix: "inline" as const } : {}),
        targetTitle: candidate.targetTitle,
        targetId: candidate.targetId,
      });
      nodeToRemove.replace(refNode);
      refNode.selectNext();
      return refNode.getKey();
    },
    [],
  );

  const resolveCreatedReference = useCallback(
    (nodeKey: NodeKey, candidate: WikilinkCandidate) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (!$isEditorRefNode(node)) return;
        const ref = node.getRef();
        if (ref.kind !== candidate.kind || ref.targetTitle !== candidate.targetTitle) return;
        node.setRef({ ...ref, targetId: candidate.targetId });
      });
    },
    [editor],
  );

  const onSelectOption = useCallback(
    (option: WikilinkOption, nodeToRemove: TextNode | null, closeMenu: () => void) => {
      const isTag = triggerKind === "tag";
      closeMenu();
      if (!nodeToRemove) return;

      if (option.isCreate && createPage) {
        const nodeKey = replaceTriggerWithReference(
          nodeToRemove,
          { kind: "doc", targetTitle: option.candidate.targetTitle },
          isTag,
        );
        if (!nodeKey) return;
        void createPage(option.candidate.targetTitle)
          .then((candidate) => {
            resolveCreatedReference(nodeKey, candidate);
          })
          .catch(() => undefined);
        return;
      }

      const candidate: WikilinkCandidate = option.isCreate
        ? { kind: "doc", targetTitle: option.candidate.targetTitle }
        : option.candidate;
      replaceTriggerWithReference(nodeToRemove, candidate, isTag);
    },
    [createPage, replaceTriggerWithReference, resolveCreatedReference, triggerKind],
  );

  return (
    <LexicalTypeaheadMenuPlugin<WikilinkOption>
      commandPriority={COMMAND_PRIORITY_HIGH}
      menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorRef.current && (options.length > 0 || query !== null)
          ? createPortal(
              <ul aria-label={labels.ariaLabel} data-mega-content="wikilink-menu" role="listbox">
                {options.length === 0 ? (
                  <li data-mega-content="wikilink-empty">{labels.empty}</li>
                ) : (
                  options.map((option, index) => (
                    <li
                      aria-selected={selectedIndex === index}
                      data-mega-content={option.isCreate ? "wikilink-create" : "wikilink-option"}
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
                      {option.isCreate ? labels.createPage.replace("{title}", option.candidate.targetTitle) : option.candidate.targetTitle}
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
        const wikilinkMatch = TRIGGER_PATTERN.exec(text);
        if (wikilinkMatch) {
          setTriggerKind("wikilink");
          setQuery(wikilinkMatch[1] ?? "");
          return {
            leadOffset: wikilinkMatch.index,
            matchingString: wikilinkMatch[1] ?? "",
            replaceableString: wikilinkMatch[0],
          };
        }

        const tagMatch = TAG_TRIGGER_PATTERN.exec(text);
        if (tagMatch) {
          const tagQuery = tagMatch[1] ?? "";
          if (!/^\d+$/.test(tagQuery)) {
            setTriggerKind("tag");
            setQuery(tagQuery);
            return {
              leadOffset: tagMatch.index + tagMatch[0].length - tagQuery.length - 1,
              matchingString: tagQuery,
              replaceableString: `#${tagQuery}`,
            };
          }
        }

        const directRefMatch = DIRECT_REF_TRIGGER_PATTERN.exec(text);
        if (directRefMatch) {
          const token = directRefMatch[1] ?? "";
          const kind: WikilinkTriggerKind = token.startsWith("#") ? "issue" : token.startsWith("!") ? "cl" : "user";
          const directQuery = (kind === "issue" ? directRefMatch[2] : kind === "cl" ? directRefMatch[3] : directRefMatch[4]) ?? "";
          setTriggerKind(kind);
          setQuery(directQuery);
          return {
            leadOffset: directRefMatch.index + directRefMatch[0].length - token.length,
            matchingString: directQuery,
            replaceableString: token,
          };
        }

        setQuery(null);
        return null;
      }}
    />
  );
}
