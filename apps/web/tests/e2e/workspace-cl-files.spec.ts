import { expect, test, type Locator } from "@playwright/test";

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
  publicId: "Pc9BkCsY4X7Z",
  number: 1,
  title: "Wire WA-10 attachments",
  description: "Files revisions checks deps.",
  state: "ready",
  packageId: "pkg_engine",
  author: AUTHOR,
  reviewers: [],
  additions: 504,
  deletions: 2,
  files: [
    {
      path: "packages/engine/src/index.ts",
      additions: 1,
      deletions: 1,
      status: "modified",
      patch: "@@ -1 +1 @@\n-export const x = 0;\n+export const x = 1;\n",
      viewed: false,
      commentCount: 0,
      rangePatches: { "1..2": "@@ -1 +1 @@\n-export const ranged = false;\n+export const ranged = true;\n" },
    },
    {
      path: "src/main.rs", status: "modified", additions: 1, deletions: 1,
      patch: 'diff --git a/src/main.rs b/src/main.rs\n--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1 +1 @@\n-fn answer() -> u32 { 0 }\n+fn answer() -> u32 { 42 }\n',
    },
    {
      path: "notes.undetected", status: "added", additions: 1, deletions: 0,
      patch: "@@ -0,0 +1 @@\n+Plain file contents <example>\n",
    },
    { path: "notes/empty.txt", status: "added", additions: 0, deletions: 0, patch: "" },
    { path: "assets/logo.bin", status: "modified", additions: 0, deletions: 0, patch: "Binary files a/assets/logo.bin and b/assets/logo.bin differ\n" },
    {
      path: "src/generated.rs", status: "added", additions: 500, deletions: 0,
      patch: ["@@ -0,0 +1,500 @@", ...Array.from({ length: 500 }, (_, i) => `+pub const V${i}: u32 = ${i};`), ""].join("\n"),
    },
    {
      path: "tools/index.ts", status: "added", additions: 1, deletions: 0,
      patch: "@@ -0,0 +1 @@\n+export const tool = true;\n",
      rangePatches: { "1..2": "@@ -0,0 +1 @@\n+export const rangedTool = true;\n" },
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

const CL_PATH = `/en/workspace/cls/${SAMPLE_CL.publicId}`;
const LEGACY_CODES = { hyphenated: "bQ_yC79Z-1tP", underscored: "Pc9Bk_sY4X7Z" } as const;
const RELATED_PUBLIC_ID = "g2CA8bk5Y0xR";

function patchLine(patch: Locator, kind: "addition" | "deletion") {
  return patch.locator(`[data-code] [data-line][data-line-type="change-${kind}"]`);
}

async function tokenColors(line: Locator) {
  return line.locator("span").evaluateAll(tokens => [
    ...new Set(tokens.filter(token => token.childElementCount === 0 && token.textContent?.trim())
      .map(token => getComputedStyle(token).color)),
  ].sort());
}

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
    relatedCLs: [{ id: "rel_1", relation: "depends-on", number: 7, publicId: RELATED_PUBLIC_ID }],
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
    files?: typeof SAMPLE_CL.files;
    emptyRevisions?: boolean;
    emptyChecks?: boolean;
    failingChecks?: boolean;
    failChecks?: boolean;
    failDeps?: boolean;
    emptyDeps?: boolean;
    largeDeps?: boolean;
  },
): Promise<void> {
  await stubRail(page);
  const cl = {
    ...SAMPLE_CL,
    files: options?.files ?? SAMPLE_CL.files,
    revisions: options?.emptyRevisions ? [] : SAMPLE_CL.revisions,
  };

  await page.route("**/api/mega/cls**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    const numericPath = `/api/mega/cls/${cl.number}`;

    if (pathname === `${numericPath}/checks` && method === "GET") {
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

    if (pathname === `${numericPath}/dependency-graph` && method === "GET") {
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
      const graph = options?.emptyDeps
        ? { nodes: [], edges: [], apiChanges: [], relatedCLs: [], symbolUsage: [], cycles: [] }
        : largeDepGraph(options?.largeDeps ? 55 : 3);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: graph }) });
      return;
    }

    if (pathname === `${numericPath}/commits` && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [{ sha: "abcdef0123456789", message: "feat: wa-10", authorName: "Ada", authorEmail: "ada@example.com" }],
        }),
      });
      return;
    }

    if (pathname === `${numericPath}/viewed` && method === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { ok: true } }),
      });
      return;
    }

    const detailPaths = [numericPath, ...Object.values(LEGACY_CODES).map((ref) => `/api/mega/cls/${ref}`), `/api/mega/cls/${cl.publicId}`];
    if (method === "GET" && detailPaths.includes(pathname)) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: cl }) });
      return;
    }

    if (pathname === "/api/mega/cls" && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [cl] }) });
      return;
    }

    await route.fulfill({
      status: 404,
      json: { error: { code: "MEGA_NOT_FOUND", messageKey: "errors.mega.notFound", message: "missing" } },
    });
  });
}

test.describe("workspace CL attachment pages (WA-10)", () => {
  test.beforeEach(async ({ context }) => {
    const { cookies } = mintSessionCookies();
    await context.addCookies(cookies);
  });

  test("folder toggles preserve the open diff and keyboard file selection changes its highlighting", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.goto(`${CL_PATH}/files`);
    await expect(page.locator('[data-mega-cls="files"]')).toBeVisible();
    const tree = page.getByRole("tree", { name: "Changed files" });
    const packages = tree.getByRole("treeitem", { name: "packages", level: 1 });
    const tsFile = tree.getByRole("treeitem", { name: /^index\.ts\b/, level: 4 });
    await expect(packages).toHaveAttribute("aria-expanded", "true");
    await expect(tree.getByRole("treeitem", { name: "engine", level: 2 })).toHaveAttribute("aria-expanded", "true");
    await expect(tree.getByRole("treeitem", { name: "src", level: 3 })).toHaveAttribute("aria-expanded", "true");
    await expect(tsFile).toHaveAttribute("aria-selected", "true");
    await expect(tsFile).toContainText("+1");
    await expect(tsFile).toContainText("−1");
    const patch = page.locator('[data-mega-cls="diff-patch"]');
    const added = patchLine(patch, "addition");
    const removed = patchLine(patch, "deletion");
    await expect(added).toHaveText("export const x = 1;");
    await expect(removed).toHaveText("export const x = 0;");
    await expect.poll(async () => (await tokenColors(added)).length).toBeGreaterThan(1);
    await packages.click();
    await expect(packages).toHaveAttribute("aria-expanded", "false");
    await expect(tsFile).toHaveCount(0);
    await expect(added).toHaveText("export const x = 1;");
    await packages.click();
    await expect(tsFile).toHaveAttribute("aria-selected", "true");

    const src = tree.getByRole("treeitem", { name: "src", level: 1 });
    await expect(src).toHaveAttribute("aria-expanded", "false");
    await src.click();
    await expect(src).toHaveAttribute("aria-expanded", "true");
    await expect(added).toHaveText("export const x = 1;");
    await tree.press("ArrowRight"); // generated.rs
    await tree.press("ArrowDown"); // main.rs
    await tree.press("Enter");
    await expect(tree.getByRole("treeitem", { name: /^main\.rs\b/ })).toHaveAttribute("aria-selected", "true");
    await expect(added).toHaveText("fn answer() -> u32 { 42 }");
    await expect(removed).toHaveText("fn answer() -> u32 { 0 }");
    await expect.poll(async () => (await tokenColors(added)).length).toBeGreaterThan(1);
    await expect(patch.locator("diffs-container")).toHaveCount(1);
    await expect(page.locator('[data-mega-cls="tabs"] [data-tab="files"][data-mega-cls="tab-active"]')).toBeVisible();
  });

  test("unknown file types keep their text and empty and binary patches are distinguished", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.goto(`${CL_PATH}/files?file=notes.undetected`);
    const patch = page.locator('[data-mega-cls="diff-patch"]');
    await expect(patchLine(patch, "addition")).toHaveText("Plain file contents <example>");
    const tree = page.getByRole("tree", { name: "Changed files" });
    await tree.getByRole("treeitem", { name: "notes", exact: true }).click();
    await tree.getByRole("treeitem", { name: /^empty\.txt\b/ }).click();
    await expect(patch).toHaveText("(empty patch)");
    await tree.getByRole("treeitem", { name: "assets", exact: true }).click();
    await tree.getByRole("treeitem", { name: /^logo\.bin\b/ }).click();
    await expect(patch.getByRole("status")).toHaveText("Binary file · no text diff available");
  });

  test("a large Rust file highlights both ends as its diff scrolls", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.goto(`${CL_PATH}/files?file=src%2Fgenerated.rs`);
    const patch = page.locator('[data-mega-cls="diff-patch"]');
    const lines = patchLine(patch, "addition");
    const first = lines.filter({ hasText: "pub const V0: u32 = 0;" });
    await expect(first).toBeVisible();
    await expect.poll(async () => (await tokenColors(first)).length).toBeGreaterThan(1);
    expect(await lines.count()).toBeLessThan(500);
    await patch.hover();
    await page.mouse.wheel(0, 20000);
    const last = lines.filter({ hasText: "pub const V499: u32 = 499;" });
    await expect(last).toBeInViewport();
    await expect.poll(async () => (await tokenColors(last)).length).toBeGreaterThan(1);
  });

  test("a deep link reveals a file beyond the first screen of a large directory", async ({ page }) => {
    const files = Array.from({ length: 1200 }, (_, i) => ({
      path: `project/src/file-${String(i).padStart(4, "0")}.ts`,
      status: "added",
      additions: 1,
      deletions: 0,
      patch: `@@ -0,0 +1 @@\n+export const value = ${i};\n`,
    }));
    await stubAttachmentApis(page, { files });
    await page.goto(`${CL_PATH}/files?file=project%2Fsrc%2Ffile-1199.ts`);
    const tree = page.getByRole("tree", { name: "Changed files" });
    const target = tree.getByRole("treeitem", { name: /^file-1199\.ts\b/, level: 3, selected: true });
    await expect(target).toBeInViewport();
    expect(await tree.getByRole("treeitem").count()).toBeLessThan(files.length);
    await expect(patchLine(page.locator('[data-mega-cls="diff-patch"]'), "addition")).toHaveText("export const value = 1199;");
  });

  test("files empty state", async ({ page }) => {
    await stubAttachmentApis(page, { files: [] });
    await page.goto(`${CL_PATH}/files`);
    await expect(page.locator('[data-mega-cls="files-empty"]')).toBeVisible();
  });

  test("legacy range link retains its tab, comparison and fragment on refresh", async ({ page }) => {
    await stubAttachmentApis(page);
    const suffix = "/files?range=1..2&file=tools%2Findex.ts#diff";
    await page.goto(`/en/workspace/cls/1${suffix}`);
    await expect(page).toHaveURL(`${CL_PATH}${suffix}`);
    const patch = page.locator('[data-mega-cls="diff-patch"]');
    const tree = page.getByRole("tree", { name: "Changed files" });
    const selected = tree.getByRole("treeitem", { name: /^index\.ts\b/, level: 2, selected: true });
    await expect(tree.getByRole("treeitem", { name: "tools", level: 1 })).toHaveAttribute("aria-expanded", "true");
    await expect(selected).toBeVisible();
    await expect(patchLine(patch, "addition")).toHaveText("export const rangedTool = true;");
    await page.reload();
    await expect(page).toHaveURL(`${CL_PATH}${suffix}`);
    await expect(selected).toBeVisible();
    await expect(patchLine(patch, "addition")).toHaveText("export const rangedTool = true;");

    const revisions = page.locator('[data-mega-cls="tabs"] [data-tab="revisions"]');
    await expect(revisions).toHaveAttribute("href", `${CL_PATH}/revisions`);
    await revisions.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${CL_PATH}/revisions`);
    await expect(revisions).toHaveAttribute("aria-current", "page");
    await expect(page.locator('[data-mega-cls="revision-card"]')).toHaveCount(2);
  });

  for (const [kind, ref] of Object.entries(LEGACY_CODES)) {
    test(`a bookmarked ${kind} code opens the same file range under its current code`, async ({ page }) => {
      await stubAttachmentApis(page);
      const suffix = "/files?range=1..2#diff";
      await page.goto(`/en/workspace/cls/${ref}${suffix}`);
      await expect(page).toHaveURL(`${CL_PATH}${suffix}`);
      await expect(page.locator('[data-mega-cls="detail-title"]')).toContainText(SAMPLE_CL.publicId);
      await expect(patchLine(page.locator('[data-mega-cls="diff-patch"]'), "addition")).toHaveText("export const ranged = true;");
    });
  }

  test("revisions page cards + compare + commits", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.goto(`${CL_PATH}/revisions`);
    await expect(page.locator('[data-mega-cls="revisions"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="revision-card"]')).toHaveCount(2);
    await expect(page.locator('[data-mega-cls="commit-row"]')).toContainText("feat: wa-10");
    await page.locator('[data-mega-cls="compare-from"]').selectOption("1");
    await page.locator('[data-mega-cls="compare-to"]').selectOption("2");
    await expect(page.locator('[data-mega-cls="view-range-diff"]')).toHaveAttribute(
      "href",
      `${CL_PATH}/files?range=1..2`,
    );
  });

  test("revisions empty state", async ({ page }) => {
    await stubAttachmentApis(page, { emptyRevisions: true });
    await page.goto(`${CL_PATH}/revisions`);
    await expect(page.locator('[data-mega-cls="revisions-empty"]')).toBeVisible();
  });

  test("checks passing + empty + failing states", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.goto(`${CL_PATH}/checks`);
    await expect(page.locator('[data-mega-cls="checks-hero"]')).toHaveAttribute("data-status", "passing");
    await expect(page.locator('[data-mega-cls="check-row"]')).toHaveCount(2);

    await stubAttachmentApis(page, { emptyChecks: true });
    await page.goto(`${CL_PATH}/checks`);
    await expect(page.locator('[data-mega-cls="checks-empty"]')).toBeVisible();

    await stubAttachmentApis(page, { failingChecks: true });
    await page.goto(`${CL_PATH}/checks`);
    await expect(page.locator('[data-mega-cls="checks-hero"]')).toHaveAttribute("data-status", "failing");
    await expect(page.locator('[data-mega-cls="checks-failed"]')).toBeVisible();
  });

  test("checks error shows retry", async ({ page }) => {
    await stubAttachmentApis(page, { failChecks: true });
    await page.goto(`${CL_PATH}/checks`);
    await expect(page.locator('[data-mega-cls="checks"] [role="alert"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="checks"] [data-mega-cls="retry"]')).toBeVisible();
  });

  test("deps error shows retry", async ({ page }) => {
    await stubAttachmentApis(page, { failDeps: true });
    await page.goto(`${CL_PATH}/deps`);
    await expect(page.locator('[data-mega-cls="deps"] [role="alert"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="deps"] [data-mega-cls="retry"]')).toBeVisible();
  });

  test("deps empty state", async ({ page }) => {
    await stubAttachmentApis(page, { emptyDeps: true });
    await page.goto(`${CL_PATH}/deps`);
    await expect(page.locator('[data-mega-cls="deps-empty"]')).toBeVisible();
  });

  test("deps graph renders (large 50+ nodes smoke)", async ({ page }) => {
    await stubAttachmentApis(page, { largeDeps: true });
    await page.goto(`${CL_PATH}/deps`);
    await expect(page.locator('[data-mega-cls="deps"]')).toBeVisible();
    await expect(page.locator('[data-mega-cls="dep-graph"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-mega-cls="dep-node"]')).toHaveCount(55, { timeout: 15_000 });
    await expect(page.locator('[data-mega-cls="api-change"]')).toContainText("foo");
    const related = page.locator('[data-mega-cls="related-cl"]');
    await expect(related.getByRole("link", { name: RELATED_PUBLIC_ID })).toHaveAttribute(
      "href", `/en/workspace/cls/${RELATED_PUBLIC_ID}`,
    );
  });

  test("zh-CN file syntax follows the workspace theme at a narrow width", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(`/zh-CN/workspace/cls/${SAMPLE_CL.publicId}/files`);
    await expect(page.locator('[data-mega-cls="tabs"]')).toContainText("文件");
    const added = patchLine(page.locator('[data-mega-cls="diff-patch"]'), "addition");
    const modes = new Map<string, string[]>();
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate(mode => localStorage.setItem("mega-settings", JSON.stringify({ mode, density: "comfortable", accent: "default" })), mode);
      await page.reload();
      await expect.poll(() => page.locator("html").evaluate(node => node.classList.contains("dark"))).toBe(mode === "dark");
      await expect(added).toBeVisible();
      await expect(page.getByRole("tree").getByRole("treeitem", { name: /^index\.ts\b/, selected: true })).toBeInViewport();
      await expect.poll(async () => (await tokenColors(added)).length).toBeGreaterThan(1);
      modes.set(mode, await tokenColors(added));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    }
    expect(modes.get("dark")).not.toEqual(modes.get("light"));
  });
});
