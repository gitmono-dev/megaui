# workspace-docs-embed-indent e2e catalog

> Specification: FIX-RO-06 / FIX-RO-07 follow-up
> Provenance: user Roam block-embed and nested TODO screenshots, 2026-10-24

## Purpose

Verify that nested writable blocks keep Roam-like compact hierarchy lines and correctly aligned TODO controls, and that copying a block embed produces a working cross-document subtree preview.

## Scenarios

| ID | Name | Assertions |
|---|---|---|
| S-01 | Nested TODO layout | Parent and child retain separate block bullets and checkboxes; each child advances about 27px; the checkbox stays on its own first row; the child-owned 1px guide aligns with its parent bullet and extends to the bottom of the last child row. |
| S-02 | Cross-document block embed | Copy block ref → Copy embed writes Roam syntax; paste first shows an editable macro and then converts on Enter or blur into an outline-aligned preview without a document title. The preview resolves the source document and block, shows its child subtree but not unrelated siblings, and keeps the embedded reader's collapse control visible and separate from the editable overlay. |
| S-03 | Double-brace block search | Typing `{{` and a query shows a block candidate; clicking it inserts an embed node and resolves its source subtree. |
| S-04 | Paste into an empty block | A copied embed inserts an editable macro when the target document starts with an empty block; changing the referenced block ID before blur changes the rendered target. |
| S-05 | Immediate paste after Copy embed | Closing the context menu restores editor focus so the next paste inserts the copied embed without another click. |
| S-06 | Paste into an empty nested block | A copied embed appears inside the selected child block and keeps the parent text and hierarchy intact; Enter converts the macro and creates the next empty sibling bullet. |
| S-07 | Reference count and removal | The outline preview shows the visible block-reference count. Clicking an embed and pressing Backspace, or using Delete embed, removes its owning empty block without changing adjacent text and saves the removal. |
| S-08 | Embedded table folding | The table arrow has its own lane before the bullet and a 14px click target. Folding a row preserves its paragraph or inline label and hides only nested cells. Folding the table hides its outline and descendant controls while retaining the grid; Enter/Space restore the content, and a second embed of the same table remains unchanged. |

These scenarios run in a headed browser against the rebuilt `mega2/docker-compose.test.yml` web profile with stubbed document payloads and real editor DOM/clipboard behavior.
