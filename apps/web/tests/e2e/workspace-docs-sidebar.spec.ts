import { expect, test } from "@playwright/test";
import { mintSessionCookies } from "./helpers/session";
import { lexicalDocumentWithBlockTree, stubWorkspace } from "./helpers/workspace-docs-roam-fixture";

for (const locale of ["en", "zh-CN"] as const) {
  test(`${locale}: sidebar edits share live collaboration, autosave and publication`, async ({ page, context }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await context.addCookies(mintSessionCookies().cookies);
    const { data: doc } = await (await page.request.post('/api/mega/docs', { data: { title: `Sidebar live ${locale} ${Date.now()}` } })).json();
    const other = await context.newPage();
    const path = `/${locale}/workspace/docs/${doc.id}`;
    const main = page.locator('[data-mega-docs="article"] [contenteditable="true"]');
    const panel = page.locator('[data-mega-content="block-side-panel"]');
    const side = panel.locator('[contenteditable="true"]');
    try {
      await page.goto(path);
      await main.click();
      await page.keyboard.type('Original');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Keep this sibling');
      await other.goto(path);
      const observer = other.locator('[data-mega-docs="article"] [contenteditable="true"]');
      await expect(observer).toContainText('Keep this sibling');
      const first = main.locator('[data-block-id]').first();
      const blockId = await first.getAttribute('data-block-id');
      await first.click({ button: 'right' });
      await page.getByRole('menuitem', { name: locale === 'en' ? 'Open in sidebar' : '在侧栏打开', exact: true }).click();
      await expect(side).toBeVisible();
      await expect(side.locator(`[data-block-id="${blockId}"]`)).toBeVisible();
      await expect(side.getByText('Keep this sibling', { exact: true })).toBeHidden();
      await side.press('End');
      await page.keyboard.type(' from sidebar');
      await expect(main).toContainText('Original from sidebar');
      await expect(observer).toContainText('Original from sidebar');
      await expect(side).toBeFocused();
      await first.click();
      await page.keyboard.press('End');
      await page.keyboard.type(' from main');
      await expect(side).toContainText('Original from sidebar from main');
      await expect(main).toBeFocused();
      await side.locator(`[data-block-id="${blockId}"]`).click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Visible child');
      await expect(side.getByText('Visible child', { exact: true })).toBeVisible();
      await expect(main).toContainText('Visible child');
      await expect(observer).toContainText('Visible child');
      // Publish immediately: the owner must flush the sidebar's latest edit.
      await page.getByRole('button', { name: locale === 'en' ? 'Publish' : '发布', exact: true }).click();
      await expect(page.getByRole('button', { name: locale === 'en' ? 'Return to draft' : '撤回为草稿', exact: true })).toBeVisible();
      const { data: saved } = await (await page.request.get(`/api/mega/docs/${doc.id}`)).json();
      expect(saved.body).toContain('Keep this sibling');
      expect(saved.versions[0].body).toContain('Visible child');
      await page.reload();
      await expect(main).toContainText('Original from sidebar from main');
      await expect(main).toContainText('Visible child');
    } finally {
      await other.close();
      await page.goto(`/${locale}/workspace/docs`);
      expect((await page.request.post(`/api/mega/docs/${doc.id}/delete`)).ok()).toBe(true);
    }
  });
}

test('sidebar uses balanced sizing, pointer and keyboard resizing, and local edits survive close/reopen', async ({ page, context }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await context.addCookies(mintSessionCookies().cookies);
  const id = 'doc_sidebar_layout';
  await stubWorkspace(page, id, lexicalDocumentWithBlockTree());
  await page.goto(`/en/workspace/docs/${id}`);
  const main = page.locator('[data-mega-docs="article"] [contenteditable="true"]');
  const open = async () => {
    await main.locator('[data-block-id="roam-focus-block"]').click({ button: 'right', position: { x: 8, y: 8 } });
    await page.getByRole('menuitem', { name: 'Open in sidebar' }).click();
  };
  await open();
  const panel = page.locator('[data-mega-content="block-side-panel"]');
  const side = panel.locator('[contenteditable="true"]');
  const separator = page.getByRole('separator', { name: 'Resize block sidebar' });
  await expect(separator).toHaveAttribute('aria-valuenow', '45');
  const bounds = await separator.boundingBox();
  if (!bounds) throw new Error('Missing separator');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 100, bounds.y + 100, { steps: 5 });
  await page.mouse.up();
  const resized = await separator.getAttribute('aria-valuenow');
  expect(Number(resized)).toBeGreaterThan(45);
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await open();
  await expect(separator).toHaveAttribute('aria-valuenow', resized);
  await separator.press('Home');
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow')) - Number(await separator.getAttribute('aria-valuemin'))).toBe(0);
  await separator.press('End');
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow')) - Number(await separator.getAttribute('aria-valuemax'))).toBe(0);
  await separator.dblclick();
  await expect(separator).toHaveAttribute('aria-valuenow', '45');
  await side.locator('[data-block-id="roam-focus-block"]').click({ position: { x: 50, y: 10 } });
  await page.keyboard.press('Home');
  await page.keyboard.type('Local sidebar: ');
  await expect(main).toContainText('Local sidebar: Focused block');
  await side.press('ControlOrMeta+z');
  await expect(main).not.toContainText('Local sidebar: ');
  await side.press('ControlOrMeta+Shift+z');
  await expect(main).toContainText('Local sidebar: ');
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await open();
  await expect(side).toContainText('Local sidebar: Focused block');
  // A narrow viewport stacks panes rather than shrinking either editor away.
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(side).toBeVisible();
  await expect(separator).toHaveCount(0);
  await expect(main).toBeVisible();
});
