import { describe, expect, it } from "vitest";

import { accountAvatarName } from "@/app/[lang]/workspace/account-avatar-name";

describe("account avatar surname", () => {
  it("uses the leading Han surname, including a two-character surname", () => {
    expect(accountAvatarName("马全一")).toBe("马");
    expect(accountAvatarName("欧阳修")).toBe("欧阳");
    expect(accountAvatarName("  司马懿  ")).toBe("司马");
  });

  it("uses the first letter of the last word for a spaced name", () => {
    expect(accountAvatarName("Synthetic Person")).toBe("P");
    expect(accountAvatarName("  Mock Alice  ")).toBe("A");
    expect(accountAvatarName("Solo")).toBe("S");
  });

  it("is empty for a blank name", () => {
    expect(accountAvatarName("   ")).toBe("");
  });
});
