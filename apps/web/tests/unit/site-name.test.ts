import { afterEach, describe, expect, it } from "vitest";

import { applySiteName, getSiteName } from "@/lib/site-name";

const ORIGINAL = process.env.MEGA_SITE_NAME;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MEGA_SITE_NAME;
  else process.env.MEGA_SITE_NAME = ORIGINAL;
  delete process.env.NEXT_PUBLIC_MEGA_SITE_NAME;
});

describe("site name", () => {
  it("defaults to Mega and leaves dictionary copy unchanged", () => {
    delete process.env.MEGA_SITE_NAME;
    delete process.env.NEXT_PUBLIC_MEGA_SITE_NAME;
    expect(getSiteName()).toBe("Mega");
    expect(applySiteName("Mega - 工作台")).toBe("Mega - 工作台");
  });

  it("uses MEGA_SITE_NAME in titles and brand copy", () => {
    process.env.MEGA_SITE_NAME = "mega2";
    expect(getSiteName()).toBe("mega2");
    expect(applySiteName("Mega - 工作台")).toBe("mega2 - 工作台");
    expect(applySiteName("登录或进入你的 Mega 工作台。")).toBe("登录或进入你的 mega2 工作台。");
  });
});
