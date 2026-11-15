import { describe, expect, it } from "vitest";
import {
  resolveSocialProviders,
  resolveSocialProvidersFromEnv,
} from "./social-providers";

describe("resolveSocialProviders", () => {
  it("omits Google and GitHub when credentials are missing (fail-closed default off)", () => {
    expect(resolveSocialProviders({})).toEqual({});
    expect(
      resolveSocialProviders({
        google: { clientId: "", clientSecret: "" },
        github: { clientId: "  ", clientSecret: "  " },
      }),
    ).toEqual({});
  });

  it("registers only providers with both clientId and clientSecret", () => {
    const both = resolveSocialProviders({
      google: { clientId: "g-id", clientSecret: "g-secret" },
      github: { clientId: "gh-id", clientSecret: "gh-secret" },
    });
    expect(both.google).toEqual({ clientId: "g-id", clientSecret: "g-secret" });
    expect(both.github?.clientId).toBe("gh-id");
    expect(both.github?.mapProfileToUser({})).toEqual({ emailVerified: true });

    const googleOnly = resolveSocialProviders({
      google: { clientId: "g-id", clientSecret: "g-secret" },
      github: { clientId: "gh-id", clientSecret: "" },
    });
    expect(Object.keys(googleOnly)).toEqual(["google"]);
  });

  it("does not throw when credentials are absent", () => {
    expect(() => resolveSocialProvidersFromEnv({})).not.toThrow();
    expect(resolveSocialProvidersFromEnv({})).toEqual({});
  });
});
