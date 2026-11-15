# workspace-collab e2e catalog

> Specification: CS-01  
> Provenance: megaui `apps/collab-server` (Hocuspocus; REF-01 collab-server; ADR-ARCH-08)

## Purpose

Dual-client realtime sync on `container:doc:{id}` via collab ticket auth; optional UI mode assertion when `NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL` is baked into the web build.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | Two Hocuspocus clients converge | AC-1 / AC-4 |
| S-02 | Edit page `data-mode=collab` (gated on public URL build) | AC-4 / WA-13 联测 |

## Notes

- Spec spawns `apps/collab-server` with `MEGA_COLLAB_DEV_ALLOW_AUTHENTICATED=1` for authz.
- Contract/unit coverage: `apps/collab-server/src/{auth,rooms,server.integration}.test.ts`.
- Live compose service `megaui-collab` is DEP-01.
