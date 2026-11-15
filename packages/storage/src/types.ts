// megaui:libs/storage/types.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-08 task card):
// - Dropped multi-provider `StorageConfig.provider` union (`oss`/`r2`/`cos`)
//   — ADR-ARCH-05 keeps a single S3-compatible path.
// - Surface narrowed to the types this package actually exports (presign /
//   public URL / key planning); full `StorageProvider` interface with
//   upload/delete/list is not required by PK-08 ACs (WA-19 may extend).
export type StoragePurpose = "avatar" | "attachment";

export type SignedUrlOperation = "get" | "put";

export interface SignedUrlParams {
  key: string;
  expiresIn?: number;
  contentType?: string;
  operation?: SignedUrlOperation;
}

export interface SignedUrlResult {
  url: string;
  expiresAt: Date;
}

/** Explicit S3-compatible credentials — no implicit env fallback (GC-07). */
export interface S3StorageConfig {
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  /** Public base URL for permanent read URLs (no signature). */
  publicUrl?: string;
  /** Default presign TTL in seconds (default 3600). */
  defaultExpiration?: number;
}
