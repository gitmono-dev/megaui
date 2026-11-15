# workspace-docs-edit e2e catalog

> Specification: WA-13 + RO-01  
> Provenance: megaui-only (writable doc page + link graph; upstream edit/graph as REF-01)

## Purpose

End-to-end coverage of the writable document page: `/[lang]/workspace/docs/[docId]/edit` redirects to `/[lang]/workspace/docs/[docId]` without adding `v`; local autosave, conflict toast, and draft persistence via reopen live on `page-write` + `editor`. Graph coverage stays on `/[lang]/workspace/docs/graph`. Dual-user realtime gated on CS-01.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | `/edit` redirect → autosave → reopen on writable page | RO-01 + RO-04 AC |
| S-02 | Save 409 conflict toast on detail URL | RO-01 AC |
| S-03 | Graph nodes + click navigate | AC-3 |
| S-04 | Graph empty | AC-3 |

## Notes

- Mount proof is `[data-mega-docs="page-write"]` + `[data-mega-docs="editor"]`. Do not use `edit` or `edit-entry`.
- Paper chrome: `save-state` / `collab-mode` are descendants of `chrome`; editor has no `1px solid` card wrap; `edit-entry` is absent on `page-write`.
- Local-only collab mode (`data-mode="local"`); CS-01 dual-user skipped.
- Autosave debounce ~2s (UI-06).
- Graph uses existing `GET /api/mega/graph` (EG-03 / WA-04).
