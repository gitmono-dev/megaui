import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IssueTimeline } from "@/app/[lang]/workspace/issues/[n]/components/issue-timeline";

describe("issue comments", () => {
  it("renders Markdown and skips raw HTML", () => {
    const html = renderToStaticMarkup(<IssueTimeline
      addReactionLabel="React" authorRoleLabel="Author" canReact={false}
      comments={[{ id: "comment1", issueNumber: 1, author: { id: "user1", displayName: "User", avatarInitials: "U", username: "user" }, body: "**Bold**\n\n- one\n- two\n\n<script>alert(1)</script>", createdAt: "2026-01-01", reactions: [] }]}
      errorLabel="Error" isError={false} isPending={false} issueAuthorId="user1"
      loadingLabel="Loading" retryLabel="Retry" onCommentReaction={() => {}} onRetry={() => {}}
    />);
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain("<li>one</li>");
    expect(html).not.toContain("<script>");
  });
});
