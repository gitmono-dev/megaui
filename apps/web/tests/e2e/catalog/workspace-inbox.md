# workspace-inbox e2e catalog

> Specification: WA-16  
> Provenance: megaui-only lean inbox + tags (REF-01 inbox/tags)

## Purpose

Coverage for `/[lang]/workspace/inbox` (filter, mark-all, unread badge, quick reply to issue/CL) and `/tags` (draft publish success + conflict).

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | Filter unread + mark all + badge | AC-1 |
| S-02 | Quick reply → issue comment | AC-2 |
| S-02b | Quick reply → CL comment | AC-2 |
| S-03 | Publish draft, hide the action on refresh, and show a 409 in a stale tab | AC-3 |

## Notes

- Notifications/unread-count BFF from WA-05 (flat EngineNotification page envelope); publish via `POST releases/:id/publish`.
- AC-1 asserts inbox unread summary and shell `[data-mega-shell="rail-count"]` stay linked via shared `notificationUnreadCount`.
- Asset upload out of scope (WA-19).
