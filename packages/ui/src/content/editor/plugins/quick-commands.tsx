// megaui-only (FIX-RO-03): a deliberately small Roam-style `/` menu. It
// starts the three reference triggers rather than duplicating their searches.
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  type TextNode,
} from "lexical";
import { LexicalTypeaheadMenuPlugin, MenuOption } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createOutlineTable, $isMegaBlockNode } from "@megaui/content";
import { OPEN_IMAGE_DIALOG_COMMAND } from "./image-command";
import { EditorOutlineTableNode } from "../outline-table-node";

export interface QuickCommandsPluginLabels {
  ariaLabel: string;
  blockReference: string;
  pageReference: string;
  tagPage: string;
  todo: string;
  table: string;
  image: string;
}

type QuickCommandAction = "todo" | "table" | "image" | "page-reference" | "block-reference" | "tag-page";

interface QuickCommandDefinition {
  readonly action: QuickCommandAction;
  readonly label: string;
  readonly shortcut: string;
}

interface QuickCommandMenuProps {
  labels: QuickCommandsPluginLabels;
  options: readonly QuickCommandOption[];
  selectedIndex: number;
  onHighlight(index: number): void;
  onSelectOptionReady(selectOptionAndCleanUp: ((option: QuickCommandOption) => void) | null): void;
  selectOptionAndCleanUp(option: QuickCommandOption): void;
  setHighlightedIndex(index: number): void;
}

class QuickCommandOption extends MenuOption {
  readonly definition: QuickCommandDefinition;

  constructor(definition: QuickCommandDefinition) {
    super(definition.action);
    this.definition = definition;
  }
}

const TRIGGER_PATTERN = /(?:^|\s)\/([^\s]{0,40})$/;

function QuickCommandMenu({
  labels,
  options,
  selectedIndex,
  onHighlight,
  onSelectOptionReady,
  selectOptionAndCleanUp,
  setHighlightedIndex,
}: QuickCommandMenuProps) {
  useEffect(() => {
    onSelectOptionReady(selectOptionAndCleanUp);
    return () => onSelectOptionReady(null);
  }, [onSelectOptionReady, selectOptionAndCleanUp]);

  return (
    <ul aria-label={labels.ariaLabel} data-mega-content="quick-command-menu" role="listbox">
      {options.map((option, index) => (
        <li
          aria-label={option.definition.label}
          aria-selected={selectedIndex === index}
          data-mega-content="quick-command-option"
          id={`typeahead-item-${index}`}
          key={option.key}
          onClick={() => {
            onHighlight(index);
            setHighlightedIndex(index);
            selectOptionAndCleanUp(option);
          }}
          onPointerMove={(event) => {
            if (event.movementX === 0 && event.movementY === 0) return;
            onHighlight(index);
            setHighlightedIndex(index);
          }}
          onMouseDown={(event) => event.preventDefault()}
          ref={option.setRefElement}
          role="option"
        >
          <span data-mega-content="quick-command-label">{option.definition.label}</span>
          <span aria-hidden="true" data-mega-content="quick-command-shortcut">
            {option.definition.shortcut}
          </span>
        </li>
      ))}
    </ul>
  );
}

function triggerForAction(action: QuickCommandAction): string | null {
  switch (action) {
    case "page-reference":
      return "[[";
    case "block-reference":
      return "((";
    case "tag-page":
      return "#";
    case "todo":
    case "table":
    case "image":
      return null;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/** Roam-like `/` commands for TODO and the three reference entry points. */
export function QuickCommandsPlugin({ labels }: { labels: QuickCommandsPluginLabels }) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const [keyboardSelectedIndex, setKeyboardSelectedIndex] = useState(0);
  const keyboardSelectedIndexRef = useRef(0);
  const selectOptionAndCleanUpRef = useRef<((option: QuickCommandOption) => void) | null>(null);

  const definitions = useMemo<readonly QuickCommandDefinition[]>(
    () => [
      { action: "todo", label: labels.todo, shortcut: "⌘↵" },
      { action: "table", label: labels.table, shortcut: "2 × 2" },
      { action: "image", label: labels.image, shortcut: "↥" },
      { action: "page-reference", label: labels.pageReference, shortcut: "[[" },
      { action: "block-reference", label: labels.blockReference, shortcut: "((" },
      { action: "tag-page", label: labels.tagPage, shortcut: "#" },
    ],
    [labels.blockReference, labels.image, labels.pageReference, labels.table, labels.tagPage, labels.todo],
  );

  const options = useMemo(() => {
    const normalizedQuery = query?.trim().toLocaleLowerCase() ?? "";
    return definitions
      .filter((definition) => definition.label.toLocaleLowerCase().includes(normalizedQuery))
      .map((definition) => new QuickCommandOption(definition));
  }, [definitions, query]);

  const setKeyboardHighlight = useCallback(
    (index: number) => {
      if (options.length === 0) return;
      const normalizedIndex = ((index % options.length) + options.length) % options.length;
      keyboardSelectedIndexRef.current = normalizedIndex;
      setKeyboardSelectedIndex(normalizedIndex);
      editor.getRootElement()?.setAttribute("aria-activedescendant", `typeahead-item-${normalizedIndex}`);
    },
    [editor, options.length],
  );

  useEffect(() => {
    setKeyboardHighlight(0);
  }, [query, setKeyboardHighlight]);

  const applyCommandToTextNode = useCallback((node: TextNode, action: QuickCommandAction): boolean => {
    if (action === "image") {
      const block = node.getParent();
      if (!$isMegaBlockNode(block)) return false;
      const blockId = block.getBlockId();
      node.remove();
      queueMicrotask(() => editor.dispatchCommand(OPEN_IMAGE_DIALOG_COMMAND, blockId));
      return true;
    }
    if (action === "table") {
      const block = node.getParent();
      if (!$isMegaBlockNode(block)) return false;
      const { table, source, firstCell } = $createOutlineTable(2, 2, (id, sourceId) => new EditorOutlineTableNode(id, sourceId));
      node.remove();
      block.insertAfter(source);
      block.insertAfter(table);
      if (block.getChildrenSize() === 0) block.remove();
      firstCell.selectStart();
      return true;
    }
    if (action === "todo") {
      const block = node.getParent();
      if (!$isMegaBlockNode(block)) return false;
      block.setVariant("todo");
      node.remove();
      return true;
    }

    const trigger = triggerForAction(action);
    if (trigger === null) return false;
    node.setTextContent(trigger);
    node.selectEnd();
    return true;
  }, [editor]);

  const onSelectOption = useCallback(
    (option: QuickCommandOption, nodeToRemove: TextNode | null, closeMenu: () => void) => {
      closeMenu();
      if (!nodeToRemove) return;
      applyCommandToTextNode(nodeToRemove, option.definition.action);
    },
    [applyCommandToTextNode],
  );

  const setSelectOptionAndCleanUp = useCallback(
    (selectOptionAndCleanUp: ((option: QuickCommandOption) => void) | null) => {
      selectOptionAndCleanUpRef.current = selectOptionAndCleanUp;
    },
    [],
  );

  useEffect(() => {
    const selectKeyboardOption = (event: KeyboardEvent | null): boolean => {
      const option = options[keyboardSelectedIndexRef.current];
      const selectOptionAndCleanUp = selectOptionAndCleanUpRef.current;
      if (query === null || !option || !selectOptionAndCleanUp) return false;

      // Use Lexical's own selection path here. It owns splitting the complete
      // slash query node, so multi-character follow-up triggers such as "(("
      // cannot be truncated by a second, competing editor update.
      event?.preventDefault();
      event?.stopImmediatePropagation();
      selectOptionAndCleanUp(option);
      return true;
    };

    return editor.registerCommand(KEY_ENTER_COMMAND, selectKeyboardOption, COMMAND_PRIORITY_CRITICAL);
  }, [editor, options, query]);

  useEffect(() => {
    const moveKeyboardSelection = (step: 1 | -1) => (event: KeyboardEvent | null): boolean => {
      if (query === null || options.length === 0) return false;
      setKeyboardHighlight(keyboardSelectedIndexRef.current + step);
      event?.preventDefault();
      event?.stopImmediatePropagation();
      return true;
    };

    const unregisterArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      moveKeyboardSelection(1),
      COMMAND_PRIORITY_CRITICAL,
    );
    const unregisterArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      moveKeyboardSelection(-1),
      COMMAND_PRIORITY_CRITICAL,
    );
    return () => {
      unregisterArrowDown();
      unregisterArrowUp();
    };
  }, [editor, options.length, query, setKeyboardHighlight]);

  return (
    <LexicalTypeaheadMenuPlugin<QuickCommandOption>
      commandPriority={COMMAND_PRIORITY_HIGH}
      menuRenderFn={(anchorRef, { selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorRef.current && query !== null
          ? createPortal(
              <QuickCommandMenu
                labels={labels}
                options={options}
                selectedIndex={keyboardSelectedIndex}
                onHighlight={setKeyboardHighlight}
                onSelectOptionReady={setSelectOptionAndCleanUp}
                selectOptionAndCleanUp={selectOptionAndCleanUp}
                setHighlightedIndex={setHighlightedIndex}
              />,
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
        const slashQuery = found[1] ?? "";
        setQuery(slashQuery);
        return {
          leadOffset: found.index + found[0].length - slashQuery.length - 1,
          matchingString: slashQuery,
          replaceableString: `/${slashQuery}`,
        };
      }}
    />
  );
}
