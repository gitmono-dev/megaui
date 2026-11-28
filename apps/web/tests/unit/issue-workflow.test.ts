import { describe, expect, it } from "vitest";
import { createIssueSchema } from "@/lib/adapter/handlers/shared";

describe("issue workflow status", () => {
  it.each(["backlog", "todo", "in_progress", "in_review"])("accepts %s", workflowStatus => {
    expect(createIssueSchema.parse({ title: "Issue", workflowStatus }).workflowStatus).toBe(workflowStatus);
  });
  it("rejects an unknown status", () => {
    expect(createIssueSchema.safeParse({ title: "Issue", workflowStatus: "closed" }).success).toBe(false);
  });
});
