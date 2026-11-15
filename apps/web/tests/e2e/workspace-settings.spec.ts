import { expect, test, type Page } from "@playwright/test";

import { mintSecondSessionCookies, mintSessionCookies } from "./helpers/session";
import { e2eBaseURL } from "./helpers/base-url";

async function stubRail(page: Page): Promise<void> {
  await page.route("**/api/mega/channels**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
  await page.route("**/api/mega/cls**", async (route) => {
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

async function stubProfilePrefs(page: Page): Promise<void> {
  let prefs = { username: "ada", bio: "initial bio" };
  await page.route("**/api/mega/profile-prefs**", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { bio?: string };
      prefs = { ...prefs, bio: body.bio ?? prefs.bio };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: prefs }),
    });
  });
}

async function stubNotifications(page: Page): Promise<void> {
  let config: {
    settings: {
      username: string;
      enabled: boolean;
      deliveryMode: "in_app" | "email";
      preferredLocale: string;
    };
    preferences: Array<{
      eventTypeCode: string;
      category: string;
      description: string;
      systemRequired: boolean;
      defaultEnabled: boolean;
      enabled: boolean;
    }>;
  } = {
    settings: {
      username: "ada",
      enabled: true,
      deliveryMode: "in_app",
      preferredLocale: "en",
    },
    preferences: [
      {
        eventTypeCode: "issue.comment.created",
        category: "issue",
        description: "issue comment",
        systemRequired: false,
        defaultEnabled: true,
        enabled: true,
      },
    ],
  };

  await page.route("**/api/mega/user/notifications**", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as {
        enabled?: boolean;
        deliveryMode?: "in_app" | "email";
        preferredLocale?: string;
        preferences?: Array<{ eventTypeCode: string; enabled: boolean }>;
      };
      config = {
        settings: {
          ...config.settings,
          enabled: body.enabled ?? config.settings.enabled,
          deliveryMode: body.deliveryMode ?? config.settings.deliveryMode,
          preferredLocale: body.preferredLocale ?? config.settings.preferredLocale,
        },
        preferences: body.preferences
          ? config.preferences.map((preference) => {
              const next = body.preferences?.find((item) => item.eventTypeCode === preference.eventTypeCode);
              return next ? { ...preference, enabled: next.enabled } : preference;
            })
          : config.preferences,
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: config }),
    });
  });
}

test.describe("workspace settings (WA-17)", () => {
  test("profile bio saves and persists after reload", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubRail(page);
    await stubProfilePrefs(page);

    await page.goto("/en/workspace/settings");
    await expect(page.locator('[data-mega-settings="profile-form"]')).toBeVisible();
    await page.locator('[data-mega-settings="field-bio"]').fill("Persisted bio for WA-17");
    await page.locator('[data-mega-settings="save"]').click();
    await expect(page.getByText("Profile updated.")).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.locator('[data-mega-settings="field-bio"]')).toHaveValue("Persisted bio for WA-17");

    await context.close();
  });

  test("invalid bio shows i18n error", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubRail(page);
    await stubProfilePrefs(page);

    await page.goto("/en/workspace/settings");
    await page.locator('[data-mega-settings="field-bio"]').fill("x".repeat(281));
    await page.locator('[data-mega-settings="save"]').click();
    await expect(page.getByText("Bio must be at most 280 characters.")).toBeVisible();

    await context.close();
  });

  test("notifications delivery save persists after reload", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubRail(page);
    await stubNotifications(page);

    await page.goto("/en/workspace/settings?section=notifications");
    await page.locator('[data-mega-settings="notifications-delivery"]').selectOption("email");
    await page.locator('[data-mega-settings="notifications-save"]').click();
    await expect(page.getByText("Notification settings saved.")).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.locator('[data-mega-settings="notifications-delivery"]')).toHaveValue("email");

    await context.close();
  });

  test("change password revokes other live session", async ({ browser }) => {
    test.setTimeout(90_000);
    const { cookies, email, password } = mintSessionCookies();
    const otherCookies = mintSecondSessionCookies(email, password);

    const primary = await browser.newContext({ baseURL: e2eBaseURL() });
    await primary.addCookies(cookies);
    const primaryPage = await primary.newPage();
    await stubRail(primaryPage);
    await stubProfilePrefs(primaryPage);

    const secondary = await browser.newContext({ baseURL: e2eBaseURL() });
    await secondary.addCookies(otherCookies);
    const secondaryPage = await secondary.newPage();
    await stubRail(secondaryPage);

    await secondaryPage.goto("/en/workspace/settings");
    await expect(secondaryPage.locator('[data-mega-settings="page"]')).toBeVisible({ timeout: 15_000 });

    await primaryPage.goto("/en/workspace/settings?section=account-security");
    await expect(primaryPage.locator('[data-mega-settings="session-row"]').first()).toBeVisible({ timeout: 15_000 });
    const beforeCount = await primaryPage.locator('[data-mega-settings="session-row"]').count();
    expect(beforeCount).toBeGreaterThanOrEqual(2);

    const nextPassword = "WA17-new-password-9x!";
    await primaryPage.locator('[data-mega-settings="change-password-form"] input[autocomplete="current-password"]').fill(password);
    await primaryPage.locator('[data-mega-settings="change-password-form"] input[autocomplete="new-password"]').first().fill(nextPassword);
    await primaryPage.locator('[data-mega-settings="change-password-form"] input[autocomplete="new-password"]').nth(1).fill(nextPassword);
    await primaryPage.locator('[data-mega-settings="change-password-form"] button[type="submit"]').click();
    await expect(primaryPage.getByText("Password changed")).toBeVisible({ timeout: 15_000 });
    await expect(primaryPage.locator('[data-mega-settings="session-row"]')).toHaveCount(1, { timeout: 10_000 });

    await secondaryPage.goto("/en/workspace/inbox");
    await expect(secondaryPage).toHaveURL(/\/(en\/)?(signin|login)/, { timeout: 15_000 });

    await primary.close();
    await secondary.close();
  });

  test("appearance dark mode persists across reload without flash class loss", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubRail(page);
    await stubProfilePrefs(page);

    await page.goto("/en/workspace/settings?section=appearance");
    await page.locator('[data-mega-settings="mode-dark"]').click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator('[data-mega-settings="mode-dark"]')).toHaveAttribute("aria-pressed", "true");

    await context.close();
  });
});
