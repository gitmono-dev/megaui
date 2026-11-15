import { describe, expect, it } from "vitest";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_AVATAR_BYTES,
  UploadConstraintError,
  assertUploadConstraints,
} from "./constraints";

describe("assertUploadConstraints (PK-08 AC2)", () => {
  it("accepts a valid attachment under the size and MIME allowlist", () => {
    expect(() =>
      assertUploadConstraints({
        purpose: "attachment",
        sizeBytes: 1024,
        mimeType: "image/png",
        fileName: "shot.png",
      }),
    ).not.toThrow();
  });

  it("rejects attachments over 10MB", () => {
    expect(() =>
      assertUploadConstraints({
        purpose: "attachment",
        sizeBytes: MAX_ATTACHMENT_BYTES + 1,
        mimeType: "image/png",
        fileName: "big.png",
      }),
    ).toThrow(UploadConstraintError);
  });

  it("rejects avatars over 1MB", () => {
    expect(() =>
      assertUploadConstraints({
        purpose: "avatar",
        sizeBytes: MAX_AVATAR_BYTES + 1,
        mimeType: "image/jpeg",
        fileName: "face.jpg",
      }),
    ).toThrow(/1/);
  });

  it("rejects illegal attachment MIME types", () => {
    expect(() =>
      assertUploadConstraints({
        purpose: "attachment",
        sizeBytes: 10,
        mimeType: "application/pdf",
        fileName: "doc.pdf",
      }),
    ).toThrow(UploadConstraintError);
  });

  it("rejects attachment extensions outside the allowlist", () => {
    expect(() =>
      assertUploadConstraints({
        purpose: "attachment",
        sizeBytes: 10,
        mimeType: "image/png",
        fileName: "shot.exe",
      }),
    ).toThrow(/extension/i);
  });

  it("rejects non-image MIME for avatars", () => {
    expect(() =>
      assertUploadConstraints({
        purpose: "avatar",
        sizeBytes: 10,
        mimeType: "text/plain",
        fileName: "x.txt",
      }),
    ).toThrow(/avatar MIME not allowed/i);
  });

  it("documents the attachment MIME allowlist matches REF-01", () => {
    expect([...ALLOWED_ATTACHMENT_MIME_TYPES]).toEqual([
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/svg+xml",
      "image/bmp",
    ]);
  });
});
