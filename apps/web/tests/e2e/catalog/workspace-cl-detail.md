# workspace-cl-detail e2e catalog

> Specification: WA-09  
> Provenance: megaui-only (CL list + conversation; upstream cls pages as REF-01)

## Purpose

End-to-end coverage of `/[lang]/workspace/cls` list and `/[lang]/workspace/cls/[publicId]` conversation (diff patch preview, comments, inline, merge box, commits). Stub BFF by default.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | List rows show CI and public code and open its canonical detail with Enter | AC-1 |
| S-02 | List empty state | AC-1 |
| S-03 | List error + retry | AC-1 |
| S-04 | Collapsed patch preview, sorted and filtered discussion, inline threads, merge box and commits | AC-1, AC-2, AC-3 |
| S-05 | Commits error + retry (mega2 fail-closed) | AC-3 |
| S-06 | zh-CN list bilingual | AC-4 |
| S-07 | Unknown numeric identifier and unknown public code each render the missing state | AC-1 |
| S-08 | State shortcuts and sort preserve the search text and survive reload | AC-1 |
| S-09 | A long Chinese-locale list row fits a 320px viewport and omits unavailable diff totals | AC-1, AC-4 |
| S-10 | Long title, branch and author in Chinese detail fit a 320px viewport | AC-1, AC-4 |
| S-11 | Legacy conversation link opens the canonical overview; pending upstream merge requirements expand with Enter; patch payload is fetched on the Files tab | AC-1, AC-2 |
| S-12 | A legacy comment bookmark expands and scrolls to a resolved reply outside the initial five entries; changing the filter then hides it | AC-1, AC-2 |

## Notes

- Merge actions are author-gated in UI; engine transition remains fail-closed.
- Commits BFF: `GET /api/mega/cls/[n]/commits` (WA-09) maps `mega_cls.link` → EG-11.
