import { expect, test, type Page } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";
import { e2eBaseURL } from "./helpers/base-url";

async function stubRail(page: Page): Promise<void> {
  for (const path of ["channels", "cls"]) {
    await page.route(`**/api/mega/${path}**`, async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
    });
  }
  await page.route("**/api/mega/notifications/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { count: 0 } }) });
  });
}

async function stubCredentials(page: Page): Promise<void> {
  let keys = [{ id: 1, title: "Existing key", fingerprint: "SHA256:existing", createdAt: "2026-09-01T00:00:00.000Z" }];
  let tokens = [{ id: 7, maskedToken: "****wxyz", createdAt: "2026-09-01T00:00:00.000Z" }];

  await page.route("**/api/mega/user/ssh**", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: keys }) });
      return;
    }
    if (method === "POST") {
      const body = route.request().postDataJSON() as { title: string; publicKey: string };
      if (!body.publicKey.startsWith("ssh-ed25519 ")) {
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "MEGA_BAD_REQUEST", message: "SSH key type is not supported" } }) });
        return;
      }
      keys = [...keys, { id: 2, title: body.title, fingerprint: "SHA256:valid-fingerprint", createdAt: "2026-09-04T00:00:00.000Z" }];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { added: true } }) });
      return;
    }
    keys = keys.filter((key) => key.id !== Number(route.request().url().split("/").at(-1)));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { deleted: true } }) });
  });

  await page.route("**/api/mega/user/tokens**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: tokens }) });
      return;
    }
    if (url.endsWith("/generate")) {
      tokens = [...tokens, { id: 8, maskedToken: "****token", createdAt: "2026-09-04T00:00:00.000Z" }];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { token: "plain-token-once" } }) });
      return;
    }
    tokens = tokens.filter((token) => token.id !== Number(url.split("/").at(-1)));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { deleted: true } }) });
  });
}

async function newCredentialsPage(page: Page): Promise<void> {
  await stubRail(page);
  await stubCredentials(page);
}

test.describe("workspace settings credentials (WA-18)", () => {
  test.describe.configure({ mode: "serial" });

  test("adds a valid SSH key and rejects an invalid key", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await newCredentialsPage(page);

    await page.goto("/en/workspace/settings?section=ssh-keys");
    await page.locator('[data-mega-settings="ssh-add-title"]').fill("Work laptop");
    await page.locator('[data-mega-settings="ssh-add-key"]').fill("ssh-ed25519 AAAA valid@example.com");
    await page.locator('[data-mega-settings="ssh-add"]').click();
    await expect(page.getByText("SHA256:valid-fingerprint")).toBeVisible();

    await page.locator('[data-mega-settings="ssh-add-title"]').fill("Invalid key");
    await page.locator('[data-mega-settings="ssh-add-key"]').fill("ssh-dss AAAA invalid@example.com");
    await page.locator('[data-mega-settings="ssh-add"]').click();
    await expect(page.getByText("SSH key type is not supported")).toBeVisible();
    await context.close();
  });

  test("reveals a generated token once, then lists only its tail", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await newCredentialsPage(page);

    await page.goto("/en/workspace/settings?section=tokens");
    await page.locator('[data-mega-settings="tokens-generate"]').click();
    await expect(page.locator('[data-mega-settings="token-plaintext"]')).toHaveText("plain-token-once");
    await page.locator('[data-mega-settings="token-reveal-done"]').click();
    await expect(page.locator('[data-mega-settings="tokens"]')).not.toContainText("plain-token-once");
    await expect(page.locator('[data-mega-settings="tokens-list"]')).toContainText("****token");
    await context.close();
  });

  test("deleting SSH keys and revoking tokens removes rows immediately", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await newCredentialsPage(page);

    await page.goto("/en/workspace/settings?section=ssh-keys");
    await page.locator('[data-mega-settings="ssh-delete"]').click();
    await page.locator('[data-mega-settings="ssh-delete-confirm"]').click();
    await expect(page.locator('[data-mega-settings="ssh-row"]')).toHaveCount(0);

    await page.goto("/en/workspace/settings?section=tokens");
    await page.locator('[data-mega-settings="token-delete"]').first().click();
    await page.locator('[data-mega-settings="token-delete-confirm"]').click();
    await expect(page.locator('[data-mega-settings="token-row"]')).toHaveCount(0);
    await context.close();
  });
});
