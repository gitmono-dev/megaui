import { describe, expect, it } from "vitest";
import { generateProductNotificationEmail, PRODUCT_EVENT_TYPES } from "./templates/product-notifications";
import { generateResetPasswordEmail } from "./templates/reset-password";
import { generateVerificationEmail } from "./templates/verification";

const BRAND_PATTERN = new RegExp(`tinyship|${["mono", "ui"].join("")}`, "i");

const PRODUCT_PAYLOADS: Record<string, Record<string, string>> = {
  "cl.comment.created": { actorUsername: "reviewer1", clLink: "CL-42", commentExcerpt: "Looks good." },
  "cl.merged": { actorUsername: "reviewer1", clLink: "CL-42", clTitle: "Fix bug" },
  "issue.comment.created": {
    actorUsername: "reviewer1",
    issueLink: "ISSUE-7",
    issueTitle: "Bug",
    commentExcerpt: "Repro'd.",
  },
  "issue.closed": { actorUsername: "reviewer1", issueLink: "ISSUE-7", issueTitle: "Bug" },
  "item.referenced": { actorUsername: "reviewer1", referencedLink: "DOC-1", sourceLink: "DOC-2" },
};

describe("brand residue guard on rendered email output (PK-07 AC 2)", () => {
  it.each(["en", "zh-CN"] as const)("%s verification email has zero brand-word hits", (locale) => {
    const { subject, html } = generateVerificationEmail({
      name: "Alice",
      verificationUrl: "https://app.example.com/verify?token=abc",
      expiryHours: 24,
      appName: "Mega",
      locale,
    });
    expect(BRAND_PATTERN.test(subject)).toBe(false);
    expect(BRAND_PATTERN.test(html)).toBe(false);
  });

  it.each(["en", "zh-CN"] as const)("%s reset password email has zero brand-word hits", (locale) => {
    const { subject, html } = generateResetPasswordEmail({
      name: "Bob",
      resetUrl: "https://app.example.com/reset?token=xyz",
      expiryHours: 2,
      appName: "Mega",
      locale,
    });
    expect(BRAND_PATTERN.test(subject)).toBe(false);
    expect(BRAND_PATTERN.test(html)).toBe(false);
  });

  it.each(["en", "zh-CN"] as const)("%s product notification emails have zero brand-word hits (all event types)", (locale) => {
    for (const eventType of PRODUCT_EVENT_TYPES) {
      const result = generateProductNotificationEmail({
        eventType,
        recipientUsername: "octocat",
        ctaUrl: "https://app.example.com/x",
        appName: "Mega",
        payload: PRODUCT_PAYLOADS[eventType]!,
        locale,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(BRAND_PATTERN.test(result.template.subject)).toBe(false);
      expect(BRAND_PATTERN.test(result.template.html)).toBe(false);
    }
  });
});
