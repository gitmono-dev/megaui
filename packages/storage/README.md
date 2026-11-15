# `@megaui/storage`

S3-compatible object storage client for megaui (`ADR-ARCH-05`): explicit
credentials, presigned PUT/GET, public URL assembly, and upload key /
constraint helpers. No vendor-specific SDKs (OSS/COS) and no R2 factory —
a single `@aws-sdk/client-s3` path only.

## Provenance (GC-03)

Ported surfaces carry a GC-03 provenance header such as
`megaui:libs/storage/providers/s3.ts@0ff3a9d`. Baseline SHA `0ff3a9d`
(plan `REF-07` / `REF-01` for upload constraints).

| File | Source path |
|---|---|
| `src/s3-storage.ts` | `libs/storage/providers/s3.ts` |
| `src/types.ts` | `libs/storage/types.ts` |
| `src/constraints.ts` | `apps/next-app/app/api/upload/route.ts` (size/MIME only) |
| `src/keys.ts` | megaui-only layout (`avatars/` / `attachments/`) |

### Diffs vs upstream (intentional — registered on the PK-08 task card)

| Upstream surface | Disposition here | Why |
|---|---|---|
| OSS / COS / R2 factory (`createStorageProvider`, `createR2Provider`) | Removed | ADR-ARCH-05: one S3-compatible endpoint (rustfs / MinIO / AWS). |
| `@config` singleton + `STORAGE_PROVIDER` env switch | Removed | Explicit `S3StorageConfig` only (GC-07 fail-closed). |
| Key prefix `uploads/{userId}/…` | Replaced with `avatars/{userId}/…` and `attachments/{userId}/…` | PK-08 card key-planning requirement; ownership checks are prefix-based. |

## Usage

```ts
import {
  assertUploadConstraints,
  assertKeyOwnedByUser,
  buildObjectKey,
  createS3Storage,
} from "@megaui/storage";

assertUploadConstraints({
  purpose: "attachment",
  sizeBytes: file.size,
  mimeType: file.type,
  fileName: file.name,
});

const key = buildObjectKey({
  purpose: "attachment",
  userId: session.user.id,
  fileName: uniqueName,
});
assertKeyOwnedByUser({ key, purpose: "attachment", userId: session.user.id });

const storage = createS3Storage({
  config: {
    region: process.env.S3_REGION!,
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    accessKeySecret: process.env.S3_ACCESS_KEY_SECRET!,
    bucket: process.env.S3_BUCKET!,
    endpoint: process.env.S3_ENDPOINT,
    publicUrl: process.env.S3_PUBLIC_URL,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  },
});

const { url } = await storage.createSignedUrl({
  key,
  operation: "put",
  contentType: file.type,
});
```

`/api/upload` wiring is out of scope (WA-19).
