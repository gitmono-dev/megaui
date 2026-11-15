import { expect, test } from "@playwright/test";

test("root redirects into localized homepage shell", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/(en|zh-CN)\/?$/);
  await expect(page.getByTestId("home-cta")).toBeVisible();
});
