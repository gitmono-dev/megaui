// megaui-only (FS-92): actual components, controlled Next context in an owned page.
import { expect, test, type Page } from "@playwright/test";
import { mintSessionCookies } from "./helpers/session";
import { lexicalDocumentWithText, stubWorkspace } from "./helpers/workspace-docs-roam-fixture";

async function fixture(page: Page) {
  const errors: string[] = [];
  const writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== "GET" && (pathname.startsWith("/api/mega/") || pathname === "/api/upload")) writes.push(pathname);
  });
  const docs = await stubWorkspace(page, "doc_navigation", lexicalDocumentWithText("Navigation fixture document"));
  const cl = { number: 42, publicId: "Qa1NaviA0042", revisions: [{ number: 1 }, { number: 2 }], files: [
    { path: "a.ts", patch: "first", additions: 1, deletions: 0 },
    { path: "b.ts", patch: "latest", additions: 2, deletions: 0, viewed: false, rangePatches: { "1..2": "selected range" } },
  ] };
  await page.route("**/api/mega/cls/**", (route) => route.fulfill({ json: { data: cl } }));
  await page.route("**/api/mega/workspace", (route) => route.fulfill({ json: { data: { name: "Synthetic", defaultBranch: "main" } } }));
  await page.route("**/api/mega/code-tree**", (route) => route.fulfill({ json: { data: [
    { path: "README file.md", name: "README file.md", kind: "file" },
  ] } }));
  await page.route("**/api/mega/source-file**", (route) => route.fulfill({ json: { data: {
    path: "README file.md", content: "# Ready", language: "markdown", lines: 1, sizeBytes: 7,
  } } }));
  await page.route("**/api/mega/readme**", (route) => route.fulfill({ json: { data: [] } }));
  await page.goto("/en/owned-navigation");
  await expect(page.getByLabel("Readiness", { exact: true })).toHaveValue("unknown");
  return { errors, writes, docs };
}

async function select(page: Page, consumer: string, readiness: string, query = "") {
  await page.getByLabel("Consumer", { exact: true }).selectOption(consumer);
  await page.getByLabel("Query", { exact: true }).fill(query);
  await page.getByLabel("Readiness", { exact: true }).selectOption(readiness);
}

test.beforeEach(async ({ context }) => {
  await context.addCookies(mintSessionCookies().cookies);
});

for (const consumer of ["cl", "code", "doc", "roam", "settings-nav", "settings"]) {
  test(`${consumer} tolerates initially unknown context without new actions`, async ({ page }) => {
    const state = await fixture(page);
    await select(page, consumer, "unknown");
    const content = page.locator('[data-owned="consumer"]');
    await expect(content.locator('[data-mega-docs="editor"], [data-mega-settings="profile-form"]')).toHaveCount(0);
    await expect(content.locator('[data-mega-cls="file-viewed"], [data-mega-code="tab-preview"], [data-mega-settings="section-profile"]')).toHaveCount(0);
    await expect(page.locator('[data-owned="navigation"]')).toHaveText("[]");
    expect(state.writes).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

test("CL file/range and viewed action resume after search becomes known", async ({ page }) => {
  const state = await fixture(page);
  await select(page, "cl", "known", "range=1..2&file=b.ts");
  await expect(page.locator('[data-mega-cls="diff-patch"]')).toHaveText("selected range");
  await page.locator('[data-mega-cls="file-viewed"]').click();
  await expect.poll(() => state.writes.filter((url) => url.endsWith("/viewed")).length).toBe(1);
  await page.getByLabel("Readiness", { exact: true }).selectOption("no-search");
  await expect(page.locator('[data-mega-cls="file-viewed"]')).toHaveCount(0);
  await page.getByLabel("Readiness", { exact: true }).selectOption("known");
  await expect(page.locator('[data-mega-cls="diff-patch"]')).toHaveText("selected range");
  await page.locator('[data-mega-cls="file-viewed"]').click();
  await expect.poll(() => state.writes.filter((url) => url.endsWith("/viewed")).length).toBe(2);
  expect(state.errors).toEqual([]);
});

test("code path/tab and settings navigation recover after null", async ({ page }) => {
  const state = await fixture(page);
  await select(page, "code", "known", "tab=code");
  await expect(page.locator('[data-mega-code="breadcrumb"]')).toContainText("README file.md");
  await page.locator('[data-mega-code="tab-preview"]').click();
  await expect(page.locator('[data-owned="navigation"]')).toContainText("replace ?tab=preview");
  await page.getByLabel("Readiness", { exact: true }).selectOption("no-params");
  await expect(page.locator('[data-mega-code="tab-preview"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Clear navigation", exact: true }).click();
  await select(page, "settings-nav", "no-search");
  await expect(page.locator('[data-mega-settings="section-profile"]')).toHaveCount(0);
  await page.getByLabel("Readiness", { exact: true }).selectOption("known");
  await page.locator('[data-mega-settings="section-notifications"]').click();
  await expect(page.locator('[data-owned="navigation"]')).toContainText("replace ?section=notifications");
  expect(state.errors).toEqual([]);
});

test("unknown search cannot mount editable document/profile; known snapshot remains a reader", async ({ page }) => {
  const state = await fixture(page);
  await select(page, "doc", "no-search");
  await expect(page.locator('[data-mega-docs="editor"]')).toHaveCount(0);
  await page.getByLabel("Readiness", { exact: true }).selectOption("known");
  await expect(page.locator('[data-mega-docs="editor"] [contenteditable="true"]')).toBeVisible();
  await page.getByLabel("Readiness", { exact: true }).selectOption("no-search");
  await expect(page.locator('[data-mega-docs="editor"]')).toHaveCount(0);
  await page.getByLabel("Query", { exact: true }).fill("v=1");
  await page.getByLabel("Readiness", { exact: true }).selectOption("known");
  await expect(page.locator('[data-mega-docs="snapshot-banner"]')).toBeVisible();
  await expect(page.locator('[data-mega-docs="editor"]')).toHaveCount(0);
  await select(page, "settings", "no-search");
  await expect(page.locator('[data-mega-settings="profile-form"]')).toHaveCount(0);
  await page.getByLabel("Readiness", { exact: true }).selectOption("known");
  await expect(page.locator('[data-mega-settings="profile-form"]')).toBeVisible();
  await page.getByLabel("Readiness", { exact: true }).selectOption("no-search");
  await expect(page.locator('[data-mega-settings="profile-form"]')).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

for (const transition of ["unknown", "changed-query"]) {
test(`an admitted restore cannot navigate after ${transition}`, async ({ page }) => {
  const state = await fixture(page);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let admitted: () => void = () => {};
  const started = new Promise<void>((resolve) => { admitted = resolve; });
  await page.route("**/api/mega/docs/doc_navigation/save", async (route) => {
    admitted();
    await gate;
    await route.fallback();
  });
  try {
    await select(page, "doc", "known", "v=1");
    await page.locator('[data-mega-docs="restore"]').click();
    await started;
    if (transition === "unknown") await page.getByLabel("Readiness", { exact: true }).selectOption("no-pathname");
    else await page.getByLabel("Query", { exact: true }).fill("v=1&block=roam-text-block");
    const completed = page.waitForResponse((response) => response.url().endsWith("/docs/doc_navigation/save"));
    release();
    expect((await completed).status()).toBe(200);
    await expect(page.locator('[data-owned="mutations"]')).toContainText("success");
    await expect(page.locator('[data-owned="navigation"]')).toHaveText("[]");
    expect(state.errors).toEqual([]);
  } finally { release(); }
});
}

test("Roam shortcuts unmount when unknown and resume actual creation when known", async ({ page }) => {
  const state = await fixture(page);
  await select(page, "roam", "known");
  const editor = page.locator('[data-owned="consumer"] [contenteditable="true"]');
  await editor.click();
  await page.keyboard.type("[[Fresh page");
  await expect(page.locator('[data-mega-content="wikilink-menu"]').getByText('Create "Fresh page"')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(state.docs.resolveOrCreateCalls).toBe(1);
  await page.getByLabel("Readiness", { exact: true }).selectOption("no-search");
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" [[Unavailable page]]");
  expect(state.docs.resolveOrCreateCalls()).toBe(1);
  await expect(page.locator('[data-owned="navigation"]')).toHaveText("[]");
  await page.getByLabel("Readiness", { exact: true }).selectOption("known");
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" [[Resumed page");
  await expect(page.locator('[data-mega-content="wikilink-menu"]').getByText('Create "Resumed page"')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(state.docs.resolveOrCreateCalls).toBeGreaterThan(1);
  expect(state.errors).toEqual([]);
});
