import { describe, expect, it } from "vitest";
import {
  UnsafeEmailCtaUrlError,
  assertSafeHttpUrl,
  renderEmailShell,
} from "./shell";

describe("renderEmailShell CTA URL safety (GC-07)", () => {
  const base = {
    appName: "Mega",
    title: "Title",
    greeting: "Hello",
    message: "Body",
    ctaLabel: "Open",
    alternativeText: "Or copy:",
    secondaryLine: "",
    disclaimer: "Disclaimer",
    signature: "Team",
    copyright: "© 2026",
  };

  it("accepts absolute https URLs and HTML-escapes quotes in attribute context", () => {
    const html = renderEmailShell(
      { ...base, ctaUrl: "https://example.com/path?q=a&b=1" },
      "en",
    );
    expect(html).toContain('href="https://example.com/path?q=a&amp;b=1"');
  });

  it("rejects javascript: and relative URLs", () => {
    expect(() => assertSafeHttpUrl("javascript:alert(1)")).toThrow(
      UnsafeEmailCtaUrlError,
    );
    expect(() =>
      renderEmailShell({ ...base, ctaUrl: "/relative" }, "en"),
    ).toThrow(UnsafeEmailCtaUrlError);
  });
});
