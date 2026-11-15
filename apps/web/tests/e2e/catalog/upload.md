# upload e2e catalog

> Specification: WA-19  
> Provenance: megaui `/api/upload` + settings avatar wiring (REF-01 upload; ADR-ARCH-05 S3)

## Purpose

Avatar upload through `/api/upload?purpose=avatar` then profile preview via `authClient.updateUser`.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | Upload avatar → profile preview | AC-3 |

## Notes

- Contract coverage lives in `apps/web/tests/contract/upload.spec.ts` (401/413/415/success/ownership/cleanup).
- Live rustfs smoke gated on DEP-01/02.
