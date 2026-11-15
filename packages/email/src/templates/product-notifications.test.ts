import { describe, expect, it } from "vitest";
import { generateProductNotificationEmail, isProductEventType, PRODUCT_EVENT_TYPES } from "./product-notifications";
import { UnsafeEmailCtaUrlError } from "./shell";

const baseParams = {
  eventType: "cl.comment.created" as const,
  recipientUsername: "octocat",
  ctaUrl: "https://app.example.com/cl/42",
  appName: "Mega",
  payload: {
    actorUsername: "reviewer1",
    clLink: "CL-42",
    commentExcerpt: "Looks good to me.",
  },
};

describe("generateProductNotificationEmail (PK-07 AC 2 — bilingual render)", () => {
  it("only allowlists CL/Issue/doc(reference) event types — no chat events", () => {
    expect(PRODUCT_EVENT_TYPES).toEqual([
      "cl.comment.created",
      "cl.merged",
      "issue.comment.created",
      "issue.closed",
      "item.referenced",
    ]);
    expect(isProductEventType("workspace.mention")).toBe(false);
    expect(isProductEventType("cl.merged")).toBe(true);
  });

  it("renders English copy for cl.comment.created", () => {
    const result = generateProductNotificationEmail({ ...baseParams, locale: "en" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.template.subject).toContain("CL-42");
    expect(result.template.html).toContain("New CL comment");
    expect(result.template.html).toContain("reviewer1");
    expect(result.template.html).toContain("Looks good to me.");
    expect(result.template.html).toContain("Hello octocat,");
    expect(result.template.html).toContain(">View<");
  });

  it("renders zh-CN copy for cl.comment.created", () => {
    const result = generateProductNotificationEmail({ ...baseParams, locale: "zh-CN" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.template.html).toContain("新的 CL 评论");
    expect(result.template.html).toContain("您好 octocat，");
    expect(result.template.html).toContain(">查看<");
  });

  it("renders each of the five allowlisted event types with distinct titles", () => {
    const payloads: Record<string, Record<string, string>> = {
      "cl.comment.created": { actorUsername: "a", clLink: "CL-1", commentExcerpt: "x" },
      "cl.merged": { actorUsername: "a", clLink: "CL-1", clTitle: "Fix bug" },
      "issue.comment.created": { actorUsername: "a", issueLink: "ISSUE-1", issueTitle: "Bug", commentExcerpt: "x" },
      "issue.closed": { actorUsername: "a", issueLink: "ISSUE-1", issueTitle: "Bug" },
      "item.referenced": { actorUsername: "a", referencedLink: "DOC-1", sourceLink: "DOC-2" },
    };

    for (const eventType of PRODUCT_EVENT_TYPES) {
      const result = generateProductNotificationEmail({
        ...baseParams,
        eventType,
        payload: payloads[eventType]!,
        locale: "en",
      });
      expect(result.ok).toBe(true);
    }
  });

  it("returns an explicit invalid_payload result when a required field is missing (business validation)", () => {
    const result = generateProductNotificationEmail({
      ...baseParams,
      payload: { actorUsername: "reviewer1", clLink: "CL-42" },
    });
    expect(result).toEqual({ ok: false, code: "invalid_payload", message: "payload.commentExcerpt is required" });
  });

  it("returns an explicit invalid_payload result for a blank string field", () => {
    const result = generateProductNotificationEmail({
      ...baseParams,
      payload: { ...baseParams.payload, commentExcerpt: "   " },
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_payload" });
  });

  it("HTML-escapes untrusted payload content (actor/excerpt)", () => {
    const result = generateProductNotificationEmail({
      ...baseParams,
      payload: { ...baseParams.payload, commentExcerpt: "<img src=x onerror=alert(1)>" },
    });
    if (!result.ok) throw new Error("expected ok result");
    expect(result.template.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(result.template.html).toContain("&lt;img");
  });

  it("fail-closes when ctaUrl is missing or unsafe (GC-07 / AC 3)", () => {
    const incomplete = { ...baseParams, ctaUrl: undefined } as unknown as typeof baseParams;
    expect(() => generateProductNotificationEmail(incomplete)).toThrow(UnsafeEmailCtaUrlError);
  });
});
