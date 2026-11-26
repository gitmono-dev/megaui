# workspace-docs-roam e2e catalog

> Specification: FIX-RO-02 / FIX-RO-03 / FIX-RO-04 / FIX-RO-05 / FIX-RO-06 / FIX-RO-07
> Provenance: megaui-only writable-document usability and Roam-shortcut repair

## Purpose

Keep a writable empty document discoverable as a block outliner while preserving the existing Lexical structure commands, the snapshot reader boundary, four Roam-style writing triggers, line-aligned editable TODO state, executable block actions without exposing raw IDs, and the paper-like authoring surface.

## Scenario

| ID | Name | Acceptance criteria |
|---|---|---|
| S-01 | Empty writer hint, bullet, nested block, reader isolation | FIX-RO-02 AC 1-5, 8 |
| S-02 | Quick commands hand off to references | FIX-RO-03 AC 1 |
| S-03 | Page reference creates once with a resolved ID | FIX-RO-03 AC 2 |
| S-04 | Block reference consumes the workspace search result | FIX-RO-03 AC 3 |
| S-05 | Page tag preserves `#`; numeric issue reference remains distinct | FIX-RO-03 AC 4 |
| S-06 | Quick-command popover has compact rows and visible shortcuts | FIX-RO-04 AC 1-3 |
| S-07 | A closed `[[Title]]` turns into a colored reference and navigates after creation | FIX-RO-04 AC 4-6 |
| S-08 | Enter always chooses the first visible page or quick-command candidate | FIX-RO-05 AC 1-4 |
| S-09 | Resolved page references retain literal `[[Title]]`, with neutral brackets and a linked title | FIX-RO-05 AC 5-6 |
| S-10 | A TODO keeps its block bullet and exposes a separate 12px line-centered accessible checkbox with persisted keyboard completion; Backspace at the block start removes the checkbox | FIX-RO-06 AC 1-4, 6; user follow-up |
| S-11 | A block context menu hides its raw ID and exposes executable block actions | FIX-RO-07 AC 1-6 |
| S-12 | Parent bullet hover reveals a left-side arrow; clicking it collapses and restores descendants | User Roam visual follow-up, 2026-10-24 |
| S-13 | Table-side arrow folds the source outline while cells stay editable; keyboard expands it | User Table follow-up, 2026-10-27 |
| S-14 | A saved collapsed table stays visible in a read-only snapshot; its outline can be toggled locally | User Table follow-up, 2026-10-27 |
| S-15 | Empty first-column outline cells have separate editable lines; typing and clearing never alter the second column | User Table editing follow-up, 2026-10-27 |
| S-16 | New and legacy page tags render as one gray-blue hash link; Backspace/Delete preserve neighboring blocks and snapshot tags match | User hashtag follow-up, 2026-10-27 |

## Assertions

- A signed-in empty document exposes exactly one `mega-block`, a visible `empty-block-hint`, and no `empty-body` CTA.
- Typing hides the hint; Enter then Tab creates a visibly indented nested block.
- A focused block remains a transparent, borderless writing surface; the bullet, caret, and indentation provide the writing context.
- `?v=1` returns to the reader surface without a writable outliner marker or hint.
- `/` shows TODO, page reference, block reference, and tag page; selecting a reference command leaves its trigger for continued typing.
- `[[` creates through resolve-or-create once before inserting a resolved page reference; `((` inserts the selected FTS document block.
- `#Planning` is one link including its hash, colored `rgb(167, 182, 194)` like Roam, while `#42` remains an Issue reference. Legacy split hash/reference nodes normalize in both editor and snapshot reader. Backspace after a tag and Delete before it remove the tag without merging rows or damaging adjacent text; undo restores the deleted tag and no page exception occurs.
- The portal-rendered quick-command menu is a white popup with a neutral selected row, a border, shadow, and a right-aligned shortcut for each action; the editor and blocks remain unframed.
- Choosing TODO changes the active block to todo and hides the empty-document writing hint, even before the TODO has text; choosing a reference action keeps the intended trigger in the block for the next query.
- A standalone completed `[[Title]]` renders as an accent-colored unresolved page reference. Activating it resolves-or-creates exactly once, records the returned ID, and routes to that localized workspace document.
- The first visible `[[` candidate and the first `/` action are selected by default and activate with Enter; Arrow keys change that same keyboard selection, including the `((` action.
- Resolved wikilinks retain their literal `[[Title]]` text: the surrounding `[[` and `]]` are muted blue-gray, while the title is a blue link; `#tag` keeps its distinct prefix.
- The `/` portal inherits the document typography rather than falling back to a browser or component-library font.
- A TODO retains the block bullet and renders a separate 12px control centered against its own first line outside `contentEditable`; Space toggles its persisted `{{[[TODO]]}}` / `{{[[DONE]]}}` source without adding a writing-surface frame.
- Backspace at the start of an empty or populated TODO converts it to a plain text block, removes the checkbox, and keeps existing text; a following Backspace can merge the plain block as usual.
- Document blocks use a compact 14px / 22px body style; child bullets advance about 27px, and the parent guide continues to the last child row's bottom.
- A parent bullet reveals a separate arrow to its left on hover; clicking the arrow changes the block's persisted collapsed state, hides its descendants, and leaves siblings visible. A collapsed parent bullet gains a light gray outer ring, which disappears when reopened.
- Table source controls sit beside the table's first row, remain visible, and fold only the backing outline. Editing a cell while folded updates the same source blocks; Space expands the outline again. Saved collapsed state also renders correctly in snapshots, whose cells stay readonly while Enter toggles the local outline view. Compared with the referenced Roam page, the fold boundary is the same; the table arrow is always visible for discoverability.
- Empty parent cells keep a paragraph before nested column blocks so their bullets and caret rows do not overlap. Both first-column rows can be edited through the outline, cleared in the grid, and edited again without touching the second column. Leaving the grid hides its toolbar and removes the reserved toolbar gap above the outline.
- Right-clicking any writable block opens an accessible portal menu without rendering its raw `blockId`; Copy block ref opens a submenu for Copy embed and Copy block ID, while Copy block link, focus, recursive expand/collapse, TODO conversion, and H1/H2/H3 actions all mutate or copy the intended target and dismiss after the action or Escape.

- `/` 快捷菜单与块右键菜单的字体、行高、宽度、边框、圆角、阴影、内边距及选中背景保持一致；选择页面引用后正常进入引用候选菜单。

FS-92回归前置：剪贴板权限只授予实际`e2eBaseURL()` origin。块引用候选选中后先验证活动行显示`((BlockRef0001))`，点击文档标题离开编辑行后仍验证“Referenced block”。Tag场景按宿主平台使用macOS `Meta+ArrowRight`或其它平台`End`到行尾，保留候选鼠标点击、颜色和Issue断言；不使用强制点击、等待延迟或新增skip。该spec经owned-web执行时使用专属PG/Web及RustFS，图片上传仍走真实认证附件路由并验证解码，结束回收本run资源。
