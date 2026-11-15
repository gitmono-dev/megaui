import { describe, expect, it } from "vitest";

import { createEmailSender } from "../email-sender";
import { createTestEmailProvider } from "../providers/test";
import { generateEnterpriseLoginEmail, type EnterpriseLoginNotificationParams } from "./enterprise-login";

const BASE: EnterpriseLoginNotificationParams = {
  recipientName: "Synthetic Alice",
  loginAt: "2026-11-12T23:30:00Z",
  device: "Chromium on macOS",
  source: "203.0.113.*",
  appName: "Mega",
  appUrl: "https://workspace.example.test/en/",
};

describe("enterprise login notification (FS-31)", () => {
  it("renders both localized notification variants", () => {
    const en = generateEnterpriseLoginEmail({ ...BASE, locale: "en" });
    const zh = generateEnterpriseLoginEmail({ ...BASE, locale: "zh-CN" });
    expect(en.subject).toBe("A new enterprise sign-in");
    expect(en.html).toContain("Enterprise sign-in notification");
    expect(zh.subject).toBe("新的企业登录通知");
    expect(zh.html).toContain("企业登录通知");
    expect(en.html).toContain(BASE.loginAt);
    expect(zh.html).toContain(BASE.device);
  });

  it("contains no OTP, session token, or authentication URL", () => {
    const result = generateEnterpriseLoginEmail({ ...BASE, locale: "en" });
    expect(result.html).not.toMatch(/\b(?:otp|one[- ]time|session[_ -]?token|pairing[_ -]?token)\b/i);
    expect(result.html).not.toContain("/login");
    expect(result.html).not.toContain("?token=");
    expect(result.html).toContain("https://workspace.example.test/en/");
  });

  it("rejects token-shaped extra template fields and non-ordinary URLs", () => {
    expect(() => generateEnterpriseLoginEmail({
      ...BASE,
      sessionToken: "secret",
    } as EnterpriseLoginNotificationParams & { sessionToken: string })).toThrow(/FIELD_NOT_ALLOWED/);
    expect(() => generateEnterpriseLoginEmail({
      ...BASE,
      appUrl: "https://workspace.example.test/en/?token=secret",
    })).toThrow(/NOT_ORDINARY/);
  });

  it("rejects compatibility addresses before invoking the provider", async () => {
    const provider = createTestEmailProvider();
    const sender = createEmailSender({
      defaultFrom: "no-reply@workspace.example.test",
      provider: { kind: "test", provider },
    });
    await expect(sender.sendEnterpriseLoginNotificationEmail("u_abc@identity.invalid", BASE))
      .rejects.toThrow(/COMPATIBILITY_ADDRESS_REJECTED/);
    await expect(sender.sendEmail({
      to: "User <u_abc@identity.invalid>", subject: "blocked", html: "<p>blocked</p>",
    })).rejects.toThrow(/COMPATIBILITY_ADDRESS_REJECTED/);
    expect(provider.getAll()).toHaveLength(0);
  });

});
