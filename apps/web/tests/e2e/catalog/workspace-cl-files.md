# workspace-cl-files e2e catalog

> Specification: WA-10  
> Provenance: megaui-only (CL attachment pages; upstream cls/{files,revisions,checks,deps} as REF-01)

## Purpose

End-to-end coverage of `/[lang]/workspace/cls/[publicId]/{files,revisions,checks,deps}` includes paged file review, revision comparison, check states and the dependency graph. The suite uses a stub BFF.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | Nested directories, keyboard selection, file line counts, rename paths, and TypeScript and Rust syntax colors | AC-1 |
| S-01b | Readable unknown file types and distinct empty and binary states | AC-1 |
| S-01c | A 500-line Rust diff keeps the rendered line count bounded and highlights code at both ends | AC-1 |
| S-01d | A deep link into a directory of 1,200 files reveals the selected leaf while rendering just the visible rows and overscan | AC-1 |
| S-01e | Independent card disclosure, unified and split layouts, and persisted Viewed progress | AC-1 |
| S-01f | Pages contain at most five diff cards and support forward and backward navigation | AC-1 |
| S-01g | Tree visibility and case-insensitive path filters with duplicate filenames and empty results | AC-1 |
| S-01h | A failed Viewed write keeps the correct review count and allows retry | AC-1 |
| S-01i | Switching the revision range changes the patch and the browser-local Mega2 review marks; the full-diff mark survives reload | AC-1 |
| S-02 | Files empty | AC-1 |
| S-03 | A numeric deep link opens the requested index.ts among duplicate filenames, with its directory expanded and its revision range and fragment preserved across refresh. Enter opens the revisions tab by public ID | AC-1 |
| S-03b | Bookmarks for both hyphenated and underscored public IDs keep the file range and fragment at the current alphanumeric ID | AC-1 |
| S-04 | Revision cards, commits and a comparison link with the same public ID | AC-1 |
| S-04b | Revisions empty | AC-1 |
| S-05 | Checks passing / empty / failing | AC-1, AC-3 |
| S-06 | Checks error shows retry | AC-1 |
| S-07 | Dependency graph with 55 nodes and a related CL link using its own public ID | AC-2 |
| S-07b | Deps empty | AC-1 |
| S-07c | Deps error shows retry | AC-1 |
| S-08 | Chinese Files tab at 390px with light and dark syntax palettes | AC-1 |

## Notes

- The Files tab uses `@pierre/diffs` and chooses syntax highlighting from the selected file path. Color assertions read rendered tokens inside the diff's shadow DOM.
- Dep graph: `@xyflow/react` + `@dagrejs/dagre`, `dynamic(..., { ssr: false })`.
- BFF routes reused from EG-06 / WA-09 (`checks`, `dependency-graph`, `commits`, `viewed`).
