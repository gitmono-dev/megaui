import { describe, expect, it } from "vitest";
import { EmailTemplateRenderError } from "../render";
import { generateResetPasswordEmail } from "./reset-password";

const baseParams = {
  name: "Bob",
  resetUrl: "https://app.example.com/reset?token=xyz789",
  expiryHours: 2,
  appName: "Mega",
};

describe("generateResetPasswordEmail (PK-07 AC 2 — bilingual render)", () => {
  it("renders English copy by default", () => {
    const { subject, html } = generateResetPasswordEmail({ ...baseParams, locale: "en" });
    expect(subject).toBe("Reset your Mega password");
    expect(html).toContain("Reset your password");
    expect(html).toContain("Hello Bob,");
    expect(html).toContain("The link stays valid for 2 hours.");
    expect(html).toContain(baseParams.resetUrl);
    expect(html).toContain(">Reset Password<");
  });

  it("renders zh-CN copy", () => {
    const { subject, html } = generateResetPasswordEmail({ ...baseParams, locale: "zh-CN" });
    expect(subject).toBe("重置您的 Mega 密码");
    expect(html).toContain("重置您的密码");
    expect(html).toContain("您好 Bob，");
    expect(html).toContain("链接 2 小时内有效。");
    expect(html).toContain(baseParams.resetUrl);
  });

  it("fail-closes with an explicit render error when a required variable is missing (GC-11 / AC 3)", () => {
    const incomplete = { ...baseParams, name: undefined } as unknown as typeof baseParams;
    expect(() => generateResetPasswordEmail(incomplete)).toThrow(EmailTemplateRenderError);
  });
});
