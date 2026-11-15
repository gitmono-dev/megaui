import { expect, test, type Page } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";
import { e2eBaseURL } from "./helpers/base-url";

async function stubWorkspace(page: Page): Promise<void> {
  for (const path of ["channels", "cls"]) {
    await page.route(`**/api/mega/${path}**`, async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
    });
  }
  await page.route("**/api/mega/notifications/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { count: 0 } }) });
  });
  await page.route("**/api/mega/profile-prefs**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { username: "ada", bio: "" } }),
    });
  });
}

test.describe("WA-19 avatar upload", () => {
  test("uploads an avatar and displays the returned public URL in profile", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubWorkspace(page);

    const avatarUrl = "https://cdn.example.test/objects/avatars/test-user/avatar.png";
    await page.route("**/api/upload**", async (route) => {
      expect(route.request().method()).toBe("POST");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            key: "avatars/test-user/avatar.png",
            url: avatarUrl,
          },
        }),
      });
    });
    await page.goto("/en/workspace/settings?section=profile");
    const fileInput = page.locator('[data-mega-settings="avatar-file-input"]');
    await expect(fileInput).toBeVisible({ timeout: 15_000 });
    await fileInput.setInputFiles({
      name: "avatar.png",
      mimeType: "image/png",
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    });

    await expect(page.getByText("Avatar updated.")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-mega-settings="avatar-preview"]')).toHaveAttribute("src", avatarUrl, {
      timeout: 15_000,
    });
    await context.close();
  });
});
