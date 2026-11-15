# workspace-chat-live e2e catalog

> Specification: RT-09  
> Provenance: megaui-only collection rooms (ADR-RT-01; REF-01 collection hook)

## Purpose

Two-client realtime convergence for Channel send / edit / reaction without treating 15s polling as the only update path, plus REST + polling fallback when `megaui-collab` is down. Unread stays on PG watermark.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | Two Hocuspocus collection clients converge on append/bump | AC-1 |
| S-02 | Two browsers see send + reaction; unread is not double-counted | AC-1 / AC-3 |
| S-03 | Collab process down: POST still succeeds; peer sees via polling | AC-2 / AC-4 |

## Notes

- No BFF stubs. Compose `website-next` `:17001` + `megaui-collab` `:17002` is the preferred live harness (DEP-RT-01).
- Spec also spawns a local `apps/collab-server` for S-01 so transport evidence does not depend on skip.
- Polling fallback uses `refetchInterval: 15000` when the room is disconnected.
