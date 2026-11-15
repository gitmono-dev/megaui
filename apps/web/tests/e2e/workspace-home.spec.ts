import { expect, test } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";
import { e2eBaseURL } from "./helpers/base-url";

/**
 * WA-07 e2e: workspace shell + home dashboard.
 */

test.describe("WA-07 workspace home / shell", () => {
  test("guest visiting workspace redirects to signin", async ({ request }) => {
    const response = await request.get("/en/workspace", { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    const location = response.headers().location ?? "";
    expect(location).toContain("/en/signin");
  });

  test("signed-in shell renders rail and home", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto("/en/workspace");

    await expect(page.locator('[data-mega-shell="workspace-rail"]')).toBeVisible();
    await expect(page.locator('[data-mega-shell="rail-search"]')).toBeVisible();
    await expect(page.locator('[data-mega-home="page"]')).toBeVisible();
    await expect(page.locator('[data-mega-home="hero"]')).toBeVisible();
    await expect(page.locator('[data-mega-home="kpi-strip"]')).toBeVisible();
    await expect(page.locator('[data-mega-home="card-grid"]')).toBeVisible();

    await context.close();
  });

  test("home empty cards render card-empty markers", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();

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

    await page.goto("/en/workspace");
    await expect(page.locator('[data-mega-home="card-grid"]')).toBeVisible();
    await expect(page.locator('[data-mega-home="card-empty"]').first()).toBeVisible();
    await expect(page.locator('[data-card="review"] [data-mega-home="card-empty"]')).toBeVisible();

    await context.close();
  });

  test("home error state shows alert and retry", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();

    await page.route("**/api/mega/home", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "MEGA_INTERNAL_ERROR",
            messageKey: "errors.mega.internal",
            message: "boom",
          },
        }),
      });
    });

    await page.goto("/en/workspace");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator('[data-mega-home="retry"]')).toBeVisible();

    await context.close();
  });

  test("workspace metadata title", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto("/en/workspace");
    await expect(page).toHaveTitle(/Workspace/i);
    await context.close();
  });

  test("zh-CN home renders bilingual copy", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto("/zh-CN/workspace");
    await expect(page.locator('[data-mega-home="page"]')).toBeVisible();
    await expect(page.locator('[data-mega-shell="rail-search"]')).toBeVisible();
    await context.close();
  });

  test("palette shows CJK scale exceeded message", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();

    await page.route("**/api/mega/search**", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "SEARCH_CJK_SCALE_EXCEEDED",
            messageKey: "errors.search.cjkScaleExceeded",
          },
        }),
      });
    });

    await page.goto("/en/workspace");
    await page.locator('[data-mega-shell="rail-search"]').click();
    await expect(page.locator('[data-mega-palette="root"]')).toBeVisible();
    await page.locator('[data-mega-palette="input"]').fill("全文搜索");
    await expect(page.locator('[data-mega-palette="status"][role="alert"]')).toContainText(
      /CJK|Chinese|scale|unavailable|过大|中文/i,
      { timeout: 10_000 },
    );

    await context.close();
  });
});
