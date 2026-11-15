// Constraints sourced from REF-01 upload route
// (`megaui:apps/next-app/app/api/upload/route.ts@0ff3a9d`) — size ceilings
// and MIME/extension allowlists are intentional ports; key prefix layout
// follows the PK-08 card (`avatars/` / `attachments/`), not upstream's
// `uploads/{userId}/…` shape (GC-03 registered intentional diff).

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_AVATAR_BYTES = 1 * 1024 * 1024;

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
] as const;

export const ALLOWED_ATTACHMENT_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
] as const;

export type UploadConstraintPurpose = "avatar" | "attachment";

export interface UploadConstraintInput {
  purpose: UploadConstraintPurpose;
  sizeBytes: number;
  mimeType: string;
  fileName: string;
}

export class UploadConstraintError extends Error {
  readonly code:
    | "FILE_TOO_LARGE"
    | "INVALID_MIME"
    | "INVALID_EXTENSION";

  constructor(
    code: UploadConstraintError["code"],
    message: string,
  ) {
    super(message);
    this.name = "UploadConstraintError";
    this.code = code;
  }
}

function extensionOf(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  if (idx < 0 || idx === fileName.length - 1) return "";
  return fileName.slice(idx).toLowerCase();
}

/**
 * Fail-closed upload constraint check (GC-07). Throws
 * {@link UploadConstraintError} when size, MIME, or extension is rejected.
 */
export function assertUploadConstraints(input: UploadConstraintInput): void {
  const max =
    input.purpose === "avatar" ? MAX_AVATAR_BYTES : MAX_ATTACHMENT_BYTES;
  if (input.sizeBytes > max) {
    throw new UploadConstraintError(
      "FILE_TOO_LARGE",
      `[@megaui/storage] file exceeds ${max} bytes for purpose=${input.purpose}`,
    );
  }

  if (input.purpose === "avatar") {
    if (
      !(ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(
        input.mimeType,
      )
    ) {
      throw new UploadConstraintError(
        "INVALID_MIME",
        `[@megaui/storage] avatar MIME not allowed: ${input.mimeType || "(empty)"}`,
      );
    }
    return;
  }

  if (
    !(ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(
      input.mimeType,
    )
  ) {
    throw new UploadConstraintError(
      "INVALID_MIME",
      `[@megaui/storage] attachment MIME not allowed: ${input.mimeType || "(empty)"}`,
    );
  }

  const ext = extensionOf(input.fileName);
  if (!(ALLOWED_ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new UploadConstraintError(
      "INVALID_EXTENSION",
      `[@megaui/storage] attachment extension not allowed: ${ext || "(none)"}`,
    );
  }
}
