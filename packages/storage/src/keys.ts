// Key planning for PK-08: `avatars/{userId}/…` and `attachments/{userId}/…`
// with ownership + path-traversal rejection (GC-07). Intentional layout
// diff vs upstream upload route's `uploads/{userId}/…` (registered on the
// PK-08 task card / ADR-ARCH-05).

import type { StoragePurpose } from "./types";

export class StorageKeyError extends Error {
  readonly code: "INVALID_USER_ID" | "PATH_TRAVERSAL" | "OWNERSHIP" | "INVALID_KEY";

  constructor(code: StorageKeyError["code"], message: string) {
    super(message);
    this.name = "StorageKeyError";
    this.code = code;
  }
}

const PURPOSE_PREFIX: Record<StoragePurpose, string> = {
  avatar: "avatars",
  attachment: "attachments",
};

function assertSafeSegment(segment: string, label: string): void {
  if (!segment || segment.includes("/") || segment.includes("\\")) {
    throw new StorageKeyError(
      "INVALID_USER_ID",
      `[@megaui/storage] ${label} must be a non-empty single path segment`,
    );
  }
  if (segment === "." || segment === "..") {
    throw new StorageKeyError(
      "PATH_TRAVERSAL",
      `[@megaui/storage] ${label} must not be '.' or '..'`,
    );
  }
  if (segment.includes("..")) {
    throw new StorageKeyError(
      "PATH_TRAVERSAL",
      `[@megaui/storage] ${label} must not contain '..'`,
    );
  }
}

function assertSafeFileName(fileName: string): void {
  if (!fileName || fileName.includes("/") || fileName.includes("\\")) {
    throw new StorageKeyError(
      "INVALID_KEY",
      "[@megaui/storage] fileName must be a non-empty single path segment",
    );
  }
  if (fileName.includes("..")) {
    throw new StorageKeyError(
      "PATH_TRAVERSAL",
      "[@megaui/storage] fileName must not contain '..'",
    );
  }
}

/** Build an owned object key: `{avatars|attachments}/{userId}/{fileName}`. */
export function buildObjectKey(input: {
  purpose: StoragePurpose;
  userId: string;
  fileName: string;
}): string {
  assertSafeSegment(input.userId, "userId");
  assertSafeFileName(input.fileName);
  const prefix = PURPOSE_PREFIX[input.purpose];
  return `${prefix}/${input.userId}/${input.fileName}`;
}

/**
 * Assert that `key` is under the caller's owned prefix for `purpose`.
 * Rejects path traversal and cross-user keys (GC-07).
 */
export function assertKeyOwnedByUser(input: {
  key: string;
  purpose: StoragePurpose;
  userId: string;
}): void {
  assertSafeSegment(input.userId, "userId");
  if (!input.key || input.key.startsWith("/") || input.key.includes("\\")) {
    throw new StorageKeyError(
      "INVALID_KEY",
      "[@megaui/storage] key must be a relative object path",
    );
  }
  if (input.key.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new StorageKeyError(
      "PATH_TRAVERSAL",
      `[@megaui/storage] key contains empty or '.'/'..' segments: ${input.key}`,
    );
  }

  const expectedPrefix = `${PURPOSE_PREFIX[input.purpose]}/${input.userId}/`;
  if (!input.key.startsWith(expectedPrefix)) {
    throw new StorageKeyError(
      "OWNERSHIP",
      `[@megaui/storage] key is outside owned prefix ${expectedPrefix}`,
    );
  }
  if (input.key.length <= expectedPrefix.length) {
    throw new StorageKeyError(
      "INVALID_KEY",
      "[@megaui/storage] key must include a file name under the owned prefix",
    );
  }
}
