// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@megaui/core";
import { IssueBodyPanel } from "@/app/[lang]/workspace/issues/[n]/components/issue-body-panel";

const issue: Issue = {
  id: "issue1", number: 1, title: "Example", body: "**Body**", state: "open", priority: "P2",
  labels: [], linkedCLs: [], reactions: [], author: { id: "u", username: "u", displayName: "User", avatarInitials: "U" },
  assignees: [], packageId: "", commentCount: 0, watcherIds: [], createdAt: "2026-01-01", updatedAt: "2026-01-01",
};
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("issue body card", () => {
  it("uses the comment thread layout and preserves the edit action", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const node = document.createElement("div"); document.body.append(node);
    const root = createRoot(node); const edit = vi.fn();
    await act(async () => { root.render(<IssueBodyPanel issue={issue} title="Description" addReactionLabel="React"
      authorRoleLabel="Author" autoSaveHint="Autosave" bodyDraft="" bodySaveState="idle" canEdit canReact
      editingBody={false} editLabel="Edit" emptyLabel="Empty" finishEditingLabel="Done" placeholder="Body"
      savePending={false} savedLabel="Saved" saveFailedLabel="Failed" savingLabel="Saving"
      onBodyChange={() => {}} onEditToggle={edit} onReaction={() => {}} />); });
    expect(node.querySelector('[data-slot="comment-thread"]')).not.toBeNull();
    expect(node.querySelector('[data-mega-issues="body-text"] strong')?.textContent).toBe("Body");
    expect(node.textContent).toContain("User");
    expect(node.textContent).toContain("Author");
    await act(async () => { node.querySelector<HTMLButtonElement>('[data-mega-issues="body-edit"]')!.click(); });
    expect(edit).toHaveBeenCalledOnce();
    expect(node.querySelector('[data-mega-issues="issue-reactions"] [data-slot="reactions-bar"]')).not.toBeNull();
    await act(async () => root.unmount());
  });
});
