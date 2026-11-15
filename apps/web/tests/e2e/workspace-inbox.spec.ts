import { expect, test, type Page } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";
import { e2eBaseURL } from "./helpers/base-url";

type StubNotification = {
  id: string;
  kind: string;
  entityType: string;
  entityId: string;
  url: string;
  summary: string;
  createdAt: string;
  readAt?: string;
};

const NOTIF_ISSUE: StubNotification = {
  id: "notif_1",
  kind: "issue",
  entityType: "issue",
  entityId: "7",
  url: "/issues/7",
  summary: "Ada commented on Wire WA-11 issues",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const NOTIF_READ: StubNotification = {
  ...NOTIF_ISSUE,
  id: "notif_2",
  summary: "Already read",
  readAt: "2026-01-01T01:00:00.000Z",
};

const NOTIF_CL: StubNotification = {
  id: "notif_cl",
  kind: "cl",
  entityType: "cl",
  entityId: "3",
  url: "/cls/3",
  summary: "Review requested on CL #3",
  createdAt: "2026-01-01T00:30:00.000Z",
};

async function stubRailExtras(page: Page): Promise<void> {
  await page.route("**/api/mega/channels**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
  await page.route("**/api/mega/cls**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: null }) });
      return;
    }
    // Shell rail expects a bare CL[] (workspace-shell-client), not a page envelope.
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    });
  });
}

async function stubInbox(page: Page, seed: StubNotification[] = [{ ...NOTIF_ISSUE }, { ...NOTIF_READ }]): Promise<{ getUnread: () => number }> {
  await stubRailExtras(page);
  let items: StubNotification[] = seed.map((item) => ({ ...item }));
  let unread = items.filter((item) => !item.readAt).length;

  await page.route("**/api/mega/notifications**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const path = new URL(url).pathname.replace(/^\/api\/mega\/?/, "");

    if (path === "notifications/unread-count" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { count: unread } }),
      });
      return;
    }

    if (path === "notifications" && method === "GET") {
      const filterParam = new URL(url).searchParams.get("filter");
      const filter = filterParam ? (JSON.parse(filterParam) as { unreadOnly?: boolean }) : {};
      const data = filter.unreadOnly ? items.filter((item) => !item.readAt) : items;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { items: data, total: data.length, offset: 0, limit: 50 } }),
      });
      return;
    }

    if (path === "notifications/mark-all-read" && method === "POST") {
      items = items.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() }));
      unread = 0;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { markedCount: 1 } }),
      });
      return;
    }

    if (path.endsWith("/read") && method === "POST") {
      const id = path.split("/")[1]!;
      items = items.map((item) => (item.id === id ? { ...item, readAt: new Date().toISOString() } : item));
      unread = items.filter((item) => !item.readAt).length;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { ok: true } }),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: null }) });
  });

  await page.route("**/api/mega/issues/**/comments", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
      return;
    }
    const body = route.request().postDataJSON() as { body: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: "ic_new",
          issueNumber: 7,
          author: { id: "u1", username: "ada", displayName: "Ada", avatarInitials: "A" },
          body: body.body,
          createdAt: new Date().toISOString(),
          reactions: [],
        },
      }),
    });
  });

  await page.route("**/api/mega/cls/**/comments", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
      return;
    }
    const body = route.request().postDataJSON() as { body: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: "cc_new",
          clNumber: 3,
          author: { id: "u1", username: "ada", displayName: "Ada", avatarInitials: "A" },
          body: body.body,
          createdAt: new Date().toISOString(),
          reactions: [],
        },
      }),
    });
  });

  return { getUnread: () => unread };
}

async function stubTags(page: Page): Promise<void> {
  await stubRailExtras(page);
  await page.route("**/api/mega/notifications/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { count: 0 } }),
    });
  });

  const author = { id: "u1", username: "ada", displayName: "Ada", avatarInitials: "A" };
  let releases: Array<{
    id: string;
    tag: string;
    title: string;
    state: "draft" | "published";
    targetSha: string;
    author: typeof author;
    commitsSince: number;
    notes: [];
    assets: [];
  }> = [
    {
      id: "rel_1",
      tag: "v0.1.0",
      title: "First",
      state: "draft",
      targetSha: "abc1234",
      author,
      commitsSince: 3,
      notes: [],
      assets: [],
    },
  ];

  await page.route("**/api/mega/releases**", async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/mega\/?/, "");

    if (path === "releases" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { items: releases, total: releases.length, offset: 0, limit: 50 } }),
      });
      return;
    }

    if (path === "releases" && method === "POST") {
      const body = route.request().postDataJSON() as { tag: string; title: string };
      const created = {
        id: "rel_new",
        tag: body.tag,
        title: body.title,
        state: "draft" as const,
        targetSha: "0000000",
        author,
        commitsSince: 0,
        notes: [] as [],
        assets: [] as [],
      };
      releases = [created, ...releases];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: created }),
      });
      return;
    }

    if (path.endsWith("/publish") && method === "POST") {
      const id = path.split("/")[1]!;
      const current = releases.find((item) => item.id === id);
      if (!current) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "MEGA_NOT_FOUND", messageKey: "errors.mega.notFound", message: "missing" },
          }),
        });
        return;
      }
      if (current.state === "published") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "MEGA_CONFLICT", messageKey: "errors.mega.conflict", message: "already published" },
          }),
        });
        return;
      }
      releases = releases.map((item) => (item.id === id ? { ...item, state: "published" as const } : item));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: releases.find((item) => item.id === id) }),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: null }) });
  });
}

test.describe("workspace inbox + tags (WA-16)", () => {
  test("filter unread, mark all read, badge count", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubInbox(page);

    await page.goto("/en/workspace/inbox");
    await expect(page.locator('[data-mega-inbox="unread-count"]')).toContainText("1");
    await expect(page.locator('[data-mega-shell="rail-count"]')).toHaveCount(1);
    await expect(page.locator('[data-mega-shell="rail-count"]').first()).toContainText("1");
    await page.locator('[data-mega-inbox="filter-unread"]').click();
    await expect(page.locator('[data-mega-inbox="row"]')).toHaveCount(1);
    await page.locator('[data-mega-inbox="mark-all-read"]').click();
    await expect(page.locator('[data-mega-inbox="unread-count"]')).toContainText("0", { timeout: 10_000 });
    // Shell hides zero badges (formatRailCount); linkage = badge gone when unread hits 0.
    await expect(page.locator('[data-mega-shell="rail-count"]')).toHaveCount(0, { timeout: 10_000 });

    await context.close();
  });

  test("quick reply posts issue comment", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubInbox(page);

    await page.goto("/en/workspace/inbox");
    await page.locator('[data-mega-inbox="row"]').first().click();
    await page.locator('[data-mega-inbox="quick-reply-input"]').fill("Thanks, tracking.");
    await page.locator('[data-mega-inbox="quick-reply-send"]').click();
    await expect(page.locator('[data-mega-inbox="toast"]')).toContainText("Reply posted");

    await context.close();
  });

  test("quick reply posts CL comment", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    const posted: { body: string | null } = { body: null };
    await stubInbox(page, [{ ...NOTIF_CL }]);
    await page.route("**/api/mega/cls/**/comments", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
        return;
      }
      const payload = route.request().postDataJSON() as { body: string };
      posted.body = payload.body;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "cc_new",
            clNumber: 3,
            author: { id: "u1", username: "ada", displayName: "Ada", avatarInitials: "A" },
            body: payload.body,
            createdAt: new Date().toISOString(),
            reactions: [],
          },
        }),
      });
    });

    await page.goto("/en/workspace/inbox");
    await page.locator('[data-mega-inbox="row"]').first().click();
    await page.locator('[data-mega-inbox="quick-reply-input"]').fill("LGTM after CI.");
    await page.locator('[data-mega-inbox="quick-reply-send"]').click();
    await expect(page.locator('[data-mega-inbox="toast"]')).toContainText("Reply posted");
    expect(posted.body).toBe("LGTM after CI.");

    await context.close();
  });

  test("publish draft then conflict on second publish", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubTags(page);

    await page.goto("/en/workspace/tags");
    await expect(page.locator('[data-mega-tags="card"]')).toHaveCount(1);
    await page.locator('[data-mega-tags="publish"]').click();
    await expect(page.locator('[data-mega-tags="toast"]')).toHaveAttribute("data-mega-toast", "success");
    await page.locator('[data-mega-tags="publish"]').click();
    await expect(page.locator('[data-mega-tags="toast"]')).toHaveAttribute("data-mega-toast", "error");
    await expect(page.locator('[data-mega-tags="toast"]')).toContainText("already published");

    await context.close();
  });
});
