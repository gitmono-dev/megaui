# workspace-cl-files e2e catalog

> Specification: WA-10  
> Provenance: megaui-only (CL attachment pages; upstream cls/{files,revisions,checks,deps} as REF-01)

## Purpose

End-to-end coverage of `/[lang]/workspace/cls/[publicId]/{files,revisions,checks,deps}`: file list + patch preview, revision compare → files range link, checks empty/failing/error, dependency graph (≥50 nodes smoke). Stub BFF by default.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | Files list + patch | AC-1 |
| S-02 | Files empty | AC-1 |
| S-03 | Numeric deep links retain their tab, comparison query and fragment after canonicalization and refresh. Enter opens the revisions tab by public ID | AC-1 |
| S-03b | Bookmarks for both hyphenated and underscored public IDs keep the file range and fragment at the current alphanumeric ID | AC-1 |
| S-04 | Revision cards, commits and a comparison link with the same public ID | AC-1 |
| S-04b | Revisions empty | AC-1 |
| S-05 | Checks passing / empty / failing | AC-1, AC-3 |
| S-06 | Checks error shows retry | AC-1 |
| S-07 | Dependency graph with 55 nodes and a related CL link using its own public ID | AC-2 |
| S-07b | Deps empty | AC-1 |
| S-07c | Deps error shows retry | AC-1 |
| S-08 | zh-CN chrome tabs | AC-1 |

## Notes

- Lean diffs: preformatted patch (no pierre SSR preload).
- Dep graph: `@xyflow/react` + `@dagrejs/dagre`, `dynamic(..., { ssr: false })`.
- BFF routes reused from EG-06 / WA-09 (`checks`, `dependency-graph`, `commits`, `viewed`).
