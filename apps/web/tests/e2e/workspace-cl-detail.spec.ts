import { expect, test } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";
import { e2eBaseURL } from "./helpers/base-url";

const SAMPLE_CL = {
  id: "cl_1",
  number: 42,
  title: "Wire WA-09 conversation",
  description: "Exercise list + detail.",
  state: "ready",
  packageId: "pkg_engine",
  author: {
    id: "user_author",
    displayName: "Ada",
    email: "ada@example.com",
    avatarInitials: "A",
  },
  reviewers: [
    {
      user: {
        id: "user_reviewer",
        displayName: "Bob",
        email: "bob@example.com",
        avatarInitials: "B",
      },
      verdict: "approved",
      reviewedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  additions: 3,
  deletions: 1,
  files: [
    {
      path: "packages/engine/src/index.ts",
      additions: 3,
      deletions: 1,
      status: "modified",
      patch: "@@ -1,3 +1,5 @@\n+export const x = 1;\n",
    },
  ],
  revisions: [],
  ci: "passing",
  merge: "queue-ready",
  atomic: false,
  crossPackage: [],
  linkedIssues: [],
  branch: "feat/wa-09",
  subscribed: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};


function lexicalPlain(text: string): string {
  return JSON.stringify({
    root: {
      children: [
        {
          children: [{ detail: 0, format: 0, mode: "normal", style: "", text, type: "text", version: 1 }],
          direction: "ltr",
          format: "",
          indent: 0,
          type: "paragraph",
          version: 1,
        },
      ],
      direction: "ltr",
      format: "",
      indent: 0,
      type: "root",
      version: 1,
    },
  });
}

async function stubRail(page: import("@playwright/test").Page): Promise<void> {
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

async function stubClsApis(
  page: import("@playwright/test").Page,
  options?: { emptyList?: boolean; failList?: boolean; failCommits?: boolean },
): Promise<void> {
  await stubRail(page);
  await page.route("**/api/mega/cls**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (options?.failList && /\/api\/mega\/cls(\?|$)/.test(url) && method === "GET") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "MEGA_INTERNAL_ERROR", messageKey: "errors.mega.internal", message: "boom" },
        }),
      });
      return;
    }

    if (/\/api\/mega\/cls(\?|$)/.test(url) && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: options?.emptyList ? [] : [SAMPLE_CL] }),
      });
      return;
    }

    if (url.includes("/commits")) {
      if (options?.failCommits) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "MEGA_INTERNAL_ERROR", messageKey: "errors.mega.internal", message: "down" },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              sha: "abcdef0123456789",
              message: "feat: wa-09",
              authorName: "Ada",
              authorEmail: "ada@example.com",
            },
          ],
        }),
      });
      return;
    }

    if (url.includes("/comments") && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: "c1",
              body: lexicalPlain("Looks good"),
              createdAt: "2026-01-02T00:00:00.000Z",
              author: SAMPLE_CL.author,
            },
          ],
        }),
      });
      return;
    }

    if (url.includes("/inline-comments")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: "i1",
              clNumber: 42,
              filePath: "packages/engine/src/index.ts",
              line: 1,
              side: "additions",
              body: lexicalPlain("nit: name"),
              createdAt: "2026-01-02T00:00:00.000Z",
              author: SAMPLE_CL.author,
              replies: [],
            },
          ],
        }),
      });
      return;
    }

    if (/\/api\/mega\/cls\/42(\/|\?|$)/.test(url) && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: SAMPLE_CL }),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "MEGA_NOT_FOUND", messageKey: "errors.mega.notFound", message: "missing" },
      }),
    });
  });
}

test.describe("WA-09 workspace CL list/detail", () => {
  test("list renders rows", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubClsApis(page);
    await page.goto("/en/workspace/cls");
    await expect(page.locator('[data-mega-cls="page"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="row"]').first()).toContainText("!42");
    await context.close();
  });

  test("list empty state", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubClsApis(page, { emptyList: true });
    await page.goto("/en/workspace/cls");
    await expect(page.locator('[data-mega-cls="empty"]')).toBeVisible();
    await context.close();
  });

  test("list error shows retry", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubClsApis(page, { failList: true });
    await page.goto("/en/workspace/cls");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator('[data-mega-cls="retry"]')).toBeVisible();
    await context.close();
  });

  test("detail shows diff, comments, inline, merge box, commits", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubClsApis(page);
    await page.goto("/en/workspace/cls/42");
    await expect(page.locator('[data-mega-cls="detail"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="detail-title"]')).toContainText("!42");
    await expect(page.locator('[data-mega-cls="diff-patch"]')).toContainText("export const x");
    await expect(page.locator('[data-mega-cls="comment"]').first()).toContainText("Looks good");
    await expect(page.locator('[data-mega-cls="inline-thread"]').first()).toContainText("nit: name");
    await expect(page.locator('[data-mega-cls="merge-box"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="commit"]').first()).toContainText("feat: wa-09");
    await context.close();
  });

  test("commits error shows retry", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubClsApis(page, { failCommits: true });
    await page.goto("/en/workspace/cls/42");
    await expect(page.locator('[data-mega-cls="commits"] [role="alert"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="commits-retry"]')).toBeVisible();
    await context.close();
  });

  test("zh-CN CL list bilingual", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubClsApis(page);
    await page.goto("/zh-CN/workspace/cls");
    await expect(page.locator('[data-mega-cls="page"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="title"]')).toBeVisible();
    await context.close();
  });

  test("list pagination controls appear for large result sets", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubRail(page);
    const many = Array.from({ length: 25 }, (_, index) => ({
      ...SAMPLE_CL,
      id: `cl_${index + 1}`,
      number: index + 1,
      title: `CL ${index + 1}`,
    }));
    await page.route("**/api/mega/cls**", async (route) => {
      const url = route.request().url();
      if (/\/api\/mega\/cls(\?|$)/.test(url) && route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: many }),
        });
        return;
      }
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "MEGA_NOT_FOUND", messageKey: "errors.mega.notFound", message: "missing" },
        }),
      });
    });
    await page.goto("/en/workspace/cls");
    await expect(page.locator('[data-mega-cls="pagination"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="page-next"]')).toBeEnabled();
    await page.locator('[data-mega-cls="page-next"]').click();
    await expect(page.locator('[data-mega-cls="page-status"]')).toContainText(/2/);
    await context.close();
  });

  test("non-author does not see merge action", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubClsApis(page);
    await page.goto("/en/workspace/cls/42");
    await expect(page.locator('[data-mega-cls="merge-box"]')).toBeVisible();
    // SAMPLE_CL.author.id is user_author; minted session is a different user → actions hidden.
    await expect(page.locator('[data-mega-cls="merge-action"]')).toHaveCount(0);
    await context.close();
  });

  test("inline comment form posts via BFF stub", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    let posted = false;
    await stubClsApis(page);
    await page.route("**/api/mega/cls/42/inline-comments", async (route) => {
      if (route.request().method() === "POST") {
        posted = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              id: "i2",
              clNumber: 42,
              filePath: "packages/engine/src/index.ts",
              line: 2,
              body: "new nit",
              createdAt: "2026-01-03T00:00:00.000Z",
              author: SAMPLE_CL.author,
              replies: [],
            },
          }),
        });
        return;
      }
      await route.fallback();
    });
    await page.goto("/en/workspace/cls/42");
    await page.locator('[data-mega-cls="inline-line"]').fill("2");
    await page.locator('[data-mega-cls="inline-body"]').fill("new nit");
    await page.locator('[data-mega-cls="inline-submit"]').click();
    await expect.poll(() => posted).toBe(true);
    await context.close();
  });

  test("unknown CL shows not-found", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubRail(page);
    await page.route("**/api/mega/cls/999**", async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "MEGA_NOT_FOUND", messageKey: "errors.mega.notFound", message: "missing" },
        }),
      });
    });
    await page.goto("/en/workspace/cls/999");
    await expect(page.locator('[data-mega-cls="not-found"]')).toBeVisible();
    await context.close();
  });
});
