# workspace-docs-delete-block-ref e2e catalog

> Specification: Roam editor visual repair, 2026-09-19
> Provenance: user screenshot of deletion and `(( ))` appearance

## Purpose

Keep the nested outline relationship line attached to its direct child after text deletion, and make a selected block reference visually distinct from plain text.

## Scenarios

| ID | Name | Assertions |
|---|---|---|
| S-01 | Delete nested text | Repeated Backspace empties the deepest block without removing the tree; each child-owned guide ends at that child's bullet. |
| S-02 | Block-reference appearance | Typing `((` and choosing a candidate inserts a block reference whose link uses the accent color and dotted underline. |
| S-03 | Copy and edit inline reference | Copy block ID writes `((ID))`; pasting creates an inline reference. Entering its row reveals syntax; clicking it exposes an input, and ArrowRight returns the caret to the same row for more text. Leaving the row restores the source label; autosave and reload retain the structured reference and trailing text, and the source is unchanged. |
| S-04 | Plain cross-document syntax | A complete `((ID))` inside ordinary text resolves to another document, keeps its prefix and suffix, and stays in one outline row. |

Run headed against the rebuilt `mega2/docker-compose.test.yml` web profile with stubbed document/search responses and real editor DOM.
