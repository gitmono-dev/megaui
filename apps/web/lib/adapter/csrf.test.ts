import { describe, expect, it } from "vitest";
import {
  CSRF_ORIGIN_REJECTED_CODE,
  requireSameOriginCsrf,
  resolveCanonicalAllowedOrigins,
} from "./csrf";
import { assertMegaFailureEnvelope } from "./envelope";

describe("canonical-origin CSRF guard (CLB-20)", () => {
  const canonicalEnv: Record<string, string | undefined> = {
    APP_BASE_URL: "https://mega.example.com/app",
    BETTER_AUTH_URL: "https://auth.example.com",
    BETTER_AUTH_TRUSTED_ORIGINS:
      "http://127.0.0.1:3000, https://staging.example.com/sub , https://*.evil.com",
  };

  it("derives allowed origins exclusively from server-side config, expands loopback aliases, and ignores wildcards", () => {
    const origins = resolveCanonicalAllowedOrigins(canonicalEnv);
    expect([...origins].sort()).toEqual([
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      "https://auth.example.com",
      "https://mega.example.com",
      "https://staging.example.com",
    ]);
  });

  it("matches Better Auth localhost/127.0.0.1 alias parity at the exact same protocol and port", () => {
    const itEnv = { APP_BASE_URL: "http://localhost:17001" };
    expect(
      requireSameOriginCsrf(
        new Request("http://internal:3000/api/mega/cls", {
          method: "POST",
          headers: { Origin: "http://127.0.0.1:17001" },
        }),
        itEnv,
      ),
    ).toBeUndefined();
    expect(
      requireSameOriginCsrf(
        new Request("http://internal:3000/api/mega/cls", {
          method: "POST",
          headers: { Origin: "http://127.0.0.1:17002" },
        }),
        itEnv,
      )?.status,
    ).toBe(403);
    expect(
      requireSameOriginCsrf(
        new Request("http://internal:3000/api/mega/cls", {
          method: "POST",
          headers: { Origin: "https://127.0.0.1:17001" },
        }),
        itEnv,
      )?.status,
    ).toBe(403);
  });

  it("fails closed when no server-side origin variables are configured", async () => {
    const req = new Request("http://127.0.0.1:3000/api/mega/cls", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        Host: "127.0.0.1:3000",
        "X-Forwarded-Host": "127.0.0.1:3000",
      },
    });
    const rejected = requireSameOriginCsrf(req, {});
    expect(rejected).toBeDefined();
    expect(rejected?.status).toBe(403);
    const body: unknown = await rejected?.json();
    assertMegaFailureEnvelope(body);
    expect(body.error.code).toBe(CSRF_ORIGIN_REJECTED_CODE);
  });

  it("allows same-origin requests whose Origin matches server-side whitelist", () => {
    const req = new Request("http://internal-container:3000/api/mega/cls", {
      method: "POST",
      headers: {
        Origin: "https://mega.example.com",
        "Sec-Fetch-Site": "same-origin",
      },
    });
    expect(requireSameOriginCsrf(req, canonicalEnv)).toBeUndefined();
  });

  it("rejects missing Origin, null Origin, cross-site Origin, Sec-Fetch-Site: cross-site, and spoofed Host/X-Forwarded-Host", async () => {
    const cases: Array<{ name: string; headers: Record<string, string> }> = [
      { name: "missing Origin", headers: {} },
      { name: "null Origin", headers: { Origin: "null" } },
      {
        name: "cross-site Origin",
        headers: { Origin: "https://attacker.example" },
      },
      {
        name: "Sec-Fetch-Site cross-site even with whitelisted Origin",
        headers: {
          Origin: "https://mega.example.com",
          "Sec-Fetch-Site": "cross-site",
        },
      },
      {
        name: "spoofed Host and X-Forwarded-Host matching attacker Origin",
        headers: {
          Origin: "https://attacker.example",
          Host: "attacker.example",
          "X-Forwarded-Host": "attacker.example",
        },
      },
      {
        name: "Origin with trailing path",
        headers: { Origin: "https://mega.example.com/" },
      },
    ];

    for (const tc of cases) {
      const req = new Request("https://attacker.example/api/mega/cls", {
        method: "POST",
        headers: tc.headers,
      });
      const rejected = requireSameOriginCsrf(req, canonicalEnv);
      expect(rejected, tc.name).toBeDefined();
      expect(rejected?.status, tc.name).toBe(403);
      const body: unknown = await rejected?.json();
      assertMegaFailureEnvelope(body);
      expect(body.error.code, tc.name).toBe(CSRF_ORIGIN_REJECTED_CODE);
    }
  });
});
