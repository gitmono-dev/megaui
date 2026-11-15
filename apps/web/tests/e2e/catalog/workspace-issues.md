# workspace-issues e2e catalog

> Specification: WA-11 / RX-03
> Provenance: megaui-only (Issues list + detail; upstream issues pages as REF-01)

## Purpose

End-to-end coverage of `/[lang]/workspace/issues` list (filter/tabs/empty/error) and `/[lang]/workspace/issues/[n]` detail (body, timeline/comments, interactive issue and comment reactions for signed-in members, author/assignee plain-text editor, close/reopen toasts, watch persistence). Stub BFF by default.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | List rows | AC-1 |
| S-02 | List empty | AC-1 |
| S-03 | List error + retry | AC-1 |
| S-04 | Closed tab filter | AC-1 |
| S-04b | Sort control + order | AC-1 |
| S-04c | Pagination beyond page 1 | AC-1 |
| S-05 | Detail body / timeline / reactions; default session has no Edit | WA-11 AC-1 / IB-03 AC-1 |
| S-05b | Author Edit → Done updates body-text | IB-03 AC-2 |
| S-05c | Assignee Edit → Done updates body-text | IB-03 AC-1 / AC-2 |
| S-05d | Body save 403 error toast | IB-03 AC-3 |
| S-06 | Close/reopen success toasts | AC-2 |
| S-07 | Close 403 error toast | AC-2 |
| S-08 | Watch toggle watcherIds | AC-3 |
| S-09 | Unknown issue not-found | AC-1 |
| S-10 | zh-CN list bilingual | AC-1 |
| S-11 | Member (not author) adds issue reaction via add picker (new) | RX-03 AC-1 / AC-2 |
| S-12 | Member toggles comment reaction and adds via picker (new) | RX-03 AC-2 |
| S-13 | Reaction 403 error toast (new) | RX-03 AC-3 |

## Notes

- Signed-in members can add or toggle issue and comment reactions (`POST /issues/[n]/reactions` and `POST /issue-comments/:id/reactions`). The interactive predicate is session (`canReact`), not author-or-assignee (`canEdit`). The list page does not render reaction pills.
- Body editor is plain textarea for the issue author or an assignee (`POST /issues/[n]/body`); other signed-in members stay read-only. Default stub author id stays distinct from the minted session so existing detail scenarios assert no Edit.
- ACL: session-gated action chrome; fail-closed 403 → `errors.mega.forbidden` toast. Body save failures use the same mapping or `detail.body.saveFailed`.
