import { expect, test } from "@playwright/test";
import { mintSessionCookies } from "./helpers/session";

const e2eOrigin = new URL(process.env.E2E_BASE_URL?.trim() || "http://127.0.0.1:3000").origin;
const csrfHeaders = { Origin: e2eOrigin };

for (const locale of ["en", "zh-CN"] as const) {
  test(`${locale}: publishes the latest editor content, persists status, and returns to draft`, async ({ page, context }) => {
    await context.addCookies(mintSessionCookies().cookies);
    const created = await page.request.post("/api/mega/docs", { headers: csrfHeaders, data: { title: `Publication ${locale} ${Date.now()}` } });
    expect(created.ok()).toBe(true);
    const { data: doc } = await created.json();
    const publish = locale === "en" ? "Publish" : "发布";
    const unpublish = locale === "en" ? "Return to draft" : "撤回为草稿";
    const badge = page.locator('[data-mega-docs="article"]');
    try {
      await page.goto(`/${locale}/workspace/docs/${doc.id}`);
      const editor = page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first();
      await editor.click();
      await page.keyboard.type("Latest content before publication");
      await expect(page.getByRole("button", { name: publish, exact: true })).toBeEnabled();
      await page.getByRole("button", { name: publish, exact: true }).click();
      await expect(badge).toContainText(locale === "en" ? "Published" : "已发布");
      const { data: published } = await (await page.request.get(`/api/mega/docs/${doc.id}`)).json();
      expect(published.status).toBe("published");
      expect(published.versions).toHaveLength(2);
      expect(published.versions[0].body).toContain("Latest content before publication");
      await editor.click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type(" live edit after publication");
      await expect.poll(async () => {
        const { data } = await (await page.request.get(`/api/mega/docs/${doc.id}`)).json();
        return data.body.includes("live edit after publication") && data.status === "published" &&
          !data.versions[0].body.includes("live edit after publication");
      }).toBe(true);
      await page.reload();
      await expect(page.getByRole("button", { name: unpublish, exact: true })).toBeVisible();
      await expect(editor).toContainText("Latest content before publication");
      await page.screenshot({path: test.info().outputPath(`published-${locale}.png`)});
      await page.getByRole("button", { name: unpublish, exact: true }).click();
      await expect(badge).toContainText(locale === "en" ? "Draft" : "草稿");
      await page.reload();
      await expect(page.getByRole("button", { name: publish, exact: true })).toBeVisible();
      await page.goto(`/${locale}/workspace/docs/${doc.id}?v=2`);
      await expect(page.getByRole("button", { name: publish, exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: unpublish, exact: true })).toHaveCount(0);
      await page.route(`**/api/mega/docs/${doc.id}`, async route => {
        const response = await route.fetch();
        const body = await response.json();
        body.data.canEdit = false;
        await route.fulfill({ response, json: body });
      });
      await page.goto(`/${locale}/workspace/docs/${doc.id}`);
      await expect(page.locator('[data-mega-docs="article"]')).toBeVisible();
      await expect(page.locator('[data-mega-docs="publication"]')).toHaveCount(0);
      await expect(page.locator('[data-mega-docs="editor"]')).toHaveCount(0);
    } finally {
      await page.goto(`/${locale}/workspace/docs`);
      expect((await page.request.post(`/api/mega/docs/${doc.id}/delete`, { headers: csrfHeaders })).ok()).toBe(true);
    }
  });
}

test("publication failure keeps the draft and allows retry; failed saves prevent publication", async ({ page, context }) => {
  await context.addCookies(mintSessionCookies().cookies);
  const { data: doc } = await (await page.request.post("/api/mega/docs", { headers: csrfHeaders, data: { title: `Publication failure ${Date.now()}` } })).json();
  const fail = { status: 503, json: { ok: false, error: { code: "MEGA_INTERNAL_ERROR", message: "Unavailable" } } };
  let publications = 0;
  await page.route(`**/api/mega/docs/${doc.id}/publish`, async route => { publications++; await route.fulfill(fail); });
  try {
    await page.goto(`/en/workspace/docs/${doc.id}`);
    const editor = page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first();
    await editor.click();
    await page.keyboard.type("Do not lose this draft");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText("Could not publish the document. Please try again.", { exact: true })).toBeVisible();
    await expect(page.locator('[data-mega-docs="article"]')).toContainText("Draft");
    expect(publications).toBe(1);
    await page.route(`**/api/mega/docs/${doc.id}/save`, route => route.fulfill(fail));
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" unsaved edit");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();
    expect(publications).toBe(1);
    await expect(editor).toContainText("unsaved edit");
    await page.unroute(`**/api/mega/docs/${doc.id}/save`);
    await page.unroute(`**/api/mega/docs/${doc.id}/publish`);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("button", { name: "Return to draft", exact: true })).toBeVisible();
    const { data: saved } = await (await page.request.get(`/api/mega/docs/${doc.id}`)).json();
    expect(saved.versions[0].body).toContain("unsaved edit");
  } finally {
    await page.goto('/en/workspace/docs');
    expect((await page.request.post(`/api/mega/docs/${doc.id}/delete`, { headers: csrfHeaders })).ok()).toBe(true);
  }
});
