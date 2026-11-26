import { expect, test } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";
import { e2eBaseURL } from "./helpers/base-url";

const SAMPLE_CL = {
  id: "cl_1",
  publicId: "aB195pXA7ZrQ",
  number: 1,
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
  options?: { emptyList?: boolean; failList?: boolean; failCommits?: boolean; row?: typeof SAMPLE_CL },
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
        body: JSON.stringify({ data: options?.emptyList ? [] : [options?.row ?? SAMPLE_CL] }),
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
              clNumber: SAMPLE_CL.number,
              filePath: "packages/engine/src/index.ts",
              line: 1,
              side: "additions",
              body: lexicalPlain("nit: name"),
              createdAt: "2026-01-03T00:00:00.000Z",
              author: SAMPLE_CL.author,
              replies: [],
            },
          ],
        }),
      });
      return;
    }

    const detailPath = new URL(url).pathname;
    if (method === "GET" && [SAMPLE_CL.number, SAMPLE_CL.publicId].some(id => detailPath === `/api/mega/cls/${id}`)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: options?.row ?? SAMPLE_CL }),
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
    const row = page.locator('[data-mega-cls="row"]').first();
    await expect(row).toContainText(SAMPLE_CL.publicId);
    await expect(row).not.toContainText("!1");
    await expect(row.locator('[data-mega-cls="row-ci"]')).toHaveAttribute("data-ci", "passing");
    const title = row.getByRole("link", { name: /Wire WA-09 conversation/ });
    await expect(title).toHaveAttribute("href", `/en/workspace/cls/${SAMPLE_CL.publicId}`);
    await title.focus();
    await title.press("Enter");
    await expect(page).toHaveURL(`/en/workspace/cls/${SAMPLE_CL.publicId}`);
    await expect(page.getByRole("heading", { name: new RegExp(SAMPLE_CL.title) })).toBeVisible();
    await expect(page.locator('[data-mega-cls="detail"]')).toContainText(SAMPLE_CL.publicId);
    await context.close();
  });

  test("list preserves search text when filtering by state and sorting", async ({ page, context }) => {
    await context.addCookies(mintSessionCookies().cookies);
    await stubClsApis(page);
    await page.goto("/en/workspace/cls");
    const filter = page.locator('[data-mega-cls="filter"]');
    await filter.fill("Libra");
    await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("Libra");
    await expect(filter).toBeFocused();

    const open = page.locator('[data-scope="open"]');
    const openRequest = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === "/api/mega/cls" && url.searchParams.get("filter")?.includes('"ready"') === true;
    });
    await open.click();
    const query = new URL((await openRequest).url()).searchParams.get("filter")!;
    expect(JSON.parse(query)).toMatchObject({ text: "Libra", states: ["ready", "wip", "queued", "conflicts"] });
    await expect(open).toHaveAttribute("aria-pressed", "true");
    await expect(filter).toHaveValue(/is:open/);

    await page.locator('[data-mega-cls="sort"]').selectOption("created-asc");
    for (const scope of ["merged", "closed"]) {
      const button = page.locator(`[data-scope="${scope}"]`);
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => new URL(page.url()).searchParams.get("q")?.split(/\s+/).sort()).toEqual(
        ["Libra", `is:${scope}`, "sort:created-asc"].sort(),
      );
    }
    await page.reload();
    await expect(page.locator('[data-scope="closed"]')).toHaveAttribute("aria-pressed", "true");
    await page.locator('[data-scope="all"]').click();
    await expect.poll(() => new URL(page.url()).searchParams.get("q")?.split(/\s+/).sort()).toEqual(
      ["Libra", "sort:created-asc"].sort(),
    );
  });

  test("narrow list wraps long metadata without placeholder diff totals", async ({ page, context }) => {
    await context.addCookies(mintSessionCookies().cookies);
    await page.setViewportSize({ width: 320, height: 720 });
    await stubClsApis(page, {
      row: {
        ...SAMPLE_CL,
        title: "Import Libra source " + "abcdef".repeat(14),
        author: { ...SAMPLE_CL.author, displayName: "fs_" + "0123456789".repeat(10) },
        additions: 0,
        deletions: 0,
        files: [],
      },
    });
    await page.goto("/zh-CN/workspace/cls");
    const row = page.locator('[data-mega-cls="row"]');
    await expect(row.getByRole("link", { name: /Import Libra source/ })).toBeVisible();
    await expect(row).not.toContainText("+0");
    await expect(row).not.toContainText("−0");
    const surface = page.locator('[data-mega-shell="workspace-content"]');
    await expect.poll(() => surface.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  });

  test("long title and metadata fit the narrow Chinese detail view", async ({ page, context }) => {
    await context.addCookies(mintSessionCookies().cookies);
    await page.setViewportSize({ width: 320, height: 720 });
    const row = {
      ...SAMPLE_CL,
      title: "feat(project): import Libra source (1/24) " + "abcdef".repeat(16),
      branch: "feat/" + "longbranch".repeat(10),
      author: { ...SAMPLE_CL.author, displayName: "fs_" + "0123456789".repeat(10) },
    };
    await stubClsApis(page, { row });
    await page.goto(`/zh-CN/workspace/cls/${row.publicId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(row.title);
    await expect(page.locator('[data-mega-cls="merge-box"]')).toBeVisible();
    const detail = page.locator('[data-mega-cls="detail"]');
    await expect(detail).toContainText(row.branch);
    const surface = page.locator('[data-mega-shell="workspace-content"]');
    await expect.poll(() => surface.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
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
    await page.goto(`/en/workspace/cls/${SAMPLE_CL.publicId}`);
    await expect(page.locator('[data-mega-cls="detail"]')).toBeVisible();
    await expect(page).toHaveURL(`/en/workspace/cls/${SAMPLE_CL.publicId}`);
    await expect(page.getByRole("heading", { name: new RegExp(SAMPLE_CL.title) })).toBeVisible();
    await expect(page.locator('[data-mega-cls="detail"]')).toContainText(SAMPLE_CL.publicId);
    const patch = page.locator('[data-mega-cls="diff-patch"]');
    await expect(patch).toHaveCount(0);
    await page.locator('[data-mega-cls="diff"] > summary').press("Enter");
    await expect(patch).toContainText("export const x");
    await expect(page.locator('[data-mega-cls="comment"]').first()).toContainText("Looks good");
    await expect(page.locator('[data-mega-cls="inline-thread"]').first()).toContainText("nit: name");
    const discussionRows = page.locator('[data-mega-cls="comment"], [data-mega-cls="inline-thread"]');
    await expect(discussionRows.first()).toContainText("Looks good");
    await page.locator('[data-mega-cls="discussion-sort"]').selectOption("newest");
    await expect(discussionRows.first()).toContainText("nit: name");
    await page.locator('[data-filter="unresolved"]').click();
    await expect(discussionRows).toHaveCount(1);
    await expect(discussionRows.first()).toContainText("nit: name");
    await page.locator('[data-filter="all"]').click();
    await expect(discussionRows).toHaveCount(2);
    await expect(page.locator('[data-mega-cls="merge-box"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="commit"]').first()).toContainText("feat: wa-09");
    await context.close();
  });

  test("legacy conversation URL opens the canonical overview with its merge requirements", async ({ page, context }) => {
    await context.addCookies(mintSessionCookies().cookies);
    const liveRow = {
      ...SAMPLE_CL,
      author: { ...SAMPLE_CL.author, id: "mega2:actor" },
      merge: "needs-review",
      ci: "queued",
      mergeBox: {
        merge_requirements: {
          state: "UNMERGEABLE",
          conditions: [
            { type: "CiStatus", display_name: "CI Build", description: "", message: "Build queued", result: "PENDING" },
          ],
        },
      },
    };
    const detailRequests: URL[] = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (request.method() === "GET" && [`/api/mega/cls/${SAMPLE_CL.number}`, `/api/mega/cls/${SAMPLE_CL.publicId}`].includes(url.pathname)) {
        detailRequests.push(url);
      }
    });
    await stubClsApis(page, { row: liveRow });
    await page.goto("/en/workspace/cls/1");
    await expect(page).toHaveURL(`/en/workspace/cls/${SAMPLE_CL.publicId}`);
    const summary = page.locator('[data-mega-cls="merge-box"]');
    const condition = summary.getByText("Build queued", { exact: true });
    await expect(condition).toBeHidden();
    await summary.locator("details > summary").press("Enter");
    await expect(condition).toBeVisible();
    await expect(summary.locator('[data-result="PENDING"]')).toBeVisible();
    await expect(summary.locator('[data-mega-cls="merge-action"]')).toHaveCount(0);
    expect(detailRequests.map(url => url.searchParams.get("view"))).toContain("overview");
    expect(detailRequests.every(url => url.searchParams.get("view") === "overview")).toBe(true);

    const filesRequest = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === `/api/mega/cls/${SAMPLE_CL.publicId}` && !url.searchParams.has("view");
    });
    await page.locator('[data-mega-cls="tabs"] [data-tab="files"]').press("Enter");
    await filesRequest;
    await expect(page.locator('[data-mega-cls="diff-patch"]')).toContainText("export const x");
  });

  test("old comment bookmark reveals a resolved reply beyond the first five entries", async ({ page, context }) => {
    await context.addCookies(mintSessionCookies().cookies);
    await stubClsApis(page);
    const opened = "2026-01-02T00:00:00.000Z";
    await page.route(`**/api/mega/cls/${SAMPLE_CL.number}/comments`, route => route.fulfill({
      json: { data: Array.from({ length: 5 }, (_, index) => ({
        id: `earlier-${index}`, author: SAMPLE_CL.author, createdAt: opened, body: lexicalPlain("Earlier discussion"),
      })) },
    }));
    await page.route(`**/api/mega/cls/${SAMPLE_CL.number}/inline-comments`, route => route.fulfill({
      json: { data: [{
        id: "line-thread", author: SAMPLE_CL.author, createdAt: "2026-01-03T00:00:00.000Z", body: lexicalPlain("Check line"),
        filePath: SAMPLE_CL.files[0].path, line: 2, resolvedAt: "2026-01-04T00:00:00.000Z",
        replies: [{ id: "late-reply", author: SAMPLE_CL.author, createdAt: "2026-01-03T12:00:00.000Z", body: lexicalPlain("Resolved here") }],
      }] },
    }));
    await page.goto(`/en/workspace/cls/${SAMPLE_CL.number}#comment-late-reply`);
    await expect(page).toHaveURL(`/en/workspace/cls/${SAMPLE_CL.publicId}#comment-late-reply`);
    const reply = page.getByText("Resolved here", { exact: true });
    await expect(reply).toBeInViewport();
    const unresolved = page.locator('[data-filter="unresolved"]');
    await unresolved.click();
    await expect(unresolved).toHaveAttribute("aria-pressed", "true");
    await expect(reply).toHaveCount(0);
  });

  test("commits error shows retry", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubClsApis(page, { failCommits: true });
    await page.goto(`/en/workspace/cls/${SAMPLE_CL.publicId}`);
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
      publicId: `testCLx${String(index + 1).padStart(5, "0")}`,
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
    await page.goto(`/en/workspace/cls/${SAMPLE_CL.publicId}`);
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
    await page.route(`**/api/mega/cls/${SAMPLE_CL.number}/inline-comments`, async (route) => {
      if (route.request().method() === "POST") {
        posted = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              id: "i2",
              clNumber: SAMPLE_CL.number,
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
    await page.goto(`/en/workspace/cls/${SAMPLE_CL.publicId}`);
    await page.locator('[data-mega-cls="inline-composer"] > summary').press("Enter");
    await page.locator('[data-mega-cls="inline-line"]').fill("2");
    await page.locator('[data-mega-cls="inline-body"]').fill("new nit");
    await page.locator('[data-mega-cls="inline-submit"]').click();
    await expect.poll(() => posted).toBe(true);
    await context.close();
  });

  for (const missing of ["999", "missingXCL01"]) {
    test(`unknown CL ${missing} shows not-found`, async ({ page, context }) => {
      await context.addCookies(mintSessionCookies().cookies);
      await stubClsApis(page);
      const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/mega/cls/${missing}`);
      await page.goto(`/en/workspace/cls/${missing}`);
      expect((await response).status()).toBe(404);
      await expect(page.locator('[data-mega-cls="not-found"]')).toBeVisible();
      await expect(page.locator('[data-mega-cls="merge-box"]')).toHaveCount(0);
    });
  }
});
