import { describe, expect, it } from "vitest";
import { EmailTemplateRenderError } from "../render";
import { UnsafeEmailCtaUrlError } from "./shell";
import { generateVerificationEmail } from "./verification";

const baseParams = {
  name: "Alice",
  verificationUrl: "https://app.example.com/verify?token=abc123",
  expiryHours: 24,
  appName: "Mega",
};

describe("generateVerificationEmail (PK-07 AC 2 — bilingual render)", () => {
  it("renders English copy by default", () => {
    const { subject, html } = generateVerificationEmail({ ...baseParams, locale: "en" });
    expect(subject).toBe("Verify your Mega account");
    expect(html).toContain("Confirm your email address");
    expect(html).toContain("Hello Alice,");
    expect(html).toContain("The link stays valid for 24 hours.");
    expect(html).toContain(baseParams.verificationUrl);
    expect(html).toContain(">Verify Email Address<");
  });

  it("renders zh-CN copy", () => {
    const { subject, html } = generateVerificationEmail({ ...baseParams, locale: "zh-CN" });
    expect(subject).toBe("验证您的 Mega 账号");
    expect(html).toContain("请验证您的邮箱地址");
    expect(html).toContain("您好 Alice，");
    expect(html).toContain("链接 24 小时内有效。");
    expect(html).toContain(baseParams.verificationUrl);
  });

  it("falls back to the default locale for an unknown locale code", () => {
    const en = generateVerificationEmail({ ...baseParams, locale: "en" });
    const unknown = generateVerificationEmail({ ...baseParams, locale: "fr" });
    expect(unknown.subject).toBe(en.subject);
  });

  it("HTML-escapes the interpolated name", () => {
    const { html } = generateVerificationEmail({ ...baseParams, name: '<script>alert(1)</script>' });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("fail-closes when verificationUrl is missing or unsafe (GC-07 / AC 3)", () => {
    const incomplete = { ...baseParams, verificationUrl: undefined } as unknown as typeof baseParams;
    expect(() => generateVerificationEmail(incomplete)).toThrow(UnsafeEmailCtaUrlError);
    expect(() =>
      generateVerificationEmail({ ...baseParams, verificationUrl: "javascript:alert(1)" }),
    ).toThrow(UnsafeEmailCtaUrlError);
  });

  it("fail-closes with EmailTemplateRenderError when name is missing (GC-11 / AC 3)", () => {
    const incomplete = { ...baseParams, name: undefined } as unknown as typeof baseParams;
    expect(() => generateVerificationEmail(incomplete)).toThrow(EmailTemplateRenderError);
  });
});
