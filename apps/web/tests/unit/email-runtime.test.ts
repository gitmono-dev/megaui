import { describe, expect, it } from "vitest";

import { parseAuthMailDefaultFrom, parseAuthMailSelector } from "@/lib/email-runtime";

function expectExactCategory(run: () => unknown, category: "provider_selector" | "default_from", raw?: string) {
  expect(run).toThrowError(`[@megaui/web] auth-mail config invalid: ${category}`);
  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    expect(message).toBe(`[@megaui/web] auth-mail config invalid: ${category}`);
    if (raw) {
      expect(message).not.toContain(raw);
    }
  }
}

describe("parseAuthMailSelector", () => {
  it("returns the corresponding kind for trimmed test, smtp, and resend (new)", () => {
    expect(parseAuthMailSelector("test")).toBe("test");
    expect(parseAuthMailSelector(" smtp ")).toBe("smtp");
    expect(parseAuthMailSelector("resend")).toBe("resend");
  });

  it("throws provider_selector for missing, blank, or unknown values (new)", () => {
    expectExactCategory(() => parseAuthMailSelector(undefined), "provider_selector");
    expectExactCategory(() => parseAuthMailSelector(""), "provider_selector");
    expectExactCategory(() => parseAuthMailSelector("   "), "provider_selector");
    expectExactCategory(() => parseAuthMailSelector("sendgrid"), "provider_selector", "sendgrid");
  });
});

describe("parseAuthMailDefaultFrom", () => {
  it("throws default_from for missing or empty input (new)", () => {
    expectExactCategory(() => parseAuthMailDefaultFrom(undefined), "default_from");
    expectExactCategory(() => parseAuthMailDefaultFrom(""), "default_from");
    expectExactCategory(() => parseAuthMailDefaultFrom("  "), "default_from");
  });

  it("returns the trimmed address and does not substitute noreply@example.com (new)", () => {
    expect(parseAuthMailDefaultFrom("alerts@example.com")).toBe("alerts@example.com");
    expect(parseAuthMailDefaultFrom("  alerts@example.com  ")).toBe("alerts@example.com");
    expect(parseAuthMailDefaultFrom("alerts@example.com")).not.toBe("noreply@example.com");
  });
});
