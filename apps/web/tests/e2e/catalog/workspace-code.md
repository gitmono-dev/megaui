# workspace-code e2e catalog

> Specification: WA-08  
> Provenance: megaui-only (code browse; upstream code pages as REF-01)

## Purpose

End-to-end coverage of `/[lang]/workspace/code` root listing and `/[lang]/workspace/code/[...path]` tree/blob/readme views. Stub BFF routes by default; live mega2 gated on DEP-02.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | Stub: code root header + root table rows | AC-1 |
| S-02 | Stub: root-entries failure → alert + retry (fail-closed) | AC-2 |
| S-03 | Stub: file path shows tree + blob/readme | AC-1, AC-3 |
| S-03b | Stub: binary blob → binary-fallback | AC-3 |
| S-03c | Stub: oversized file → plaintext blob | AC-3 |
| S-04 | zh-CN code root bilingual | AC-4 |
| S-05 | Live mega2 root (optional DEP-02) | AC-1 |

## Notes

- Binary/oversized boundaries are exercised in the path client via `isLikelyBinaryContent` + size/line caps; stub S-03 covers markdown preview/code path.
- Live S-05 skips when `MEGA2_PUBLIC_BASE_URL` unset or openapi probe fails.
