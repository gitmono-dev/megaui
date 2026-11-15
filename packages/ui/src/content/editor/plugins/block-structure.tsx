/**
 * megaui:libs/react-shared/components/mega/content/plugins/block-structure.tsx@0ff3a9d
 *
 * Adapted to @megaui/content invariants and local commands. Local behavior also
 * converts TODO on Backspace and checks the full inline path before merging rows,
 * so a cursor after a reference is never mistaken for the start of its block.
 */
"use client";

import { useEffect } from "react";
import {
  $getSelection,
  $isRangeSelection,
  type LexicalNode,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_SPACE_COMMAND,
  KEY_TAB_COMMAND,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { registerMegaContentInvariants } from "@megaui/content";
import {
  $applyMegaBlockMarkdownPrefix,
  $getSelectedMegaBlock,
  $indentMegaBlock,
  $mergeMegaBlockWithPrevious,
  $moveMegaBlockDown,
  $moveMegaBlockUp,
  $outdentMegaBlock,
  $splitMegaBlockAtSelection,
} from "../commands";

function isAtBlockStart(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.offset !== 0) {
    return false;
  }
  const block = $getSelectedMegaBlock();
  if (!block) return false;
  // Offset zero in a text node after a chip is still the middle of the row.
  let node: LexicalNode | null = selection.anchor.getNode();
  while (node && !node.is(block)) {
    if (node.getPreviousSibling()) return false;
    node = node.getParent();
  }
  return node !== null;
}

/** CE-31: Roam-style block structure keys (Tab/Enter/Backspace/⌥↑↓). */
export function BlockStructurePlugin({
  allowNesting = true,
  registerInvariants = true,
}: {
  allowNesting?: boolean;
  registerInvariants?: boolean;
} = {}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterInvariants = registerInvariants ? registerMegaContentInvariants(editor) : () => {};

    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (!allowNesting) {
          return false;
        }
        const block = $getSelectedMegaBlock();
        if (!block) {
          return false;
        }
        const handled = event?.shiftKey ? $outdentMegaBlock(block) : $indentMegaBlock(block);
        if (handled) {
          event?.preventDefault();
        }
        return handled;
      },
      COMMAND_PRIORITY_LOW,
    );

    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        let handled = false;
        editor.update(() => {
          handled = $splitMegaBlockAtSelection();
        });
        if (handled) {
          event?.preventDefault();
        }
        return handled;
      },
      COMMAND_PRIORITY_LOW,
    );

    const unregisterBackspace = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        if (!isAtBlockStart()) {
          return false;
        }
        const block = $getSelectedMegaBlock();
        if (!block) return false;
        let handled: boolean;
        if (block.getVariant() === "todo") {
          block.setVariant("text");
          block.setTodoChecked(false);
          handled = true;
        } else {
          handled = $mergeMegaBlockWithPrevious(block);
        }
        if (handled) event?.preventDefault();
        return handled;
      },
      COMMAND_PRIORITY_LOW,
    );

    const unregisterArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (!event?.altKey) {
          return false;
        }
        let handled = false;
        editor.update(() => {
          const block = $getSelectedMegaBlock();
          if (!block) {
            return;
          }
          handled = $moveMegaBlockUp(block);
        });
        if (handled) {
          event.preventDefault();
        }
        return handled;
      },
      COMMAND_PRIORITY_LOW,
    );

    const unregisterArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (!event?.altKey) {
          return false;
        }
        let handled = false;
        editor.update(() => {
          const block = $getSelectedMegaBlock();
          if (!block) {
            return;
          }
          handled = $moveMegaBlockDown(block);
        });
        if (handled) {
          event.preventDefault();
        }
        return handled;
      },
      COMMAND_PRIORITY_LOW,
    );

    const unregisterSpace = editor.registerCommand(
      KEY_SPACE_COMMAND,
      (event) => {
        let handled = false;
        editor.update(() => {
          handled = $applyMegaBlockMarkdownPrefix(true);
        });
        if (handled) {
          event?.preventDefault();
        }
        return handled;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      unregisterInvariants();
      unregisterTab();
      unregisterEnter();
      unregisterBackspace();
      unregisterArrowUp();
      unregisterArrowDown();
      unregisterSpace();
    };
  }, [allowNesting, editor, registerInvariants]);

  return null;
}
