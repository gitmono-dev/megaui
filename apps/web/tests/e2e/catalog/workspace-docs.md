# workspace-docs e2e catalog

> Specification: WA-12  
> Provenance: megaui-only (Docs library + reader; upstream docs pages as REF-01)

## Purpose

End-to-end coverage of `/[lang]/workspace/docs` library (grid/search/new/empty/error) and `/[lang]/workspace/docs/[docId]` (signed-in latest page is writable via MegaContentEditor; `?v=` snapshot still uses MegaContentReader; linked/unlinked refs below the body, comments list+create composer, restore ACL, 404). Stub BFF by default.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | Library grid + new dialog | AC-1 |
| S-01a | Duplicate title keeps dialog open with localized conflict feedback | FIX-RO-08 AC |
| S-01b | Starred filter | AC-1 |
| S-01c | Search + title sort | AC-1 |
| S-01d | Folder / tag filter | AC-1 |
| S-02 | Library empty | AC-1 |
| S-03 | Library error + retry | AC-1 |
| S-04 | Signed-in latest page is writable + paper chrome / chips | RO-01 + RO-04 AC |
| S-04b | `?v=` keeps the page readonly before snapshot body | RO-01 AC |
| S-04c | Guest never sees the editor | RO-01 AC |
| S-04d | Writable empty body has no empty-body CTA | RO-04 AC |
| S-04e | Readonly empty snapshot has empty-body without `/edit` | RO-04 AC |
| S-10 | Linked / Unlinked refs below body, not in sidebar | RO-02 AC (new) |
| S-10a | Full-page / focused-block Backlinks group repeated source identities with superscript counts; same-title sources remain separate | Backlinks 展示验收 |
| S-05 | Version snapshot + restore success | AC-2 |
| S-06 | Restore 403 toast | AC-2 |
| S-07 | Missing/deleted doc 404 | AC-3 |
| S-08 | zh-CN library | AC-1 |
| S-09 | Reader comment composer list+create | DC-03 AC-1, AC-2, AC-3 |

## Notes

- Create navigates to `/docs/[id]` (writable when signed in; `/edit` only redirects).
- Writable pages hide `edit-entry`, put save/collab chips in `chrome`, and do not render `empty-body`. Readonly empty copy has no `/edit` link.
- Linked / Unlinked references render below the editor/reader and above comments (`linked-refs` / `unlinked-refs`). Sidebar no longer has `backlinks`.
- Backlinks 按来源类型与 ID 合并并保留首次出现顺序；同一来源的页面链接与块引用／嵌入合计，超过一次显示标题右上角数字，单次不显示数字。同名但不同 ID 或类型的来源不合并，跳转地址保持原值；聚焦块页面沿用整篇文档的汇总范围。
- Comments BFF list+create is in scope (ADR-DC-01); e2e stubs GET/POST payloads. Composer shows for signed-in readers without `?v=`.
- Signed-in workspace users can read and edit docs by default; anonymous requests remain denied and only owners can manage/delete.
- Graph / editor deferred to WA-13.
