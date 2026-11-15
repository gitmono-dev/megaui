// megaui-only (FS-24 / FS-59): enterprise public profile and local notification settings stay isolated.
import { expect, test, type Page } from "@playwright/test";
import {
  createEnterpriseAuthFlowFixture,
  createLegacyAuthFlowFixture,
  type EnterpriseAuthFlowFixture,
  type LegacyAuthFlowFixture,
} from "./helpers/enterprise-auth-flow";

async function signInEnterprise(page: Page, fixture: EnterpriseAuthFlowFixture): Promise<void> {
  await page.goto(`${fixture.web.origin}/en/signin`);
  const pairingResponse = await page.evaluate(async () => {
    const response = await fetch("/api/auth/enterprise/request", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alias: "fs89-alice" }),
    });
    return { status: response.status, body: await response.json() as { pairingId?: string; pairingToken?: string } };
  });
  expect(pairingResponse.status).toBe(202);
  const flowCookie = (await page.context().cookies()).find(cookie => cookie.name === "__Host-megaui.enterprise-flow");
  expect(flowCookie?.value).toBeTruthy();
  const challenge = await fixture.login({
    pairingId: pairingResponse.body.pairingId!,
    pairingToken: pairingResponse.body.pairingToken!,
    flowCookie: flowCookie!.value,
  });
  const verify = await page.evaluate(async input => {
    const response = await fetch("/api/auth/enterprise/verify", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return response.status;
  }, challenge);
  expect(verify).toBe(200);
}

test.describe("FS-59 enterprise profile", () => {
  let fixture: EnterpriseAuthFlowFixture;

  test.beforeAll(async () => {
    fixture = await createEnterpriseAuthFlowFixture();
  }, 240_000);

  test.afterAll(async () => {
    await fixture?.close();
  }, 120_000);

  test("disables directory-owned fields and keeps profile updates local", async ({ page }) => {
    await signInEnterprise(page, fixture);
    await page.goto(`${fixture.web.origin}/en/workspace/settings?section=profile`);
    await expect(page.locator('[data-mega-settings="profile-form"]')).toBeVisible();
    await expect(page.locator('[data-mega-settings="directory-managed"]')).toBeVisible();
    await expect(page.getByLabel("Display name")).toBeDisabled();
    await expect(page.locator('[data-mega-settings="avatar-file-input"]')).toBeDisabled();
    await expect(page.getByLabel("Paste image URL")).toBeDisabled();
    await expect(page.locator('[data-mega-settings="directory-managed"]')).toContainText("Managed by your organization directory");
    await expect(page.getByLabel("Notification email")).toHaveValue("alice@example.com");
    await expect(page.getByLabel("Notification email")).toBeDisabled();

    let updateUserRequests = 0;
    page.on("request", request => {
      if (request.url().endsWith("/api/auth/update-user")) updateUserRequests += 1;
    });
    await page.getByLabel("Bio").fill("FS-59 enterprise directory profile");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator('[data-mega-settings="toast"]')).toContainText("Profile updated.");
    expect(updateUserRequests).toBe(0);

    await page.goto(`${fixture.web.origin}/en/workspace`);
    await expect(page.locator("body")).toContainText("FS89 Synthetic Alice");
    await expect(page.locator("body")).not.toContainText(fixture.email);
  });
});

test.describe("FS-59 legacy profile", () => {
  let fixture: LegacyAuthFlowFixture;

  test.beforeAll(async () => {
    fixture = await createLegacyAuthFlowFixture();
  }, 240_000);

  test.afterAll(async () => {
    await fixture?.close();
  }, 120_000);

  test("keeps the legacy profile editing contract", async ({ page }) => {
    const password = "FS59-legacy-pass-9x!";
    await page.goto(`${fixture.web.origin}/en/signup`);
    await page.fill("input#name", "FS59 Legacy Synthetic");
    await page.fill("input#email", fixture.email);
    await page.fill("input#password", password);
    await page.getByRole("button", { name: /create account/i }).click();
    await page.waitForURL(/\/en\/workspace/, { timeout: 15_000 });
    await page.goto(`${fixture.web.origin}/en/workspace/settings?section=profile`);
    await expect(page.getByLabel("Display name")).toBeEnabled();

    let updateUserRequests = 0;
    page.on("request", request => {
      if (request.url().endsWith("/api/auth/update-user")) updateUserRequests += 1;
    });
    await page.getByLabel("Display name").fill("FS59 Legacy Edited");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator('[data-mega-settings="toast"]')).toContainText("Profile updated.");
    expect(updateUserRequests).toBe(1);
  });
});
