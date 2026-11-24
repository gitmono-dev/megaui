import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CSRF_ORIGIN_REJECTED_CODE } from "@/lib/adapter/csrf";
import { assertMegaFailureEnvelope, assertMegaSuccessEnvelope } from "@/lib/adapter/envelope";

const mockResolveWebActor = vi.fn();
const mockDispatchMegaRequest = vi.fn();

vi.mock("@/lib/enterprise-session", () => ({
  resolveWebActor: (...args: unknown[]) => mockResolveWebActor(...args),
}));

vi.mock("@/lib/adapter/dispatch", async () => {
  const actual = await vi.importActual<typeof import("@/lib/adapter/dispatch")>(
    "@/lib/adapter/dispatch",
  );
  return {
    ...actual,
    dispatchMegaRequest: (...args: unknown[]) => mockDispatchMegaRequest(...args),
  };
});

import { DELETE, GET, POST, PUT } from "./route";

describe("/api/mega/[...segments] CSRF route guard (CLB-20)", () => {
  const savedEnv = {
    APP_BASE_URL: process.env.APP_BASE_URL,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
  };

  beforeEach(() => {
    process.env.APP_BASE_URL = "https://mega.example.com";
    delete process.env.BETTER_AUTH_URL;
    delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
    mockResolveWebActor.mockReset().mockResolvedValue({ userId: "user-1" });
    mockDispatchMegaRequest.mockReset().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("allows GET without Origin header", async () => {
    const res = await GET(new Request("https://mega.example.com/api/mega/cls"), {
      params: Promise.resolve({ segments: ["cls"] }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    assertMegaSuccessEnvelope(body);
    expect(mockDispatchMegaRequest).toHaveBeenCalledTimes(1);
  });

  it("allows POST, PUT, DELETE with canonical Origin and rejects missing/cross-site/spoofed-Host Origin before dispatch", async () => {
    const methods = [
      { name: "POST", handler: POST },
      { name: "PUT", handler: PUT },
      { name: "DELETE", handler: DELETE },
    ] as const;

    for (const { name, handler } of methods) {
      mockDispatchMegaRequest.mockClear();

      // Same canonical origin passes
      const okRes = await handler(
        new Request("http://internal:3000/api/mega/cls", {
          method: name,
          headers: {
            Origin: "https://mega.example.com",
            "Content-Type": "application/json",
          },
          body: name === "DELETE" ? undefined : JSON.stringify({ title: "t" }),
        }),
        { params: Promise.resolve({ segments: ["cls"] }) },
      );
      expect(okRes.status, `${name} allowed`).toBe(200);
      expect(mockDispatchMegaRequest).toHaveBeenCalledTimes(1);

      // Missing Origin -> 403 before dispatch
      mockDispatchMegaRequest.mockClear();
      const missingRes = await handler(
        new Request("https://mega.example.com/api/mega/cls", {
          method: name,
          headers: { "Content-Type": "application/json" },
          body: name === "DELETE" ? undefined : JSON.stringify({}),
        }),
        { params: Promise.resolve({ segments: ["cls"] }) },
      );
      expect(missingRes.status, `${name} missing Origin`).toBe(403);
      const missingBody: unknown = await missingRes.json();
      assertMegaFailureEnvelope(missingBody);
      expect(missingBody.error.code).toBe(CSRF_ORIGIN_REJECTED_CODE);
      expect(mockDispatchMegaRequest).not.toHaveBeenCalled();

      // Cross-site + spoofed Host -> 403 before dispatch
      const spoofedRes = await handler(
        new Request("https://evil.example/api/mega/cls", {
          method: name,
          headers: {
            Origin: "https://evil.example",
            Host: "evil.example",
            "X-Forwarded-Host": "evil.example",
          },
        }),
        { params: Promise.resolve({ segments: ["cls"] }) },
      );
      expect(spoofedRes.status, `${name} spoofed Host`).toBe(403);
      expect(mockDispatchMegaRequest).not.toHaveBeenCalled();

      // Sec-Fetch-Site: cross-site -> 403 before dispatch
      const secFetchRes = await handler(
        new Request("https://mega.example.com/api/mega/cls", {
          method: name,
          headers: {
            Origin: "https://mega.example.com",
            "Sec-Fetch-Site": "cross-site",
          },
        }),
        { params: Promise.resolve({ segments: ["cls"] }) },
      );
      expect(secFetchRes.status, `${name} Sec-Fetch-Site cross-site`).toBe(403);
      expect(mockDispatchMegaRequest).not.toHaveBeenCalled();
    }
  });
});
