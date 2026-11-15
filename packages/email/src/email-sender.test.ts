import { describe, expect, it } from "vitest";
import { createEmailSender } from "./email-sender";
import { createTestEmailProvider } from "./providers/test";

describe("EmailSender (PK-07 — explicit config, no brand default)", () => {
  it("fail-closes at construction when defaultFrom is missing (GC-07 / ADR brand strip)", () => {
    expect(() => createEmailSender({ defaultFrom: "", provider: { kind: "test" } })).toThrow(/defaultFrom/i);
  });

  it("uses the configured defaultFrom when no explicit from is passed", async () => {
    const testProvider = createTestEmailProvider();
    const sender = createEmailSender({
      defaultFrom: "hello@deploy.example.com",
      provider: { kind: "test", provider: testProvider },
    });

    await sender.sendEmail({ to: "user@example.com", subject: "Hi", html: "<p>Hi</p>" });

    expect(testProvider.getLast()?.from).toBe("hello@deploy.example.com");
  });

  it("prefers an explicit from over the configured default", async () => {
    const testProvider = createTestEmailProvider();
    const sender = createEmailSender({
      defaultFrom: "hello@deploy.example.com",
      provider: { kind: "test", provider: testProvider },
    });

    await sender.sendEmail({
      to: "user@example.com",
      from: "override@deploy.example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
    });

    expect(testProvider.getLast()?.from).toBe("override@deploy.example.com");
  });

  it("sendVerificationEmail renders and sends through the configured provider", async () => {
    const testProvider = createTestEmailProvider();
    const sender = createEmailSender({
      defaultFrom: "hello@deploy.example.com",
      provider: { kind: "test", provider: testProvider },
    });

    const response = await sender.sendVerificationEmail("user@example.com", {
      name: "Alice",
      verificationUrl: "https://app.example.com/verify?token=abc",
      expiryHours: 24,
      appName: "Mega",
      locale: "en",
    });

    expect(response.success).toBe(true);
    const last = testProvider.getLast();
    expect(last?.to).toBe("user@example.com");
    expect(last?.subject).toBe("Verify your Mega account");
    expect(last?.html).toContain("Hello Alice,");
  });

  it("sendResetPasswordEmail renders and sends through the configured provider", async () => {
    const testProvider = createTestEmailProvider();
    const sender = createEmailSender({
      defaultFrom: "hello@deploy.example.com",
      provider: { kind: "test", provider: testProvider },
    });

    await sender.sendResetPasswordEmail("user@example.com", {
      name: "Bob",
      resetUrl: "https://app.example.com/reset?token=xyz",
      expiryHours: 2,
      appName: "Mega",
      locale: "zh-CN",
    });

    const last = testProvider.getLast();
    expect(last?.subject).toBe("重置您的 Mega 密码");
  });

  it("sendProductNotificationEmail sends on valid payload and reports success", async () => {
    const testProvider = createTestEmailProvider();
    const sender = createEmailSender({
      defaultFrom: "hello@deploy.example.com",
      provider: { kind: "test", provider: testProvider },
    });

    const result = await sender.sendProductNotificationEmail("user@example.com", {
      eventType: "issue.closed",
      recipientUsername: "octocat",
      ctaUrl: "https://app.example.com/issue/7",
      appName: "Mega",
      payload: { actorUsername: "reviewer1", issueLink: "ISSUE-7", issueTitle: "Bug" },
      locale: "en",
    });

    expect(result.ok).toBe(true);
    expect(testProvider.getAll()).toHaveLength(1);
  });

  it("sendProductNotificationEmail short-circuits without sending on invalid payload", async () => {
    const testProvider = createTestEmailProvider();
    const sender = createEmailSender({
      defaultFrom: "hello@deploy.example.com",
      provider: { kind: "test", provider: testProvider },
    });

    const result = await sender.sendProductNotificationEmail("user@example.com", {
      eventType: "issue.closed",
      recipientUsername: "octocat",
      ctaUrl: "https://app.example.com/issue/7",
      appName: "Mega",
      payload: { actorUsername: "reviewer1" },
      locale: "en",
    });

    expect(result).toEqual({ ok: false, code: "invalid_payload", message: "payload.issueLink is required" });
    expect(testProvider.getAll()).toHaveLength(0);
  });
});
