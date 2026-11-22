// megaui-only (FSL-181 AC7): `selfDisplayName` reads `displayName` when it is a string and
// falls back to `name` otherwise; without a user it answers `undefined`.
import { describe, expect, it } from "vitest";

import { selfDisplayName } from "@/lib/self-display-name";

describe("FSL-181 AC7: selfDisplayName", () => {
  it("returns displayName when it is a string, as is", () => {
    expect(selfDisplayName({ name: "fs_u-1", displayName: "王五 Wang Wu" })).toBe("王五 Wang Wu");
    expect(selfDisplayName({ name: "fs_u-1", displayName: "  padded  " })).toBe("  padded  ");
    expect(selfDisplayName({ name: "fs_u-1", displayName: "" })).toBe("");
    // A display name equal to the principal is still the display name.
    expect(selfDisplayName({ name: "fs_u-1", displayName: "fs_u-1" })).toBe("fs_u-1");
  });

  it("returns name when displayName is missing (a legacy projection)", () => {
    expect(selfDisplayName({ name: "Ada Lovelace" })).toBe("Ada Lovelace");
    expect(selfDisplayName({ name: "  padded  " })).toBe("  padded  ");
    expect(selfDisplayName({ name: "Ada", displayName: undefined })).toBe("Ada");
  });

  it("returns name when displayName is not a string", () => {
    for (const displayName of [null, 42, true, {}, ["x"]]) {
      expect(selfDisplayName({ name: "Ada", displayName })).toBe("Ada");
    }
  });

  it("returns an empty name as is", () => {
    expect(selfDisplayName({ name: "" })).toBe("");
    expect(selfDisplayName({ name: "", displayName: null })).toBe("");
  });

  it("returns undefined without a user", () => {
    expect(selfDisplayName(undefined)).toBeUndefined();
    expect(selfDisplayName(null)).toBeUndefined();
  });
});
