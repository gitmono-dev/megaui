# workspace-home e2e catalog

> Specification: WA-07  
> Provenance: megaui-only (workspace shell + home; upstream layout/page as REF-01)

## Purpose

End-to-end coverage of `/[lang]/workspace` shell (rail + command palette) and home dashboard states.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | Signed-in user sees rail, palette trigger, and home page | AC-1 |
| S-02 | Guest visiting workspace redirects to signin | AC-2 |
| S-03 | Home KPI strip and card grid render (empty-friendly) | AC-3 |
| S-03b | Stubbed empty home dashboard shows `data-mega-home="card-empty"` | AC-3 |
| S-03c | Home shows recent CL links when no review is requested, and the personal review count stays zero | AC-3 |
| S-04 | Home load error shows alert + retry | AC-3 |
| S-05 | Metadata title uses workspace.metadata | AC-4 |
| S-06 | zh-CN workspace home renders bilingual strings | AC-4 |
| S-07 | Palette shows `errors.search.cjkScaleExceeded` on CJK scale 503 | AC-5 |

## Notes

- S-02 overlaps WA-01 fail-closed protection; asserted again for WA-07.
- S-07 uses `page.route` to stub `/api/mega/search` with the WA-05 CJK envelope.
