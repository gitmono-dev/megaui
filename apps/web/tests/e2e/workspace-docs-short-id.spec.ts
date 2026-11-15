import { expect, test } from "@playwright/test";
import { mintSessionCookies } from "./helpers/session";

type ContentNode = { type?: string; blockId?: string; sourceBlockId?: string; children?: ContentNode[]; blockRef?: { targetBlockId: string } };
const walk = (node: ContentNode): ContentNode[] => [node, ...(node.children ?? []).flatMap(walk)];

test("12-character block IDs survive creation, splitting, table insertion, copying and saved references", async ({ page, context }) => {
  await context.addCookies(mintSessionCookies().cookies);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const created = await page.request.post("/api/mega/docs", { data: { title: `Short ID verification ${Date.now()}` } });
  expect(created.ok()).toBe(true);
  const { data: doc } = await created.json() as { data: { id: string; body: string } };
  const initial = JSON.parse(doc.body) as { root: ContentNode };
  const sourceId = initial.root.children?.[0]?.blockId;
  expect(sourceId).toMatch(/^[A-Za-z0-9_-]{12}$/);
  try {
    await page.goto(`/en/workspace/docs/${doc.id}`);
    const editor = page.locator('[data-mega-docs="editor"]');
    const source = editor.locator(`[data-block-id="${sourceId}"]`);
    await source.click();
    await page.keyboard.type("Short ID source");
    await page.keyboard.press("Enter");
    const second = editor.locator('[data-mega-block]').nth(1);
    const secondId = await second.getAttribute("data-block-id");
    expect(secondId).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(secondId).not.toBe(sourceId);
    await source.click({ button: "right" });
    await page.getByRole("menuitem", { name: /Copy block ref/ }).hover();
    await page.getByRole("menuitem", { name: "Copy block ID", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`((${sourceId}))`);
    await second.click();
    await page.keyboard.press("ControlOrMeta+V");
    await expect(second.locator('[data-mega-content-chip="block-ref"]')).toBeVisible();
    await page.keyboard.type(" suffix");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/table");
    await page.getByRole("option", { name: "Table", exact: true }).click();
    await expect(editor.locator('[data-mega-outline-table] td')).toHaveCount(4);
    await page.getByRole("heading", { level: 1 }).click();

    let saved!: { root: ContentNode };
    await expect.poll(async () => {
      const response = await page.request.get(`/api/mega/docs/${doc.id}`);
      const payload = await response.json() as { data: { body: string } };
      saved = JSON.parse(payload.data.body) as { root: ContentNode };
      return walk(saved.root).some(node => node.type === "mega-outline-table") &&
        walk(saved.root).some(node => node.blockRef?.targetBlockId === sourceId);
    }, { timeout: 20_000 }).toBe(true);
    const nodes = walk(saved.root);
    const ids = nodes.flatMap(node => node.blockId ? [node.blockId] : []);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    for (const node of nodes) if (node.sourceBlockId) expect(ids).toContain(node.sourceBlockId);

    await page.reload();
    await expect(editor.locator(`[data-block-id="${secondId}"]`)).toContainText("Short ID source");
    await expect(editor.locator(`[data-block-id="${secondId}"]`)).toContainText("suffix");
    await expect(editor.locator('[data-mega-outline-table] td')).toHaveCount(4);
    await editor.locator(`[data-block-id="${secondId}"] [data-mega-content="block-ref"] a`).click();
    await expect(page.getByRole("textbox", { name: "Block reference", exact: true })).toHaveValue(`((${sourceId}))`);
    await editor.screenshot({ path: test.info().outputPath("short-block-reference.png") });
    expect(errors).toEqual([]);
  } finally {
    await page.goto("/en/workspace/docs");
    const deleted = await page.request.post(`/api/mega/docs/${doc.id}/delete`);
    expect(deleted.ok()).toBe(true);
  }
});
