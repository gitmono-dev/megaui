import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";

const AUTHOR = {
  id: "user_author",
  displayName: "Ada",
  email: "ada@example.com",
  avatarInitials: "A",
};

const SAMPLE_ISSUE = {
  id: "issue_1",
  number: 7,
  title: "Wire WA-11 issues",
  body: "Reproduce with stub BFF.",
  state: "open",
  priority: "P1",
  labels: [],
  linkedCLs: [42],
  linkedClPublicIds: ["clA42TtestID"],
  reactions: [{ emoji: "👍", count: 2, reactedByMe: false }],
  author: AUTHOR,
  assignees: [],
  packageId: "pkg_engine",
  commentCount: 1,
  watcherIds: ["user_other"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const SAMPLE_COMMENT = {
  id: "ic_1",
  issueNumber: 7,
  author: AUTHOR,
  body: "Looks reproducible.",
  createdAt: "2026-01-01T12:00:00.000Z",
  reactions: [{ emoji: "🎉", count: 1, reactedByMe: true }],
};

type WireReaction = { emoji: string; count: number; reactedByMe: boolean };

const FORBIDDEN_BODY = JSON.stringify({
  error: { code: "MEGA_FORBIDDEN", messageKey: "errors.mega.forbidden", message: "forbidden" },
});

function toggleWireReactions(reactions: WireReaction[], emoji: string): WireReaction[] {
  const existing = reactions.find((reaction) => reaction.emoji === emoji);
  const next = existing
    ? reactions.map((reaction) =>
        reaction.emoji === emoji
          ? {
              ...reaction,
              count: reaction.reactedByMe ? reaction.count - 1 : reaction.count + 1,
              reactedByMe: !reaction.reactedByMe,
            }
          : reaction,
      )
    : [...reactions, { emoji, count: 1, reactedByMe: true }];
  return next.filter((reaction) => reaction.count > 0);
}

async function resolveSessionUserId(context: BrowserContext): Promise<string> {
  const response = await context.request.get("/api/auth/get-session");
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as { user?: { id?: string } };
  const userId = payload.user?.id;
  expect(userId).toBeTruthy();
  return userId!;
}

async function stubRail(page: Page): Promise<void> {
  await page.route("**/api/mega/channels**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
  await page.route("**/api/mega/notifications/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { count: 0 } }),
    });
  });
}

async function stubIssuesApis(
  page: Page,
  options?: {
    emptyList?: boolean;
    failList?: boolean;
    failClose?: boolean;
    failReaction?: boolean;
    failBodySave?: boolean;
    closed?: boolean;
    sessionUserId?: string;
    authorId?: string;
    assigneeIds?: string[];
  },
): Promise<{ getWatchers: () => string[] }> {
  await stubRail(page);
  let issue = {
    ...SAMPLE_ISSUE,
    state: options?.closed ? "closed" : "open",
    watcherIds: [...SAMPLE_ISSUE.watcherIds],
    reactions: [...SAMPLE_ISSUE.reactions],
    author: options?.authorId ? { ...AUTHOR, id: options.authorId } : SAMPLE_ISSUE.author,
    assignees: (options?.assigneeIds ?? []).map((id, index) => ({
      id,
      displayName: `Assignee ${index + 1}`,
      email: `assignee${index + 1}@example.com`,
      avatarInitials: "S",
    })),
  };
  let comment = { ...SAMPLE_COMMENT, reactions: [...SAMPLE_COMMENT.reactions] };
  const sessionUserId = options?.sessionUserId ?? "e2e-session-user";

  await page.route("**/api/mega/issue-comments**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes("/reactions") && method === "POST") {
      if (options?.failReaction) {
        await route.fulfill({ status: 403, contentType: "application/json", body: FORBIDDEN_BODY });
        return;
      }
      const commentId = new URL(url).pathname.split("/").at(-2);
      if (commentId !== comment.id) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "MEGA_NOT_FOUND", messageKey: "errors.mega.notFound", message: "missing" },
          }),
        });
        return;
      }
      const payload = route.request().postDataJSON() as { emoji: string };
      comment = { ...comment, reactions: toggleWireReactions(comment.reactions, payload.emoji) };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: comment }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });

  await page.route("**/api/mega/issues**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (options?.failList && /\/api\/mega\/issues(\?|$)/.test(url) && method === "GET") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "MEGA_INTERNAL_ERROR", messageKey: "errors.mega.internal", message: "boom" },
        }),
      });
      return;
    }

    if (/\/api\/mega\/issues(\?|$)/.test(url) && method === "GET") {
      const items = options?.emptyList ? [] : [issue];
      const search = new URL(url).searchParams;
      const offset = Number(search.get("offset") ?? 0);
      const limit = Number(search.get("limit") ?? 20);
      const pageItems = items.slice(offset, offset + limit);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { items: pageItems, total: items.length, offset, limit } }),
      });
      return;
    }

    if (url.includes("/reactions") && method === "POST") {
      if (options?.failReaction) {
        await route.fulfill({ status: 403, contentType: "application/json", body: FORBIDDEN_BODY });
        return;
      }
      const payload = route.request().postDataJSON() as { emoji: string };
      issue = { ...issue, reactions: toggleWireReactions(issue.reactions, payload.emoji) };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: issue }) });
      return;
    }

    if (url.includes("/comments") && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [comment] }),
      });
      return;
    }

    if (url.includes("/comments") && method === "POST") {
      const body = route.request().postDataJSON() as { body: string };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            ...SAMPLE_COMMENT,
            id: "ic_new",
            body: body.body,
          },
        }),
      });
      return;
    }

    if (url.includes("/close") && method === "POST") {
      if (options?.failClose) {
        await route.fulfill({ status: 403, contentType: "application/json", body: FORBIDDEN_BODY });
        return;
      }
      issue = { ...issue, state: "closed" };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: issue }) });
      return;
    }

    if (url.includes("/reopen") && method === "POST") {
      issue = { ...issue, state: "open" };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: issue }) });
      return;
    }

    if (url.includes("/body") && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { body: issue.body ?? "" } }),
      });
      return;
    }

    if (url.includes("/body") && method === "POST") {
      if (options?.failBodySave) {
        await route.fulfill({ status: 403, contentType: "application/json", body: FORBIDDEN_BODY });
        return;
      }
      const payload = route.request().postDataJSON() as { body: string };
      issue = { ...issue, body: payload.body };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { body: payload.body } }),
      });
      return;
    }

    if (url.includes("/watch") && method === "POST") {
      const watching = issue.watcherIds.includes(sessionUserId);
      issue = {
        ...issue,
        watcherIds: watching
          ? issue.watcherIds.filter((id) => id !== sessionUserId)
          : [...issue.watcherIds, sessionUserId],
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: issue }) });
      return;
    }

    if (/\/api\/mega\/issues\/\d+(\?|$)/.test(url) && method === "GET") {
      if (url.includes("/999")) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "MEGA_NOT_FOUND", messageKey: "errors.mega.notFound", message: "missing" },
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: issue }) });
      return;
    }

    if (/\/api\/mega\/issues(\?|$)/.test(url) && method === "POST") {
      const body = route.request().postDataJSON() as { title: string };
      const created = { ...SAMPLE_ISSUE, id: "issue_new", number: 99, title: body.title };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: created }) });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });

  return {
    getWatchers: () => issue.watcherIds,
  };
}

test.describe("workspace issues (WA-11)", () => {
  test.beforeEach(async ({ context }) => {
    const { cookies } = mintSessionCookies();
    await context.addCookies(cookies);
  });

  test("full-width issue composer previews and submits only title and body", async ({ page }) => {
    await stubIssuesApis(page);
    await page.goto("/zh-CN/workspace/issues");
    await page.locator('[data-mega-issues="new"]').click();
    await expect(page).toHaveURL(/\/issues\/new$/);
    const form = page.locator('[data-mega-issues="create"]');
    await expect(form.getByRole("heading")).toHaveText("新建议题");
    await expect(form.locator("input, textarea, select")).toHaveCount(2);
    const widths = await form.evaluate(el => [el.clientWidth, el.parentElement!.clientWidth]);
    expect(widths[0]).toBe(widths[1]);
    const submit = form.getByRole("button", { name: "创建议题" });
    await expect(submit).toBeDisabled();
    await form.getByLabel("标题", { exact: true }).fill("Review new issue");
    await form.getByRole("textbox", { name: "描述（可选）", exact: true }).fill("First line\nSecond line");
    await form.getByRole("button", { name: "预览" }).click();
    await expect(form.getByText("First line Second line")).toBeVisible();
    await form.getByRole("button", { name: "编辑" }).click();
    await expect(form.locator("textarea")).toHaveValue("First line\nSecond line");
    const sent = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/mega/issues");
    await submit.click();
    expect((await sent).postDataJSON()).toEqual({ title: "Review new issue", body: "First line\nSecond line" });
    await expect(page).toHaveURL(/\/issues\/99$/);
  });

  test("legacy create link opens the page and cancel restores the filter on mobile", async ({ page }) => {
    await stubIssuesApis(page);
    await page.setViewportSize({ width: 390, height: 840 });
    await page.goto("/en/workspace/issues?new=1&q=is%3Aclosed");
    await expect(page).toHaveURL(/\/issues\/new\?q=is%3Aclosed$/);
    await expect(page.getByRole("heading", { name: "New issue" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/issues\?q=is%3Aclosed$/);
    await expect(page.locator('[data-mega-issues="filter"]')).toHaveValue("is:closed");
  });

  test("list rows render with open tab", async ({ page }) => {
    await stubIssuesApis(page);
    await page.goto("/en/workspace/issues?q=is:open");
    await expect(page.locator('[data-mega-issues="page"]')).toBeVisible();
    await expect(page.locator('[data-mega-issues="row"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="issue-card"]')).toContainText("Wire WA-11 issues");
  });

  test("list empty state", async ({ page }) => {
    await stubIssuesApis(page, { emptyList: true });
    await page.goto("/en/workspace/issues?q=is:open");
    await expect(page.locator('[data-mega-issues="empty"]')).toBeVisible();
  });

  test("list error shows retry", async ({ page }) => {
    await stubIssuesApis(page, { failList: true });
    await page.goto("/en/workspace/issues");
    await expect(page.locator('[data-mega-issues="page"] [role="alert"]')).toBeVisible();
    await expect(page.locator('[data-mega-issues="retry"]')).toBeVisible();
  });

  test("list closed tab switches filter", async ({ page }) => {
    await stubIssuesApis(page);
    await page.goto("/en/workspace/issues?q=is:open");
    await page.locator('[data-mega-issues="tab"][data-tab="closed"]').click();
    await expect(page).toHaveURL(/q=.*is(%3A|:)closed/);
    await expect(page.locator('[data-mega-issues="tab-active"][data-tab="closed"]')).toBeVisible();
  });

  test("list pagination reaches beyond first page", async ({ page }) => {
    await stubRail(page);
    const many = Array.from({ length: 25 }, (_, index) => ({
      ...SAMPLE_ISSUE,
      id: `issue_${index + 1}`,
      number: index + 1,
      title: `Issue ${index + 1}`,
    }));
    await page.route("**/api/mega/issues**", async (route) => {
      const url = route.request().url();
      if (!/\/api\/mega\/issues(\?|$)/.test(url) || route.request().method() !== "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
        return;
      }
      const search = new URL(url).searchParams;
      const offset = Number(search.get("offset") ?? 0);
      const limit = Number(search.get("limit") ?? 20);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { items: many.slice(offset, offset + limit), total: many.length, offset, limit },
        }),
      });
    });

    await page.goto("/en/workspace/issues?q=is:open");
    await expect(page.locator('[data-mega-issues="row"]')).toHaveCount(20);
    await expect(page.locator('[data-mega-issues="pagination"]')).toBeVisible();
    await page.locator('[data-mega-issues="page-next"]').click();
    await expect(page.locator('[data-mega-issues="row"]')).toHaveCount(5);
    await expect(page.locator('[data-mega-issues="row"]').first()).toContainText("Issue 21");
  });

  test("list sort control updates query and order", async ({ page }) => {
    await stubRail(page);
    const issues = [
      { ...SAMPLE_ISSUE, id: "issue_a", number: 1, title: "Alpha low", priority: "P3", updatedAt: "2026-01-01T00:00:00.000Z" },
      { ...SAMPLE_ISSUE, id: "issue_b", number: 2, title: "Beta high", priority: "P0", updatedAt: "2026-01-03T00:00:00.000Z" },
      { ...SAMPLE_ISSUE, id: "issue_c", number: 3, title: "Gamma mid", priority: "P1", updatedAt: "2026-01-02T00:00:00.000Z" },
    ];
    await page.route("**/api/mega/issues**", async (route) => {
      const url = route.request().url();
      if (!/\/api\/mega\/issues(\?|$)/.test(url) || route.request().method() !== "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
        return;
      }
      const filterParam = new URL(url).searchParams.get("filter");
      const filter = filterParam ? (JSON.parse(filterParam) as { sort?: string }) : {};
      const sorted = [...issues].sort((left, right) => {
        if (filter.sort === "priority-desc") return left.priority.localeCompare(right.priority);
        if (filter.sort === "created-asc") return left.number - right.number;
        return right.updatedAt.localeCompare(left.updatedAt);
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { items: sorted, total: sorted.length, offset: 0, limit: 20 } }),
      });
    });

    await page.goto("/en/workspace/issues?q=is:open");
    await expect(page.locator('[data-mega-issues="row"]').first()).toContainText("Beta high");
    await page.locator('[data-mega-issues="sort"]').selectOption("priority-desc");
    await expect(page).toHaveURL(/sort(%3A|:)priority-desc/);
    await expect(page.locator('[data-mega-issues="row"]').first()).toContainText("Beta high");
    await expect(page.locator('[data-mega-issues="row"]').nth(2)).toContainText("Alpha low");
  });

  test("member can add issue reaction without being author (new)", async ({ page }) => {
    await stubIssuesApis(page);
    await page.goto("/en/workspace/issues/7");
    await expect(page.locator('[data-mega-issues="body-edit"]')).toHaveCount(0);
    const issueBar = page.locator('[data-mega-issues="issue-reactions"]');
    await issueBar.locator('[data-slot="reactions-bar-add"] button').first().click();
    await issueBar.locator('[data-slot="reactions-bar-add"]').getByRole("button", { name: "🚀" }).click();
    await expect(issueBar.locator('[data-slot="reactions-bar"]')).toContainText("🚀");
    await expect(issueBar.getByRole("button", { name: /🚀/ })).toHaveAttribute("aria-pressed", "true");
  });

  test("member can toggle comment reaction (new)", async ({ page }) => {
    await stubIssuesApis(page);
    await page.goto("/en/workspace/issues/7");
    const comment = page.locator('[data-mega-issues="comment"]');
    const commentBar = comment.locator('[data-slot="reactions-bar"]');
    await expect(commentBar).toContainText("🎉");
    await commentBar.getByRole("button", { name: /🎉/ }).click();
    await expect(commentBar).not.toContainText("🎉");
    await comment.locator('[data-slot="reactions-bar-add"] button').first().click();
    await comment.locator('[data-slot="reactions-bar-add"]').getByRole("button", { name: "🚀" }).click();
    await expect(commentBar).toContainText("🚀");
    await expect(commentBar.getByRole("button", { name: /🚀/ })).toHaveAttribute("aria-pressed", "true");
  });

  test("reaction forbidden shows error toast (new)", async ({ page }) => {
    await stubIssuesApis(page, { failReaction: true });
    await page.goto("/en/workspace/issues/7");
    await page.locator('[data-mega-issues="issue-reactions"]').getByRole("button", { name: /👍/ }).click();
    await expect(page.locator('[data-mega-issues="toast"][data-mega-toast="error"]')).toContainText(
      "You do not have permission",
    );
  });

  test("detail timeline comments reactions body", async ({ page }) => {
    await stubIssuesApis(page);
    await page.goto("/en/workspace/issues/7");
    await expect(page.locator('[data-mega-issues="detail-title"]')).toContainText("#7");
    await expect(page.locator('[data-mega-issues="body-text"]')).toContainText("Reproduce with stub BFF");
    await expect(page.locator('[data-mega-issues="issue-reactions"]')).toContainText("👍");
    await expect(page.locator('[data-mega-issues="comment"]')).toContainText("Looks reproducible");
    await expect(page.locator('[data-mega-issues="comment"]')).toContainText("🎉");
    await expect(page.locator('[data-mega-issues="body-edit"]')).toHaveCount(0);
  });

  test("author can edit body via Done (new)", async ({ page, context }) => {
    const authorId = await resolveSessionUserId(context);
    await stubIssuesApis(page, { authorId });
    await page.goto("/en/workspace/issues/7");
    await page.locator('[data-mega-issues="body-edit"]').click();
    await page.locator('[data-mega-issues="body-editor"]').fill("Updated body from author.");
    await page.locator('[data-mega-issues="body-edit"]').click();
    await expect(page.locator('[data-mega-issues="body-text"]')).toContainText("Updated body from author.");
  });

  test("assignee can edit body via Done (new)", async ({ page, context }) => {
    const assigneeId = await resolveSessionUserId(context);
    await stubIssuesApis(page, { assigneeIds: [assigneeId] });
    await page.goto("/en/workspace/issues/7");
    await page.locator('[data-mega-issues="body-edit"]').click();
    await page.locator('[data-mega-issues="body-editor"]').fill("Updated body from assignee.");
    await page.locator('[data-mega-issues="body-edit"]').click();
    await expect(page.locator('[data-mega-issues="body-text"]')).toContainText("Updated body from assignee.");
  });

  test("body save forbidden shows error toast (new)", async ({ page, context }) => {
    const authorId = await resolveSessionUserId(context);
    await stubIssuesApis(page, { authorId, failBodySave: true });
    await page.goto("/en/workspace/issues/7");
    await page.locator('[data-mega-issues="body-edit"]').click();
    await page.locator('[data-mega-issues="body-editor"]').fill("This save must fail.");
    await page.locator('[data-mega-issues="body-edit"]').click();
    await expect(page.locator('[data-mega-issues="toast"][data-mega-toast="error"]')).toContainText(
      "You do not have permission",
    );
    await expect(page.locator('[data-mega-issues="body-editor"]')).toBeVisible();
  });

  test("close success toast and reopen", async ({ page }) => {
    await stubIssuesApis(page);
    await page.goto("/en/workspace/issues/7");
    await page.locator('[data-mega-issues="close"]').click();
    await expect(page.locator('[data-mega-issues="toast"][data-mega-toast="success"]')).toContainText("Issue closed");
    await expect(page.locator('[data-mega-issues="state-pill"]')).toHaveAttribute("data-state", "closed");
    await page.locator('[data-mega-issues="reopen"]').click();
    await expect(page.locator('[data-mega-issues="toast"]')).toContainText("Issue reopened");
    await expect(page.locator('[data-mega-issues="state-pill"]')).toHaveAttribute("data-state", "open");
  });

  test("close forbidden shows error toast", async ({ page }) => {
    await stubIssuesApis(page, { failClose: true });
    await page.goto("/en/workspace/issues/7");
    await page.locator('[data-mega-issues="close"]').click();
    await expect(page.locator('[data-mega-issues="toast"][data-mega-toast="error"]')).toContainText(
      "You do not have permission",
    );
  });

  test("watch toggle persists watcherIds", async ({ page }) => {
    await stubIssuesApis(page, { sessionUserId: "stub-watcher" });
    await page.goto("/en/workspace/issues/7");
    await expect(page.locator('[data-mega-issues="watchers"]')).toContainText("watchers: 1");
    await page.locator('[data-mega-issues="watch"]').click();
    await expect(page.locator('[data-mega-issues="toast"][data-mega-toast="success"]')).toBeVisible();
    await expect(page.locator('[data-mega-issues="watchers"]')).toContainText("watchers: 2");
    await page.locator('[data-mega-issues="watch"]').click();
    await expect(page.locator('[data-mega-issues="watchers"]')).toContainText("watchers: 1");
  });

  test("unknown issue shows not-found", async ({ page }) => {
    await stubIssuesApis(page);
    await page.goto("/en/workspace/issues/999");
    await expect(page.locator('[data-mega-issues="not-found"]')).toBeVisible();
  });

  test("zh-CN issues list bilingual", async ({ page }) => {
    await stubIssuesApis(page);
    await page.goto("/zh-CN/workspace/issues?q=is:open");
    await expect(page.locator('[data-mega-issues="page"]')).toBeVisible();
    await expect(page.locator('[data-mega-issues="filter"]')).toHaveAttribute("placeholder", /is:open/);
    await expect(page.getByLabel("过滤议题")).toBeVisible();
  });
});
