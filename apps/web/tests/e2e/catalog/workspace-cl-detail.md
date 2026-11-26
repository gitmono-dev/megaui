# workspace-cl-detail e2e catalog

> Specification: WA-09  
> Provenance: megaui-only (CL list + conversation; upstream cls pages as REF-01)

## Purpose

End-to-end coverage of `/[lang]/workspace/cls` list and `/[lang]/workspace/cls/[n]` conversation (diff patch preview, comments, inline, merge box, commits). Stub BFF by default.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | List rows show CI status and open the matching detail with Enter | AC-1 |
| S-02 | List empty state | AC-1 |
| S-03 | List error + retry | AC-1 |
| S-04 | Detail diff / comments / inline / merge box / commits | AC-1, AC-2, AC-3 |
| S-05 | Commits error + retry (mega2 fail-closed) | AC-3 |
| S-06 | zh-CN list bilingual | AC-4 |
| S-07 | Unknown CL not-found | AC-1 |
| S-08 | State shortcuts and sort preserve the search text and survive reload | AC-1 |
| S-09 | A long Chinese-locale list row fits a 320px viewport and omits unavailable diff totals | AC-1, AC-4 |

## Notes

- Merge actions are author-gated in UI; engine transition remains fail-closed.
- Commits BFF: `GET /api/mega/cls/[n]/commits` (WA-09) maps `mega_cls.link` → EG-11.
