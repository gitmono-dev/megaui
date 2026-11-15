import { describe, expect, it } from "vitest";
import {
  StorageKeyError,
  assertKeyOwnedByUser,
  buildObjectKey,
} from "./keys";

describe("buildObjectKey / assertKeyOwnedByUser (PK-08 AC2/AC3)", () => {
  it("builds avatars/{userId}/{file} and attachments/{userId}/{file}", () => {
    expect(
      buildObjectKey({
        purpose: "avatar",
        userId: "user-1",
        fileName: "a.png",
      }),
    ).toBe("avatars/user-1/a.png");
    expect(
      buildObjectKey({
        purpose: "attachment",
        userId: "user-1",
        fileName: "b.jpg",
      }),
    ).toBe("attachments/user-1/b.jpg");
  });

  it("rejects path traversal in userId or fileName", () => {
    expect(() =>
      buildObjectKey({
        purpose: "avatar",
        userId: "../evil",
        fileName: "a.png",
      }),
    ).toThrow(StorageKeyError);
    expect(() =>
      buildObjectKey({
        purpose: "avatar",
        userId: "user-1",
        fileName: "../etc/passwd",
      }),
    ).toThrow(StorageKeyError);
  });

  it("accepts keys under the caller's owned prefix", () => {
    expect(() =>
      assertKeyOwnedByUser({
        key: "attachments/user-1/photo.png",
        purpose: "attachment",
        userId: "user-1",
      }),
    ).not.toThrow();
  });

  it("rejects keys owned by another user", () => {
    expect(() =>
      assertKeyOwnedByUser({
        key: "attachments/other-user/photo.png",
        purpose: "attachment",
        userId: "user-1",
      }),
    ).toThrow(/owned prefix/);
  });

  it("rejects path-traversal keys including '.' segments", () => {
    expect(() =>
      assertKeyOwnedByUser({
        key: "attachments/user-1/../../secret",
        purpose: "attachment",
        userId: "user-1",
      }),
    ).toThrow(StorageKeyError);
    expect(() =>
      assertKeyOwnedByUser({
        key: "attachments/user-1/./file.png",
        purpose: "attachment",
        userId: "user-1",
      }),
    ).toThrow(StorageKeyError);
  });

  it("rejects absolute keys and wrong purpose prefixes", () => {
    expect(() =>
      assertKeyOwnedByUser({
        key: "/attachments/user-1/a.png",
        purpose: "attachment",
        userId: "user-1",
      }),
    ).toThrow(StorageKeyError);
    expect(() =>
      assertKeyOwnedByUser({
        key: "avatars/user-1/a.png",
        purpose: "attachment",
        userId: "user-1",
      }),
    ).toThrow(/owned prefix/);
  });
});
