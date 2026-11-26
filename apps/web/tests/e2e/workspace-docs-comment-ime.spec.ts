import { expect, test } from "@playwright/test";
import { mintSessionCookies } from "./helpers/session";

const e2eOrigin = new URL(process.env.E2E_BASE_URL?.trim() || "http://127.0.0.1:3000").origin;
const csrfHeaders = { Origin: e2eOrigin };

for (const mode of ['full document', 'focused block', 'sidebar'] as const) {
  test(`Chinese comment composition keeps focus and scroll (${mode})`, async ({ page, context }) => {
    test.setTimeout(60_000);
    await context.addCookies(mintSessionCookies().cookies);
    const created = await page.request.post('/api/mega/docs', { headers: csrfHeaders, data: { title: `Comment IME ${mode} ${Date.now()}` } });
    expect(created.ok()).toBe(true);
    const { data: doc } = await created.json();
    const children = Array.from({ length: 40 }, (_, index) => ({
      type: 'mega-block', version: 1, blockId: `commentRow${String(index).padStart(2, '0')}`, variant: 'text', collapsed: false, todoChecked: false,
      children: [{ type: 'text', version: 1, text: `Document content ${index}`, detail: 0, format: 0, mode: 'normal', style: '' }],
      direction: null, format: '', indent: 0,
    }));
    const body = JSON.stringify({ root: { type: 'root', version: 1, children, direction: null, format: '', indent: 0 } });
    expect((await page.request.post(`/api/mega/docs/${doc.id}/save`, { headers: csrfHeaders, data: { body } })).ok()).toBe(true);
    const cdp = await context.newCDPSession(page);
    try {
      await page.goto(`/en/workspace/docs/${doc.id}${mode === 'focused block' ? '?block=commentRow00' : ''}`);
      const editor = page.locator('[data-mega-docs="article"] [contenteditable="true"]');
      await expect(editor).toContainText('Document content 0');
      await editor.locator('[data-block-id="commentRow00"]').click();
      if (mode === 'sidebar') {
        await editor.locator('[data-block-id="commentRow00"]').click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Open in sidebar' }).click();
        await expect(page.locator('[data-mega-docs="sidebar-editor"] [contenteditable="true"]')).toBeFocused();
      }
      const comment = page.locator('[data-mega-docs="comment-draft"]');
      await comment.click();
      const before = await comment.evaluate(element => element.getBoundingClientRect().top);
      for (const text of ['z', 'zhong', '中文']) {
        await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
        await expect(comment).toBeFocused();
        await expect(comment).toHaveValue(text);
        expect(Math.abs(await comment.evaluate(element => element.getBoundingClientRect().top) - before)).toBeLessThan(3);
      }
      await cdp.send('Input.insertText', { text: '中文评论' });
      await expect(comment).toHaveValue('中文评论');
      await expect(comment).toBeFocused();
      await page.keyboard.press('Enter');
      await cdp.send('Input.insertText', { text: '第二行' });
      await page.keyboard.type(' English');
      await expect(comment).toHaveValue('中文评论\n第二行 English');
      await expect(comment).toBeFocused();
      await page.getByRole('button', { name: 'Comment', exact: true }).click();
      await expect(page.locator('[data-mega-docs="comment"]')).toContainText('中文评论');
      await expect(comment).toHaveValue('');
      const { data: saved } = await (await page.request.get(`/api/mega/docs/${doc.id}`)).json();
      expect(JSON.parse(saved.body).root.children).toHaveLength(40);
      expect(saved.body).not.toContain('中文');
      expect(saved.body).not.toContain('English');
    } finally {
      await cdp.detach();
      await page.goto('/en/workspace/docs');
      expect((await page.request.post(`/api/mega/docs/${doc.id}/delete`, { headers: csrfHeaders })).ok()).toBe(true);
    }
  });
}
