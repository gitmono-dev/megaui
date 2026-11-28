import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getTranslation } from "@megaui/i18n";
import { HomeCardGrid } from "@/app/[lang]/workspace/components/home-card-grid";
import type { HomeDashboard } from "@/lib/adapter/home";

describe("home change links", () => {
  it("shows linked titles without IDs in recent changes and activity", () => {
    const cards: HomeDashboard["cards"] = {
      reviewRequests: [], recentCls: [{ publicId: "abc123", title: "Import sources" }],
      assignedIssues: [], releases: [], docs: [], channels: [], agentThreads: [], quickLinks: [],
      activity: [{ id: "1", entityRef: "abc123", title: "Import sources", actorName: "Alice", author: { id: "u1", username: "alice", displayName: "Alice", avatarInitials: "A" }, kind: "updated", createdAt: "2026-01-01" }],
    };
    const html = renderToStaticMarkup(<HomeCardGrid cards={cards} labels={getTranslation("zh-CN").workspace.home.cards} workspaceBase="/zh-CN/workspace" />);
    expect(html).toContain('href="/zh-CN/workspace/cls/abc123">Import sources</a>');
    expect(html).toContain('更新了 <a href="/zh-CN/workspace/cls/abc123">Import sources</a>');
  });
});
