import { expect, test, type Page } from "@playwright/test";

import { mintSessionCookies, type SessionCookie } from "./helpers/session";

async function stubConflictApis(page: Page): Promise<void> {
  await page.route("**/api/mega/channels**", async (route) => {
    await route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ data: [] }) });
  });
  await page.route("**/api/mega/notifications/**", async (route) => {
    await route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ data: { count: 0 } }) });
  });
  await page.route("**/api/mega/docs**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ data: [] }) });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      status: 409,
      body: JSON.stringify({
        error: {
          code: "TITLE_CONFLICT",
          message: "Document title already exists",
          messageKey: "errors.mega.titleConflict",
        },
      }),
    });
  });
}

test.describe("workspace docs duplicate title", () => {
  let sessionCookies: SessionCookie[];

  test.beforeAll(() => {
    sessionCookies = mintSessionCookies().cookies;
  });

  test.beforeEach(async ({ context }) => {
    await context.addCookies(sessionCookies);
  });

  test("keeps the create dialog open and explains a duplicate title", async ({ page }) => {
    await stubConflictApis(page);
    await page.goto("/en/workspace/docs");
    await page.locator('[data-mega-docs="header-new"]').click();

    const dialog = page.locator('[data-mega-docs="new-dialog"]');
    const title = page.locator('[data-mega-docs="new-title"]');
    await title.fill("Existing workspace document");
    await page.locator('[data-mega-docs="new-submit"]').click();

    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveText("A document with this title already exists.");
    await expect(title).toHaveValue("Existing workspace document");
  });
});
