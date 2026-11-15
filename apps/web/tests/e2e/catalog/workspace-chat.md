# workspace-chat e2e catalog

> Specification: WA-14  
> Provenance: megaui-only lean chat pages (REF-01 channels/dm; REF-03 v10-chat visual)

## Purpose

End-to-end coverage of `/[lang]/workspace/channels/new`, `/channels/[id]` (send, thread reply, reactions, members invite chrome, virtualized jump-to-latest), and `/dm/[id]` (username resolve). Realtime typing/collab out of scope.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | Create channel → send → thread reply → reaction | AC-1 |
| S-02 | 1000 messages virtualized + jump to latest | AC-2 |
| S-03 | Invite form admin-only | AC-3 |
| S-04 | DM by username | (coverage) |

## Notes

- Stub BFF only; invite uses userId field (no members/search BFF).
- Virtualization threshold = 60 (`MessageList`); e2e uses 1000 rows.
- Typing indicators omitted (WA-14 out of scope / CS-01).
- Engine `Thread.messages` is replies-only; UI prepends channel root in the thread panel.
