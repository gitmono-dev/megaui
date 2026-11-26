import { expect, test, type Locator, type Page } from "@playwright/test";

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
      path: "src/main.rs", oldPath: "src/legacy_main.rs", status: "modified", additions: 1, deletions: 1,
      patch: "diff --git a/src/legacy_main.rs b/src/main.rs\nsimilarity index 67%\nrename from src/legacy_main.rs\nrename to src/main.rs\n--- a/src/legacy_main.rs\n+++ b/src/main.rs\n@@ -1 +1 @@\n-fn answer() -> u32 { 0 }\n+fn answer() -> u32 { 42 }\n",
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
const INDEX_FILE = "packages/engine/src/index.ts";

function fileCard(page: Page, path: string) {
  return page.locator(`[data-mega-cls="file-card"][data-path="${path}"]`);
}

function filePatch(page: Page, path: string) {
  return fileCard(page, path).locator('[data-mega-cls="diff-patch"]');
}

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
    failViewedOnce?: boolean;
    mega2?: boolean;
    emptyDeps?: boolean;
    largeDeps?: boolean;
  },
): Promise<void> {
  await stubRail(page);
  let rejectViewed = options?.failViewedOnce;
  const cl = {
    ...SAMPLE_CL,
    id: options?.mega2 ? "cl_m2_fixture" : SAMPLE_CL.id,
    files: (options?.files ?? SAMPLE_CL.files).map(file => ({ ...file, viewed: file.viewed ?? false })),
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
      if (rejectViewed) {
        rejectViewed = false;
        await route.fulfill({ status: 500, json: { error: { code: "MEGA_INTERNAL_ERROR", message: "Save failed" } } });
        return;
      }
      const { path, viewed } = route.request().postDataJSON();
      const file = cl.files.find(candidate => candidate.path === path);
      if (!file || typeof viewed !== "boolean") {
        await route.fulfill({ status: 400, json: { error: { code: "INVALID_FILE" } } });
        return;
      }
      file.viewed = viewed;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: file }),
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

  test("the file tree opens the corresponding highlighted card and folder toggles preserve the diffs", async ({ page }) => {
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
    const patch = filePatch(page, INDEX_FILE);
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
    const rust = filePatch(page, "src/main.rs");
    const rename = fileCard(page, "src/main.rs").locator("header");
    await expect(rename).toContainText("src/legacy_main.rs");
    await expect(rename).toContainText("src/main.rs");
    await expect(rename.getByRole("button", { name: "Copy file path" })).toBeVisible();
    await expect(rust).toBeInViewport();
    await expect(patchLine(rust, "addition")).toHaveText("fn answer() -> u32 { 42 }");
    await expect(patchLine(rust, "deletion")).toHaveText("fn answer() -> u32 { 0 }");
    await expect.poll(async () => (await tokenColors(patchLine(rust, "addition"))).length).toBeGreaterThan(1);
    await expect(patchLine(patch, "addition")).toHaveText("export const x = 1;");
    await expect(page.locator('[data-mega-cls="tabs"] [data-tab="files"][data-mega-cls="tab-active"]')).toBeVisible();
  });

  test("unknown file types keep their text and empty and binary patches are distinguished", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.goto(`${CL_PATH}/files?file=notes.undetected`);
    const patch = filePatch(page, "notes.undetected");
    await expect(patchLine(patch, "addition")).toHaveText("Plain file contents <example>");
    const tree = page.getByRole("tree", { name: "Changed files" });
    await tree.getByRole("treeitem", { name: "notes", exact: true }).click();
    await tree.getByRole("treeitem", { name: /^empty\.txt\b/ }).click();
    await expect(filePatch(page, "notes/empty.txt")).toHaveText("(empty patch)");
    await tree.getByRole("treeitem", { name: "assets", exact: true }).click();
    await tree.getByRole("treeitem", { name: /^logo\.bin\b/ }).click();
    await expect(filePatch(page, "assets/logo.bin").getByRole("status")).toHaveText("Binary file · no text diff available");
  });

  test("a large Rust file highlights both ends as its diff scrolls", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.goto(`${CL_PATH}/files?file=src%2Fgenerated.rs`);
    const patch = filePatch(page, "src/generated.rs");
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
    const selectedCard = fileCard(page, "project/src/file-1199.ts");
    await expect(selectedCard).toBeInViewport();
    await expect(patchLine(selectedCard, "addition")).toHaveText("export const value = 1199;");
    await expect(page.locator('[data-mega-cls="file-card"]')).toHaveCount(5);
  });

  test("reviewers can collapse a single card, change layout, and persist viewed progress", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.goto(`${CL_PATH}/files`);
    const ts = fileCard(page, INDEX_FILE);
    const rust = fileCard(page, "src/main.rs");
    const expand = ts.locator('[data-mega-cls="file-toggle"]');
    const progress = page.locator('[data-mega-cls="viewed-progress"]');
    await expect(page.locator('[data-mega-cls="file-card"]')).toHaveCount(5);
    await expect(progress).toHaveText("0/7 viewed");
    await expand.click();
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expect(ts.locator("diffs-container")).toHaveCount(0);
    await expect(patchLine(rust, "addition")).toHaveText("fn answer() -> u32 { 42 }");
    await expand.click();
    await page.getByRole("button", { name: "Split", exact: true }).click();
    await expect(ts.locator("code[data-additions]")).toBeVisible();
    await expect(ts.locator("code[data-deletions]")).toBeVisible();
    await page.getByRole("button", { name: "Unified", exact: true }).click();
    await expect(ts.locator("code[data-unified]")).toBeVisible();

    const viewed = ts.getByRole("checkbox");
    const saved = page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith("/viewed"));
    await viewed.click();
    await expect(viewed).toBeChecked();
    expect((await saved).ok()).toBe(true);
    await expect(progress).toHaveText("1/7 viewed");
    await expect(rust.getByRole("checkbox")).not.toBeChecked();
    await page.reload();
    await expect(viewed).toBeChecked();
    await expect(progress).toHaveText("1/7 viewed");
    await viewed.click();
    await expect(viewed).not.toBeChecked();
    await expect(progress).toHaveText("0/7 viewed");
  });

  test("file pages allow browsing beyond the first group and returning to earlier cards", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.goto(`${CL_PATH}/files`);
    const next = page.locator('[data-mega-cls="next-files"]');
    const previous = page.locator('[data-mega-cls="previous-files"]');
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(next).toBeDisabled();
    await expect(fileCard(page, INDEX_FILE)).toHaveCount(0);
    await expect(fileCard(page, "tools/index.ts")).toBeAttached();
    await expect(page.locator('[data-mega-cls="file-card"]')).toHaveCount(2);
    await previous.click();
    await expect(fileCard(page, INDEX_FILE)).toBeAttached();
    await expect(next).toBeEnabled();
    const tree = page.getByRole("tree", { name: "Changed files" });
    await tree.getByRole("treeitem", { name: "tools", exact: true }).click();
    await tree.getByRole("treeitem", { name: /^index\.ts\b/, level: 2 }).click();
    const tool = fileCard(page, "tools/index.ts");
    await expect(patchLine(tool, "addition")).toHaveText("export const tool = true;");
    await expect(tool.locator("header")).toBeInViewport();
    await expect(next).toBeDisabled();
  });

  test("a failed Viewed update leaves the count unchanged and the same file can be retried", async ({ page }) => {
    await stubAttachmentApis(page, { failViewedOnce: true });
    await page.goto(`${CL_PATH}/files`);
    const viewed = fileCard(page, INDEX_FILE).getByRole("checkbox");
    const progress = page.locator('[data-mega-cls="viewed-progress"]');
    await viewed.click();
    await expect(page.locator('[data-mega-cls="files"] [role="alert"]')).toBeVisible();
    await expect(viewed).not.toBeChecked();
    await expect(progress).toHaveText("0/7 viewed");
    await viewed.click();
    await expect(viewed).toBeChecked();
    await expect(progress).toHaveText("1/7 viewed");
  });

  test("revision switches update the patch, file and review statistics, and browser-local Mega2 progress", async ({ page }) => {
    const changedRange = "@@ -8,3 +10,2 @@\n-old A\n-old B\n-old C\n+export const ranged = true;\n+export const next = 1;\n";
    const files = SAMPLE_CL.files.map(file => file.path === INDEX_FILE
      ? { ...file, rangePatches: { "1..2": changedRange } }
      : file);
    await stubAttachmentApis(page, { mega2: true, files });
    const viewedWrites: string[] = [];
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/viewed")) viewedWrites.push(request.url());
    });
    await page.goto(`${CL_PATH}/files`);
    const range = page.getByRole("combobox", { name: "Revision range" });
    const viewed = fileCard(page, INDEX_FILE).getByRole("checkbox");
    const progress = page.locator('[data-mega-cls="viewed-progress"]');
    const header = fileCard(page, INDEX_FILE).locator("header");
    const leaf = page.getByRole("treeitem", { level: 4, selected: true });
    const toolbar = page.locator('[data-mega-cls="review-toolbar"]');
    async function expectCounts(scope: Locator, additions: number, deletions: number) {
      await expect(scope.getByText(`+${additions}`, { exact: true })).toBeVisible();
      await expect(scope.getByText(`−${deletions}`, { exact: true })).toBeVisible();
    }
    await viewed.check();
    await expect(progress).toHaveText("1/7 viewed");
    await range.selectOption("1..2");
    await expect(page).toHaveURL(/[?&]range=1\.\.2/);
    await expect(patchLine(fileCard(page, INDEX_FILE), "addition")).toHaveText(["export const ranged = true;", "export const next = 1;"]);
    await expectCounts(header, 2, 3);
    await expectCounts(leaf, 2, 3);
    await expectCounts(toolbar, 505, 4);
    await expect(viewed).not.toBeChecked();
    await expect(progress).toHaveText("0/7 viewed");
    await range.selectOption("");
    await expect(page).toHaveURL(`${CL_PATH}/files`);
    await page.reload();
    await expect(viewed).toBeChecked();
    await expect(progress).toHaveText("1/7 viewed");
    await expect(patchLine(fileCard(page, INDEX_FILE), "addition")).toHaveText("export const x = 1;");
    await expectCounts(header, 1, 1);
    await expectCounts(leaf, 1, 1);
    await expectCounts(toolbar, 504, 2);
    expect(viewedWrites).toEqual([]);
  });

  test("hiding the tree preserves the review and the path filter distinguishes duplicate filenames", async ({ page }) => {
    await stubAttachmentApis(page);
    await page.goto(`${CL_PATH}/files`);
    const toggle = page.locator('[data-mega-cls="toggle-tree"]');
    const tree = page.getByRole("tree", { name: "Changed files" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(tree).toBeHidden();
    await expect(fileCard(page, INDEX_FILE)).toBeVisible();
    await toggle.click();
    await expect(tree).toBeVisible();
    const filter = page.getByRole("searchbox", { name: "Filter changed files" });
    await filter.fill("TOOLS/INDEX");
    const target = tree.getByRole("treeitem", { name: /^index\.ts\b/ });
    await expect(target).toHaveCount(1);
    await expect(page.locator('[data-mega-cls="file-card"]')).toHaveCount(1);
    await target.click();
    await expect(patchLine(fileCard(page, "tools/index.ts"), "addition")).toHaveText("export const tool = true;");
    await filter.fill("no-such-file");
    await expect(tree.getByRole("treeitem")).toHaveCount(0);
    await expect(page.locator('[data-mega-cls="file-card"]')).toHaveCount(0);
    await filter.fill("");
    await expect(tree.getByRole("treeitem", { name: "packages", exact: true })).toBeVisible();
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
    const patch = filePatch(page, "tools/index.ts");
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
      await expect(patchLine(filePatch(page, INDEX_FILE), "addition")).toHaveText("export const ranged = true;");
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
    const added = patchLine(filePatch(page, INDEX_FILE), "addition");
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
    await page.locator('[data-mega-cls="toggle-tree"]').click();
    await expect(page.getByRole("tree")).toBeHidden();
    await expect(added).toBeInViewport();
  });
});
