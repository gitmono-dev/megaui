import { describe, expect, it } from "vitest";
import { MegaBadRequestError, MegaForbiddenError } from "../../errors";
import { assertReleaseAssetKeyOwnership, buildReleaseAssetKey } from "./asset-key";

describe("buildReleaseAssetKey", () => {
  it("builds a `releases/{releaseId}/{fileName}` key", () => {
    expect(buildReleaseAssetKey({ releaseId: "release_1", fileName: "app-linux.tar.gz" })).toBe(
      "releases/release_1/app-linux.tar.gz",
    );
  });

  it("rejects a releaseId or fileName containing a path separator or traversal", () => {
    expect(() => buildReleaseAssetKey({ releaseId: "release_1/../other", fileName: "x.tar.gz" })).toThrow(
      MegaBadRequestError,
    );
    expect(() => buildReleaseAssetKey({ releaseId: "release_1", fileName: "../secret" })).toThrow(MegaBadRequestError);
    expect(() => buildReleaseAssetKey({ releaseId: "release_1", fileName: "a/b.tar.gz" })).toThrow(MegaBadRequestError);
    expect(() => buildReleaseAssetKey({ releaseId: "", fileName: "x.tar.gz" })).toThrow(MegaBadRequestError);
  });
});

describe("assertReleaseAssetKeyOwnership (AC: asset key ownership, GC-07)", () => {
  it("accepts a key scoped under the release's own prefix", () => {
    expect(() =>
      assertReleaseAssetKeyOwnership({ key: "releases/release_1/app-linux.tar.gz", releaseId: "release_1" }),
    ).not.toThrow();
    expect(() =>
      assertReleaseAssetKeyOwnership({
        key: buildReleaseAssetKey({ releaseId: "release_1", fileName: "nested-name_v2.zip" }),
        releaseId: "release_1",
      }),
    ).not.toThrow();
  });

  it("rejects a key scoped to a different release (cross-release hijack, GC-07)", () => {
    expect(() =>
      assertReleaseAssetKeyOwnership({ key: "releases/release_2/app-linux.tar.gz", releaseId: "release_1" }),
    ).toThrow(MegaForbiddenError);
  });

  it("rejects a key outside the releases namespace entirely (e.g. an avatar key)", () => {
    expect(() =>
      assertReleaseAssetKeyOwnership({ key: "avatars/usr_1/pic.png", releaseId: "release_1" }),
    ).toThrow(MegaForbiddenError);
  });

  it("rejects absolute paths and backslashes as malformed (not merely out-of-scope)", () => {
    expect(() =>
      assertReleaseAssetKeyOwnership({ key: "/releases/release_1/app.tar.gz", releaseId: "release_1" }),
    ).toThrow(MegaBadRequestError);
    expect(() =>
      assertReleaseAssetKeyOwnership({ key: "releases\\release_1\\app.tar.gz", releaseId: "release_1" }),
    ).toThrow(MegaBadRequestError);
  });

  it("rejects path traversal segments even when the prefix looks correct", () => {
    expect(() =>
      assertReleaseAssetKeyOwnership({ key: "releases/release_1/../release_2/app.tar.gz", releaseId: "release_1" }),
    ).toThrow(MegaBadRequestError);
    expect(() =>
      assertReleaseAssetKeyOwnership({ key: "releases/release_1/./app.tar.gz", releaseId: "release_1" }),
    ).toThrow(MegaBadRequestError);
    expect(() =>
      assertReleaseAssetKeyOwnership({ key: "releases/release_1//app.tar.gz", releaseId: "release_1" }),
    ).toThrow(MegaBadRequestError);
  });

  it("rejects a key that is exactly the owned prefix with no file name", () => {
    expect(() =>
      assertReleaseAssetKeyOwnership({ key: "releases/release_1/", releaseId: "release_1" }),
    ).toThrow(MegaBadRequestError);
  });

  it("rejects an empty key and an empty releaseId", () => {
    expect(() => assertReleaseAssetKeyOwnership({ key: "", releaseId: "release_1" })).toThrow(MegaBadRequestError);
    expect(() =>
      assertReleaseAssetKeyOwnership({ key: "releases/release_1/app.tar.gz", releaseId: "" }),
    ).toThrow(MegaBadRequestError);
  });
});
