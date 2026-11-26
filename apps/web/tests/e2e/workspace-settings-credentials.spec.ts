import { expect, test, type Locator, type Page } from "@playwright/test";

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

  let gpg = [{ id: "ABC123", fingerprint: "0123456789ABCDEF", createdAt: "2026-09-01T00:00:00Z", expiresAt: null as string | null }];
  await page.route("**/api/mega/user/gpg**", async route => {
    const method = route.request().method();
    if (method === "POST") gpg = [...gpg, { id: "DEF456", fingerprint: "FEDCBA9876543210", createdAt: "2026-09-04T00:00:00Z", expiresAt: null }];
    if (method === "DELETE") gpg = gpg.filter(key => key.id !== route.request().url().split("/").at(-1));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: method === "GET" ? gpg : { ok: true } }) });
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

function textStyle(locator: Locator) {
  return locator.evaluate(element => {
    const style = getComputedStyle(element);
    return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.color];
  });
}

function buttonColors(locator: Locator) {
  return locator.evaluate(element => {
    const { backgroundColor, color } = getComputedStyle(element);
    return { backgroundColor, color };
  });
}

test.describe("workspace settings credentials (WA-18)", () => {
  test.describe.configure({ mode: "serial" });

  test("Chinese SSH and GPG cards use consistent empty states, key hints and add buttons", async ({ page, context }) => {
    await context.addCookies(mintSessionCookies().cookies);
    await stubRail(page);
    await page.route(/\/api\/mega\/user\/(ssh|gpg)$/, route => route.fulfill({ json: { data: [] } }));
    await page.goto("/zh-CN/workspace/settings?section=ssh-keys");

    const cards = page.locator('[data-mega-settings="card"]');
    const ssh = cards.filter({ has: page.getByRole("heading", { name: "SSH 密钥", exact: true }) });
    const gpg = cards.filter({ has: page.getByRole("heading", { name: "GPG 密钥", exact: true }) });
    const sshEmpty = ssh.getByRole("paragraph").filter({ hasText: /^添加 SSH /u });
    const gpgEmpty = gpg.getByRole("paragraph").filter({ hasText: /^暂无 GPG /u });
    await expect(sshEmpty).toBeVisible();
    await expect(gpgEmpty).toBeVisible();
    expect(await textStyle(gpgEmpty)).toEqual(await textStyle(sshEmpty));
    await expect(sshEmpty).toHaveText("添加 SSH 密钥后即可通过 SSH 向 Mega2 推送代码");
    await expect(gpgEmpty).toHaveText("暂无 GPG 密钥");

    const sshToggle = ssh.getByRole("button", { expanded: false });
    const gpgToggle = gpg.getByRole("button", { expanded: false });
    const toggleColors = await buttonColors(sshToggle);
    expect(await buttonColors(gpgToggle)).toEqual(toggleColors);
    await sshToggle.click();
    await gpgToggle.click();
    const submitColors = await buttonColors(ssh.locator('button[type="submit"]'));
    expect(await buttonColors(gpg.locator('button[type="submit"]'))).toEqual(submitColors);
    expect(submitColors.backgroundColor).not.toBe(toggleColors.backgroundColor);

    for (const card of [ssh, gpg]) {
      const hint = card.locator("form small");
      await expect(hint).toBeVisible();
      await expect(card.getByLabel("公钥", { exact: true })).toHaveAccessibleDescription(await hint.innerText());
      for (const message of [...await card.locator("p").all(), hint]) {
        await expect(message).toHaveText(/[^.。\s]$/u);
      }
    }
    const sshHint = ssh.locator("form small");
    const gpgHint = gpg.locator("form small");
    await expect(sshHint).toContainText("~/.ssh/id_ed25519.pub");
    await expect(gpgHint).toContainText("GPG 公钥");
    expect(await textStyle(gpgHint)).toEqual(await textStyle(sshHint));
  });

  test("adds a valid SSH key and rejects an invalid key", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await newCredentialsPage(page);

    await page.goto("/en/workspace/settings?section=ssh-keys");
    await page.getByRole("button", { name: "Add SSH key" }).click();
    await page.locator('[data-mega-settings="ssh-add-title"]').fill("Work laptop");
    await page.locator('[data-mega-settings="ssh-add-key"]').fill("ssh-ed25519 AAAA valid@example.com");
    await page.locator('[data-mega-settings="ssh-add"]').click();
    await expect(page.getByText("SHA256:valid-fingerprint")).toBeVisible();

    await page.getByRole("button", { name: "Add SSH key" }).click();
    await page.locator('[data-mega-settings="ssh-add-title"]').fill("Invalid key");
    await page.locator('[data-mega-settings="ssh-add-key"]').fill("ssh-dss AAAA invalid@example.com");
    await page.locator('[data-mega-settings="ssh-add"]').click();
    await expect(page.getByText("SSH key type is not supported")).toBeVisible();
    await context.close();
  });

  test("adds and deletes GPG keys", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await newCredentialsPage(page);
    await page.goto("/en/workspace/settings?section=ssh-keys");
    await expect(page.getByText("ABC123")).toBeVisible();
    await page.getByRole("button", { name: "Add GPG key" }).click();
    await page.getByLabel("Key", { exact: true }).fill("synthetic public GPG key");
    await page.locator('[data-mega-settings="gpg-add-form"]').getByRole("button", { name: "Add GPG key" }).click();
    await expect(page.getByText("DEF456")).toBeVisible();
    const gpgCard = page.locator('[data-mega-settings="gpg-row"]').filter({ hasText: "ABC123" });
    await gpgCard.getByRole("button", { name: "Delete" }).first().click();
    await page.getByRole("heading", { name: "Delete GPG key?" }).locator('..').getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("ABC123")).toHaveCount(0);
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
