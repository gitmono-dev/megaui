import { describe, expect, it } from "vitest";
import { getRefererInfo } from "./referer-info";

describe("getRefererInfo", () => {
  it("returns default locale when referer is missing", () => {
    expect(getRefererInfo()).toEqual({ locale: "en", lastSegment: "" });
    expect(getRefererInfo(new Request("http://localhost/api"))).toEqual({
      locale: "en",
      lastSegment: "",
    });
  });

  it("parses locale and last segment from a workspace auth path", () => {
    const request = new Request("http://localhost/api/auth/sign-up/email", {
      headers: { referer: "http://localhost:3000/zh-CN/signup" },
    });
    expect(getRefererInfo(request)).toEqual({
      locale: "zh-CN",
      lastSegment: "signup",
    });
  });

  it("falls back to default locale for unknown locale prefixes", () => {
    const request = new Request("http://localhost/api", {
      headers: { referer: "http://localhost:3000/fr/signin" },
    });
    expect(getRefererInfo(request)).toEqual({
      locale: "en",
      lastSegment: "signin",
    });
  });
});
