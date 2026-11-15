# workspace-cl-files e2e catalog

> Specification: WA-10  
> Provenance: megaui-only (CL attachment pages; upstream cls/{files,revisions,checks,deps} as REF-01)

## Purpose

End-to-end coverage of `/[lang]/workspace/cls/[n]/{files,revisions,checks,deps}`: file list + patch preview, revision compare → files range link, checks empty/failing/error, dependency graph (≥50 nodes smoke). Stub BFF by default.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | Files list + patch | AC-1 |
| S-02 | Files empty | AC-1 |
| S-03 | Files `?range=` patch | AC-1 |
| S-04 | Revisions cards + compare + commits | AC-1 |
| S-04b | Revisions empty | AC-1 |
| S-05 | Checks passing / empty / failing | AC-1, AC-3 |
| S-06 | Checks error shows retry | AC-1 |
| S-07 | Deps graph 50+ nodes smoke | AC-2 |
| S-07b | Deps empty | AC-1 |
| S-07c | Deps error shows retry | AC-1 |
| S-08 | zh-CN chrome tabs | AC-1 |

## Notes

- Lean diffs: preformatted patch (no pierre SSR preload).
- Dep graph: `@xyflow/react` + `@dagrejs/dagre`, `dynamic(..., { ssr: false })`.
- BFF routes reused from EG-06 / WA-09 (`checks`, `dependency-graph`, `commits`, `viewed`).
