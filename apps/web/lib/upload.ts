// megaui-only (WA-19): S3 upload orchestration on top of @megaui/storage.

import {
  assertKeyOwnedByUser,
  assertUploadConstraints,
  buildObjectKey,
  createS3Storage,
  StorageKeyError,
  UploadConstraintError,
  type S3Storage,
  type UploadConstraintPurpose,
} from "@megaui/storage";

import { getRuntimeSecrets } from "@/lib/env";

export type UploadPurpose = UploadConstraintPurpose;

export type UploadResult = {
  key: string;
  url: string;
};

export type UploadStorage = Pick<S3Storage, "putObject" | "deleteObject" | "buildPublicUrl">;

let storageSingleton: S3Storage | null = null;

/** Test seam — replace the storage backend used by the upload route. */
export function setUploadStorageForTests(storage: UploadStorage | null): void {
  storageSingleton = storage as S3Storage | null;
}

export function getUploadStorage(): UploadStorage {
  if (storageSingleton) return storageSingleton;
  const secrets = getRuntimeSecrets();
  storageSingleton = createS3Storage({
    config: {
      region: requireEnv("S3_REGION"),
      accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
      accessKeySecret: requireEnv("S3_ACCESS_KEY_SECRET"),
      bucket: requireEnv("S3_BUCKET"),
      endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
      publicUrl: secrets.s3PublicUrl || requireEnv("S3_PUBLIC_URL"),
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE?.trim() || "true") === "true",
    },
  });
  return storageSingleton;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`[@megaui/web] ${name} is required for uploads (GC-07 fail-closed)`);
  }
  return value;
}

function uniqueFileName(originalName: string): string {
  const ext = originalName.includes(".")
    ? originalName.slice(originalName.lastIndexOf(".")).toLowerCase()
    : ".bin";
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${stamp}${ext}`;
}

/**
 * Upload a file for the authenticated user. On put failure, deletes the key
 * if a partial write may have occurred (GC-08). Ownership is enforced via
 * buildObjectKey + assertKeyOwnedByUser.
 */
export async function uploadUserObject(input: {
  userId: string;
  purpose: UploadPurpose;
  fileName: string;
  mimeType: string;
  body: Uint8Array;
  storage?: UploadStorage;
}): Promise<UploadResult> {
  assertUploadConstraints({
    purpose: input.purpose,
    sizeBytes: input.body.byteLength,
    mimeType: input.mimeType,
    fileName: input.fileName,
  });

  const key = buildObjectKey({
    purpose: input.purpose,
    userId: input.userId,
    fileName: uniqueFileName(input.fileName),
  });
  assertKeyOwnedByUser({ key, purpose: input.purpose, userId: input.userId });

  const storage = input.storage ?? getUploadStorage();
  try {
    await storage.putObject({
      key,
      body: input.body,
      contentType: input.mimeType,
      metadata: { purpose: input.purpose, owner: input.userId },
    });
  } catch (error) {
    try {
      await storage.deleteObject({ key });
    } catch {
      // Best-effort compensate; surface the original put failure.
    }
    throw error;
  }

  const url = storage.buildPublicUrl(key);
  if (!url) {
    try {
      await storage.deleteObject({ key });
    } catch {
      // Compensating delete after missing public URL.
    }
    throw new Error("[@megaui/web] S3_PUBLIC_URL is required to return a public upload URL");
  }

  return { key, url };
}

export function mapUploadErrorStatus(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof UploadConstraintError) {
    if (error.code === "FILE_TOO_LARGE") {
      return { status: 413, code: "UPLOAD_FILE_TOO_LARGE", message: error.message };
    }
    return { status: 415, code: "UPLOAD_INVALID_TYPE", message: error.message };
  }
  if (error instanceof StorageKeyError) {
    return { status: 403, code: "UPLOAD_FORBIDDEN_KEY", message: error.message };
  }
  if (error instanceof Error) {
    return { status: 500, code: "UPLOAD_FAILED", message: error.message };
  }
  return { status: 500, code: "UPLOAD_FAILED", message: "Upload failed" };
}

/** Exported for unit tests of key ownership without going through HTTP. */
export function assertUploadKeyOwned(userId: string, purpose: UploadPurpose, key: string): void {
  assertKeyOwnedByUser({ key, purpose, userId });
}
