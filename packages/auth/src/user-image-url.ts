// megaui:libs/validators/user-image-url.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-06 task card):
// - No `@config` singleton — callers pass optional `publicUrlBase`
//   (typically `S3_PUBLIC_URL`) so http avatar URLs under that prefix are
//   allowed; https is always allowed; data:/javascript:/vbscript: rejected.
// - HTTP prefix check compares canonical origin + pathname (URL API resolves
//   `..` segments) instead of raw string prefix, closing path-escape bypass.

export type UserImageErrorCode = "USER_IMAGE_INVALID_SCHEME" | "USER_IMAGE_INVALID_URL";

export class UserImageValidationError extends Error {
  readonly code: UserImageErrorCode;

  constructor(code: UserImageErrorCode) {
    super(code);
    this.name = "UserImageValidationError";
    this.code = code;
  }
}

export interface AssertAllowedUserImageUrlOptions {
  /** When set, http(s) URLs under this public object-store base are allowed. */
  publicUrlBase?: string | undefined;
}

function normalizeImageValue(image: string | null | undefined): string {
  if (image == null) return "";
  return image.trim();
}

function isPathUnderBase(candidatePath: string, basePath: string): boolean {
  const base = basePath.replace(/\/+$/, "") || "";
  if (base === "") {
    // Base is origin root (`http://host:port`) — any path on that origin is OK.
    return candidatePath.startsWith("/");
  }
  return candidatePath === base || candidatePath.startsWith(`${base}/`);
}

/**
 * Validates `user.image` before persistence (GC-07 fail-closed).
 * Allows empty, https URLs, and http(s) URLs under `publicUrlBase`.
 */
export function assertAllowedUserImageUrl(
  image: string | null | undefined,
  options: AssertAllowedUserImageUrlOptions = {},
): string {
  const value = normalizeImageValue(image);
  if (value === "") return "";

  const lower = value.toLowerCase();
  if (
    lower.startsWith("data:") ||
    lower.startsWith("javascript:") ||
    lower.startsWith("vbscript:")
  ) {
    throw new UserImageValidationError("USER_IMAGE_INVALID_SCHEME");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UserImageValidationError("USER_IMAGE_INVALID_URL");
  }

  if (parsed.protocol === "https:") {
    return value;
  }

  if (parsed.protocol === "http:") {
    const publicBase = options.publicUrlBase?.trim();
    if (!publicBase) {
      throw new UserImageValidationError("USER_IMAGE_INVALID_URL");
    }
    let baseParsed: URL;
    try {
      baseParsed = new URL(publicBase);
    } catch {
      throw new UserImageValidationError("USER_IMAGE_INVALID_URL");
    }
    // `parsed.pathname` is already canonical (`/a/../b` → `/b`).
    if (
      parsed.origin === baseParsed.origin &&
      isPathUnderBase(parsed.pathname, baseParsed.pathname)
    ) {
      return value;
    }
    throw new UserImageValidationError("USER_IMAGE_INVALID_URL");
  }

  throw new UserImageValidationError("USER_IMAGE_INVALID_SCHEME");
}
