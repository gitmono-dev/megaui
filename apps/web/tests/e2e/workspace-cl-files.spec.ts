import { expect, test } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";

const AUTHOR = {
  id: "user_author",
  displayName: "Ada",
  email: "ada@example.com",
  avatarInitials: "A",
};

const SAMPLE_REVISIONS = [
  {
    id: "rev_1",
    number: 1,
    sha: "aaa1111",
    label: "r1",
    createdAt: "2026-01-01T00:00:00.000Z",
    rebased: false,
    forcePushed: false,
    commitList: [],
    reviewerState: [],
    summary: "Initial revision",
    base: "main @ abc",
    ci: "passing",
    additions: 2,
    deletions: 0,
    filesChanged: 1,
  },
  {
    id: "rev_2",
    number: 2,
    sha: "bbb2222",
    label: "r2",
    createdAt: "2026-01-02T00:00:00.000Z",
    rebased: false,
    forcePushed: false,
    commitList: [{ sha: "bbb2222", message: "fix", author: AUTHOR, createdAt: "2026-01-02T00:00:00.000Z", filesChanged: 1, additions: 1, deletions: 0 }],
    reviewerState: [],
    summary: "Follow-up",
    base: "main @ abc",
    ci: "passing",
    additions: 3,
    deletions: 1,
    filesChanged: 1,
  },
];

const SAMPLE_CL = {
  id: "cl_1",
  number: 42,
  title: "Wire WA-10 attachments",
  description: "Files revisions checks deps.",
  state: "ready",
  packageId: "pkg_engine",
  author: AUTHOR,
  reviewers: [],
  additions: 3,
  deletions: 1,
  files: [
    {
      path: "packages/engine/src/index.ts",
      additions: 3,
      deletions: 1,
      status: "modified",
      patch: "@@ -1,3 +1,5 @@\n+export const x = 1;\n",
      viewed: false,
      commentCount: 0,
      rangePatches: { "1..2": "@@ range patch @@\n+export const ranged = true;\n" },
    },
  ],
  revisions: SAMPLE_REVISIONS,
  ci: "passing",
  merge: "queue-ready",
  atomic: false,
  crossPackage: [],
  linkedIssues: [],
  branch: "feat/wa-10",
  subscribed: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const SAMPLE_CHECKS_PASSING = {
  pipeline: [{ id: "stage_build", name: "build", status: "passing" }],
  runner: "github-actions",
  queuedAt: "2026-01-02T00:00:00.000Z",
  checks: [
    { id: "chk_1", name: "typecheck", status: "passing", matrix: "node-22", durationSeconds: 42, passedCount: 12 },
    { id: "chk_2", name: "lint", status: "passing", durationSeconds: 18 },
  ],
  logTail: [],
  benchmarks: [],
};

const SAMPLE_CHECKS_FAILING = {
  ...SAMPLE_CHECKS_PASSING,
  checks: [
    { id: "chk_1", name: "typecheck", status: "failing", durationSeconds: 42 },
    { id: "chk_2", name: "lint", status: "passing", durationSeconds: 18 },
  ],
};

const SAMPLE_CHECKS_EMPTY = {
  pipeline: [],
  runner: "",
  checks: [],
  logTail: [],
  benchmarks: [],
};

function largeDepGraph(nodeCount: number) {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `n${index}`,
    label: `pkg-${index}`,
    kind: index === 0 ? ("this" as const) : index % 3 === 1 ? ("upstream" as const) : ("downstream" as const),
    kloc: `${(index % 9) + 1}.${index % 10}k`,
  }));
  const edges = Array.from({ length: Math.max(0, nodeCount - 1) }, (_, index) => ({
    id: `e${index}`,
    from: `n${index}`,
    to: `n${index + 1}`,
    heat: index % 5 === 0 ? ("high" as const) : ("medium" as const),
  }));
  return {
    nodes,
    edges,
    apiChanges: [{ id: "api_1", kind: "added", text: "export function foo()" }],
    relatedCLs: [{ id: "rel_1", relation: "depends-on", number: 7 }],
    symbolUsage: [{ id: "sym_1", symbol: "foo", refs: 3, files: 2, packages: "engine" }],
    cycles: [],
  };
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

async function stubAttachmentApis(
  page: import("@playwright/test").Page,
  options?: {
    emptyFiles?: boolean;
    emptyRevisions?: boolean;
    emptyChecks?: boolean;
    failingChecks?: boolean;
    failChecks?: boolean;
    failDeps?: boolean;
    largeDeps?: boolean;
  },
): Promise<void> {
  await stubRail(page);
  const cl = {
    ...SAMPLE_CL,
    files: options?.emptyFiles ? [] : SAMPLE_CL.files,
    revisions: options?.emptyRevisions ? [] : SAMPLE_CL.revisions,
  };

  await page.route("**/api/mega/cls**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (url.includes("/checks") && method === "GET") {
      if (options?.failChecks) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "MEGA_INTERNAL_ERROR", messageKey: "errors.mega.internal", message: "boom" },
          }),
        });
        return;
      }
      const body = options?.emptyChecks
        ? SAMPLE_CHECKS_EMPTY
        : options?.failingChecks
          ? SAMPLE_CHECKS_FAILING
          : SAMPLE_CHECKS_PASSING;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: body }) });
      return;
    }

    if (url.includes("/dependency-graph") && method === "GET") {
      if (options?.failDeps) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "MEGA_INTERNAL_ERROR", messageKey: "errors.mega.internal", message: "boom" },
          }),
        });
        return;
      }
      const graph = options?.largeDeps ? largeDepGraph(55) : largeDepGraph(3);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: graph }) });
      return;
    }

    if (url.includes("/commits") && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [{ sha: "abcdef0123456789", message: "feat: wa-10", authorName: "Ada", authorEmail: "ada@example.com" }],
        }),
      });
      return;
    }

    if (url.includes("/viewed") && method === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { ok: true } }),
      });
      return;
    }

    if (/\/api\/mega\/cls\/\d+(\?|$)/.test(url) && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: cl }) });
      return;
    }

    if (/\/api\/mega\/cls(\?|$)/.test(url) && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [cl] }) });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
}

test.describe("workspace CL attachment pages (WA-10)", () => {
  test.beforeEach(async ({ context }) => {
    const { cookies } = mintSessionCookies();
    await context.addCookies(cookies);
  });

  test("files page renders list + patch", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.goto("/en/workspace/cls/42/files");
    await expect(page.locator('[data-mega-cls="files"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="file-row"]')).toHaveCount(1);
    await expect(page.locator('[data-mega-cls="diff-patch"]')).toContainText("export const x = 1");
    await expect(page.locator('[data-mega-cls="tabs"] [data-tab="files"][data-mega-cls="tab-active"]')).toBeVisible();
  });

  test("files empty state", async ({ page }) => {
    await stubAttachmentApis(page, { emptyFiles: true });
    await page.goto("/en/workspace/cls/42/files");
    await expect(page.locator('[data-mega-cls="files-empty"]')).toBeVisible();
  });

  test("files range query uses rangePatches", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.goto("/en/workspace/cls/42/files?range=1..2");
    await expect(page.locator('[data-mega-cls="diff-patch"]')).toContainText("ranged = true");
  });

  test("revisions page cards + compare + commits", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.goto("/en/workspace/cls/42/revisions");
    await expect(page.locator('[data-mega-cls="revisions"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="revision-card"]')).toHaveCount(2);
    await expect(page.locator('[data-mega-cls="commit-row"]')).toContainText("feat: wa-10");
    await page.locator('[data-mega-cls="compare-from"]').selectOption("1");
    await page.locator('[data-mega-cls="compare-to"]').selectOption("2");
    await expect(page.locator('[data-mega-cls="view-range-diff"]')).toHaveAttribute(
      "href",
      /\/en\/workspace\/cls\/42\/files\?range=1\.\.2/,
    );
  });

  test("revisions empty state", async ({ page }) => {
    await stubAttachmentApis(page, { emptyRevisions: true });
    await page.goto("/en/workspace/cls/42/revisions");
    await expect(page.locator('[data-mega-cls="revisions-empty"]')).toBeVisible();
  });

  test("checks passing + empty + failing states", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.goto("/en/workspace/cls/42/checks");
    await expect(page.locator('[data-mega-cls="checks-hero"]')).toHaveAttribute("data-status", "passing");
    await expect(page.locator('[data-mega-cls="check-row"]')).toHaveCount(2);

    await stubAttachmentApis(page, { emptyChecks: true });
    await page.goto("/en/workspace/cls/42/checks");
    await expect(page.locator('[data-mega-cls="checks-empty"]')).toBeVisible();

    await stubAttachmentApis(page, { failingChecks: true });
    await page.goto("/en/workspace/cls/42/checks");
    await expect(page.locator('[data-mega-cls="checks-hero"]')).toHaveAttribute("data-status", "failing");
    await expect(page.locator('[data-mega-cls="checks-failed"]')).toBeVisible();
  });

  test("checks error shows retry", async ({ page }) => {
    await stubAttachmentApis(page, { failChecks: true });
    await page.goto("/en/workspace/cls/42/checks");
    await expect(page.locator('[data-mega-cls="checks"] [role="alert"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="checks"] [data-mega-cls="retry"]')).toBeVisible();
  });

  test("deps error shows retry", async ({ page }) => {
    await stubAttachmentApis(page, { failDeps: true });
    await page.goto("/en/workspace/cls/42/deps");
    await expect(page.locator('[data-mega-cls="deps"] [role="alert"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="deps"] [data-mega-cls="retry"]')).toBeVisible();
  });

  test("deps empty state", async ({ page }) => {
    await stubRail(page);
    await page.route("**/api/mega/cls**", async (route) => {
      const url = route.request().url();
      const method = route.request().method();
      if (url.includes("/dependency-graph") && method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: { nodes: [], edges: [], apiChanges: [], relatedCLs: [], symbolUsage: [], cycles: [] },
          }),
        });
        return;
      }
      if (/\/api\/mega\/cls\/\d+(\?|$)/.test(url) && method === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: SAMPLE_CL }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
    });
    await page.goto("/en/workspace/cls/42/deps");
    await expect(page.locator('[data-mega-cls="deps-empty"]')).toBeVisible();
  });

  test("deps graph renders (large 50+ nodes smoke)", async ({ page }) => {
    await stubAttachmentApis(page, { largeDeps: true });
    await page.goto("/en/workspace/cls/42/deps");
    await expect(page.locator('[data-mega-cls="deps"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="dep-graph"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-mega-cls="dep-node"]')).toHaveCount(55, { timeout: 15_000 });
    await expect(page.locator('[data-mega-cls="api-change"]')).toContainText("foo");
    await expect(page.locator('[data-mega-cls="related-cl"]')).toContainText("!7");
  });

  test("zh-CN attachment chrome tabs", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.goto("/zh-CN/workspace/cls/42/files");
    await expect(page.locator('[data-mega-cls="tabs"]')).toContainText("文件");
    await expect(page.locator('[data-mega-cls="files"]')).toBeVisible();
  });
});
