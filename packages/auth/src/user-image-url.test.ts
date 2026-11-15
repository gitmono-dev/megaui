import { describe, expect, it } from "vitest";
import {
  assertAllowedUserImageUrl,
  UserImageValidationError,
} from "./user-image-url";

describe("assertAllowedUserImageUrl", () => {
  it("allows empty / null and https URLs", () => {
    expect(assertAllowedUserImageUrl(null)).toBe("");
    expect(assertAllowedUserImageUrl("  ")).toBe("");
    expect(assertAllowedUserImageUrl("https://cdn.example.com/a.png")).toBe(
      "https://cdn.example.com/a.png",
    );
  });

  it("rejects data / javascript schemes", () => {
    expect(() => assertAllowedUserImageUrl("data:image/png;base64,aaa")).toThrow(
      UserImageValidationError,
    );
    expect(() => assertAllowedUserImageUrl("javascript:alert(1)")).toThrow(
      UserImageValidationError,
    );
  });

  it("allows http only under configured publicUrlBase (canonical path)", () => {
    expect(() => assertAllowedUserImageUrl("http://evil.example/a.png")).toThrow(
      UserImageValidationError,
    );
    expect(
      assertAllowedUserImageUrl("http://127.0.0.1:9000/bucket/avatars/u1/a.png", {
        publicUrlBase: "http://127.0.0.1:9000/bucket",
      }),
    ).toBe("http://127.0.0.1:9000/bucket/avatars/u1/a.png");

    expect(() =>
      assertAllowedUserImageUrl("http://127.0.0.1:9000/bucket/../private.png", {
        publicUrlBase: "http://127.0.0.1:9000/bucket",
      }),
    ).toThrow(UserImageValidationError);
  });
});
