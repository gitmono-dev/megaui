import { expect, test } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";
import { stubWorkspace } from "./helpers/workspace-docs-roam-fixture";

const text = (value: string) => ({ detail: 0, format: 0, mode: "normal", style: "", text: value, type: "text", version: 1 });
const block = (blockId: string, value: string, children: readonly object[] = []) => ({
  type: "mega-block", version: 1, blockId, variant: "text", collapsed: false, todoChecked: false,
  children: [text(value), ...children], direction: null, format: "", indent: 0,
});

const nestedDocument = JSON.stringify({
  root: {
    type: "root", version: 1, direction: null, format: "", indent: 0,
    children: [block("parent", "Parent", [block("child", "Child", [block("leaf", "Delete me")])])],
  },
});

test.describe("workspace outline deletion and block-reference appearance", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies(mintSessionCookies().cookies);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  });

  test("Copy block ID pastes an inline reference with editable syntax and trailing text", async ({ page }) => {
    const docId = "doc_inline_block_ref";
    const blockId = "zK7QQWAdv_12";
    const body = JSON.stringify({ root: {
      type: "root", version: 1, direction: null, format: "", indent: 0,
      children: [block(blockId, "Sequence number dependency"), block("target-row", ""), block("after-row", "Next row")],
    } });
    const saves: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`/docs/${docId}/save`) && request.method() === "POST") saves.push(request.postData() ?? "");
    });
    await stubWorkspace(page, docId, body);
    await page.route("**/api/mega/blocks/resolve**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      targetDocId: docId, targetBlockId: blockId, label: "Sequence number dependency", status: "ok",
    } }) }));
    await page.goto(`/en/workspace/docs/${docId}`);
    await page.locator(`[data-block-id="${blockId}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Copy block ref/ }).hover();
    await page.getByRole("menuitem", { name: "Copy block ID", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`((${blockId}))`);
    const row = page.locator('[data-mega-block][data-block-id="target-row"]');
    await row.click();
    await page.keyboard.press("ControlOrMeta+V");
    await expect(row.locator('[data-mega-content-chip="block-ref"]')).toBeVisible();
    await page.keyboard.type(" More on this line");
    await page.getByRole("heading", { level: 1 }).click();
    await expect(row.locator('[data-mega-content="block-ref"]')).toHaveText("Sequence number dependency");
    await expect(row).toContainText("More on this line");
    await row.getByText(" More on this line", { exact: true }).click();
    await expect(row.locator('[data-mega-content="block-ref"]')).toHaveText(`((${blockId}))`);
    await page.getByRole("heading", { level: 1 }).click();
    await row.locator('[data-mega-content="block-ref"] a').click();
    const syntax = row.getByRole("textbox", { name: "Block reference", exact: true });
    await expect(syntax).toHaveValue(`((${blockId}))`);
    await syntax.press("End");
    await syntax.press("ArrowRight");
    await expect(page.locator('[data-mega-content="content-editable"]')).toBeFocused();
    await page.keyboard.type(" Added");
    await page.getByRole("heading", { level: 1 }).click();
    await expect(row).toContainText("Added");
    await expect(row.locator('[data-mega-content="block-ref"]')).toHaveText("Sequence number dependency");
    await expect(page.locator('[data-mega-content="embed-block"]')).toHaveCount(0);
    await expect(page.locator(`[data-block-id="${blockId}"]`)).toHaveText("Sequence number dependency");
    await expect.poll(() => saves.some(saved => saved.includes('mega-block-ref') && saved.includes('More on this line') && saved.includes('Added'))).toBe(true);
    const saved = [...saves].reverse().find(value => value.includes('Added'))!;
    await stubWorkspace(page, docId, (JSON.parse(saved) as { body: string }).body);
    await page.reload();
    await expect(row.locator('[data-mega-content="block-ref"]')).toHaveText("Sequence number dependency");
    await expect(row).toContainText("More on this line");
    await expect(row).toContainText("Added");
  });

  test("plain reference syntax resolves across documents and preserves surrounding text", async ({ page }) => {
    await stubWorkspace(page, "doc_plain_inline_ref");
    await page.route("**/api/mega/blocks/resolve**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      targetDocId: "remote-doc", targetBlockId: "remote-block", label: "Cross-document source", status: "ok",
    } }) }));
    await page.goto("/en/workspace/docs/doc_plain_inline_ref");
    const editable = page.locator('[data-mega-content="content-editable"]');
    await editable.click();
    await page.keyboard.type("Before ((remote-block)) after");
    await page.getByRole("heading", { level: 1 }).click();
    const reference = page.locator('[data-mega-content="block-ref"] a');
    await expect(reference).toHaveText("Cross-document source");
    await expect(reference).toHaveAttribute("href", "/workspace/docs/remote-doc?block=remote-block");
    await expect(editable).toContainText("Before ");
    await expect(editable).toContainText(" after");
    await expect(editable.locator(":scope > [data-mega-block]")).toHaveCount(1);
  });

  test("deleting nested text keeps each guide ending at its direct child bullet", async ({ page }) => {
    await stubWorkspace(page, "doc_delete_layout", nestedDocument);
    await page.goto("/en/workspace/docs/doc_delete_layout");

    const leaf = page.locator('[data-mega-block][data-block-id="leaf"]');
    await leaf.click();
    await page.keyboard.press("End");
    for (let index = 0; index < "Delete me".length; index += 1) {
      await page.keyboard.press("Backspace");
    }
    await expect(leaf).toBeEmpty();

    const guides = await page.evaluate(() => {
      return ["child", "leaf"].map((blockId) => {
        const element = document.querySelector<HTMLElement>(`[data-mega-block][data-block-id="${blockId}"]`);
        if (!element) throw new Error(`Expected ${blockId} outline block`);
        const guide = getComputedStyle(element, "::after");
        const bullet = getComputedStyle(element, "::before");
        const top = element.getBoundingClientRect().top;
        const guideEnd = top + Number.parseFloat(guide.top) + Number.parseFloat(guide.height);
        const bulletCenter = top + Number.parseFloat(bullet.top) + Number.parseFloat(bullet.height) / 2;
        return { blockId, content: guide.content, tail: guideEnd - bulletCenter };
      });
    });
    for (const guide of guides) {
      expect(guide.content, `${guide.blockId} must draw its parent guide`).not.toBe("none");
      expect(Math.abs(guide.tail), `${guide.blockId} guide misses its own bullet by ${guide.tail}px`).toBeLessThanOrEqual(3);
    }
  });

  test("a selected (( block reference is visibly distinct from ordinary text", async ({ page }) => {
    await stubWorkspace(page, "doc_block_ref_style");
    await page.goto("/en/workspace/docs/doc_block_ref_style");
    const editable = page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first();
    await editable.click();
    await page.keyboard.type("((reference");
    await page.locator('[data-mega-content="block-ref-option"]').first().click();
    await page.getByRole("heading", { level: 1 }).click();

    const ref = page.locator('[data-mega-content="block-ref"] a');
    await expect(ref).toHaveText("Referenced block");
    const appearance = await ref.evaluate((link) => {
      const editor = document.querySelector('[data-mega-content="content-editable"]');
      if (!editor) throw new Error("Expected document editor");
      return {
        color: getComputedStyle(link).color,
        textDecorationStyle: getComputedStyle(link).textDecorationStyle,
        editorColor: getComputedStyle(editor).color,
      };
    });
    expect(appearance.color, "block reference should use the accent color").not.toBe(appearance.editorColor);
    expect(appearance.textDecorationStyle, "block reference should have a dotted reference underline").toBe("dotted");
  });
});
