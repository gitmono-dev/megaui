import { describe, expect, it } from "vitest";
import {
  resolveAuthTrustedOrigins,
  resolveAuthTrustedOriginsFromEnv,
} from "./trusted-origins";

describe("resolveAuthTrustedOrigins", () => {
  it("includes the mega2 IT stack origin on port 17001 and expands localhost aliases", () => {
    const origins = resolveAuthTrustedOrigins({
      appBaseUrl: "http://localhost:3000",
      trustedOriginsCsv: "http://127.0.0.1:17001",
    });

    expect(origins).toEqual(
      expect.arrayContaining([
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:17001",
        "http://localhost:17001",
      ]),
    );
  });

  it("dedupes overlapping APP_BASE_URL and BETTER_AUTH_URL", () => {
    const origins = resolveAuthTrustedOrigins({
      appBaseUrl: "http://localhost:3000/",
      betterAuthUrl: "http://localhost:3000",
    });
    expect(origins.filter((o) => o.includes(":3000")).length).toBe(2);
  });

  it("ignores malformed entries without throwing", () => {
    expect(
      resolveAuthTrustedOrigins({
        appBaseUrl: "not-a-url",
        trustedOriginsCsv: "also-bad,http://127.0.0.1:17001",
      }),
    ).toEqual(["http://127.0.0.1:17001", "http://localhost:17001"]);
  });
});

describe("resolveAuthTrustedOriginsFromEnv", () => {
  it("reads APP_BASE_URL / BETTER_AUTH_URL / BETTER_AUTH_TRUSTED_ORIGINS", () => {
    const origins = resolveAuthTrustedOriginsFromEnv({
      APP_BASE_URL: "http://localhost:3000",
      BETTER_AUTH_URL: "http://localhost:3000",
      BETTER_AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:17001",
    });
    expect(origins).toEqual(
      expect.arrayContaining(["http://127.0.0.1:17001", "http://localhost:17001"]),
    );
  });
});
