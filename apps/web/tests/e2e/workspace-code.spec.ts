import { expect, test } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";
import { e2eBaseURL } from "./helpers/base-url";

/**
 * WA-08 e2e: code root + path views (stub BFF; live DEP-02 optional).
 */

const SAMPLE_WORKSPACE = {
  id: "mega",
  name: "Mega",
  description: "",
  defaultBranch: "main",
  headSha: "abc123",
  starred: false,
  packages: [],
};

const SAMPLE_ROOT_ENTRIES = [
  {
    name: "packages",
    path: "packages",
    kind: "directory",
    lastCommitMessage: "init",
    updatedAt: "2026-01-01T00:00:00.000Z",
    author: {
      id: "u1",
      displayName: "Ada",
      email: "ada@example.com",
      avatarInitials: "A",
    },
  },
  {
    name: "README.md",
    path: "README.md",
    kind: "file",
    lastCommitMessage: "docs",
    updatedAt: "2026-01-01T00:00:00.000Z",
    author: {
      id: "u1",
      displayName: "Ada",
      email: "ada@example.com",
      avatarInitials: "A",
    },
  },
];

const SAMPLE_TREE = [
  {
    name: "README.md",
    path: "README.md",
    kind: "file",
  },
  {
    name: "packages",
    path: "packages",
    kind: "directory",
    children: [],
  },
];

const SAMPLE_SOURCE = {
  path: "README.md",
  language: "markdown",
  content: "# Hello\n\nWorld\n",
  lines: 3,
  sizeBytes: 16,
};

async function stubCodeApis(
  page: import("@playwright/test").Page,
  options?: { failRootEntries?: boolean },
): Promise<void> {
  await page.route("**/api/mega/workspace", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: SAMPLE_WORKSPACE }),
    });
  });
  await page.route("**/api/mega/root-entries", async (route) => {
    if (options?.failRootEntries) {
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
      body: JSON.stringify({ data: SAMPLE_ROOT_ENTRIES }),
    });
  });
  await page.route("**/api/mega/cls**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    });
  });
  await page.route("**/api/mega/issues**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { items: [], total: 0, offset: 0, limit: 50 } }),
    });
  });
  await page.route("**/api/mega/home", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          kpis: {
            reviewsRequested: 0,
            mentions: 0,
            myOpenIssues: 0,
            mainCI: "skipped",
            agentSessionsToday: 0,
          },
          cards: {
            reviewRequests: [],
            assignedIssues: [],
            activity: [],
            releases: [],
            agentThreads: [],
            docs: [],
            channels: [],
            quickLinks: [],
          },
        },
      }),
    });
  });
  await page.route("**/api/mega/code-tree**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: SAMPLE_TREE }),
    });
  });
  await page.route("**/api/mega/source-file**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: SAMPLE_SOURCE }),
    });
  });
  await page.route("**/api/mega/readme**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          { type: "heading", level: 1, text: "Hello" },
          { type: "paragraph", text: "World" },
        ],
      }),
    });
  });
  // Rail noise
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

test.describe("WA-08 workspace code", () => {
  test("stub: code root renders workspace header and root table", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubCodeApis(page);

    await page.goto("/en/workspace/code");
    await expect(page.locator('[data-mega-code="page"]')).toBeVisible();
    await expect(page.locator('[data-mega-code="workspace-name"]')).toHaveText("Mega");
    await expect(page.locator('[data-mega-code="root-table"]')).toBeVisible();
    await expect(page.locator('[data-mega-code="root-row"]').first()).toBeVisible();

    await context.close();
  });

  test("stub: mega2-style root-entries failure shows alert + retry", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubCodeApis(page, { failRootEntries: true });

    await page.goto("/en/workspace/code");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator('[data-mega-code="retry"]')).toBeVisible();

    await context.close();
  });

  test("stub: file path renders tree + blob/preview", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubCodeApis(page);

    await page.goto("/en/workspace/code/README.md");
    await expect(page.locator('[data-mega-code="tree"]')).toBeVisible();
    await expect(page.locator('[data-mega-code="breadcrumb"]')).toContainText("README.md");
    await expect(page.locator('[data-mega-code="readme"], [data-mega-code="blob"]').first()).toBeVisible({
      timeout: 15_000,
    });

    await context.close();
  });

  test("zh-CN code root renders bilingual shell", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubCodeApis(page);

    await page.goto("/zh-CN/workspace/code");
    await expect(page.locator('[data-mega-code="page"]')).toBeVisible();
    await expect(page.locator('[data-mega-code="workspace-name"]')).toBeVisible();

    await context.close();
  });

  test("stub: binary blob shows binary fallback", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubCodeApis(page);
    await page.route("**/api/mega/source-file**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            path: "asset.bin",
            language: "plaintext",
            content: `png\u0000binary-bytes`,
            lines: 1,
            sizeBytes: 16,
          },
        }),
      });
    });
    await page.route("**/api/mega/code-tree**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [{ name: "asset.bin", path: "asset.bin", kind: "file" }],
        }),
      });
    });

    await page.goto("/en/workspace/code/asset.bin?tab=code");
    await expect(page.locator('[data-mega-code="blob"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-mega-blob="binary-fallback"]')).toBeVisible();

    await context.close();
  });

  test("stub: oversized file forces plaintext blob", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubCodeApis(page);
    const big = "line\n".repeat(5_001);
    await page.route("**/api/mega/source-file**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            path: "big.txt",
            language: "plaintext",
            content: big,
            lines: 5_001,
            sizeBytes: big.length,
          },
        }),
      });
    });
    await page.route("**/api/mega/code-tree**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [{ name: "big.txt", path: "big.txt", kind: "file" }],
        }),
      });
    });

    await page.goto("/en/workspace/code/big.txt?tab=code");
    await expect(page.locator('[data-mega-blob="plaintext"]')).toBeVisible({ timeout: 15_000 });

    await context.close();
  });

  test("live mega2 code root (DEP-02 optional)", async ({ browser }) => {
    test.skip(
      !process.env.MEGA2_PUBLIC_BASE_URL,
      "Set MEGA2_PUBLIC_BASE_URL and ensure DEP-02 stack for live code e2e",
    );
    let openapiOk: boolean;
    try {
      const probe = await fetch(
        `${process.env.MEGA2_PUBLIC_BASE_URL!.replace(/\/$/, "")}/api/openapi.json`,
        { signal: AbortSignal.timeout(2000) },
      );
      openapiOk = probe.ok;
    } catch {
      openapiOk = false;
    }
    test.skip(!openapiOk, "mega2 openapi probe failed — skip live code e2e");

    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto("/en/workspace/code");
    await expect(page.locator('[data-mega-code="page"]')).toBeVisible({ timeout: 20_000 });
    await context.close();
  });
});
