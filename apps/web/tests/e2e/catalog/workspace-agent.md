# workspace-agent e2e catalog

> Specification: WA-15  
> Provenance: megaui-only lean agent/sessions (REF-01 agent/sessions; SSE from WA-06)

## Purpose

Coverage for `/[lang]/workspace/agent` (index redirect), `/agent/[threadId]` (ask SSE, llm_disabled), and `/sessions/[threadId]` (usage + citation links). Live LLM gated on DEP-03.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | Ask → stream → refresh | AC-1 |
| S-02 | llm_disabled guide | AC-2 |
| S-03 | Session usage + citation click | AC-3 |

## Notes

- Stub LLM SSE; agent REST list/get/create co-landed with pages.
- Sessions are fixture-backed (`GET /api/mega/sessions/:id`).
- Live LLM: skip without DEP-03.
