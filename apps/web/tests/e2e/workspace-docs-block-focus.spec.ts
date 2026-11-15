import { expect, test } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";
import { lexicalDocumentWithBlockTree, lexicalDocumentWithText, stubWorkspace } from "./helpers/workspace-docs-roam-fixture";

test.describe("workspace document block focus", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies(mintSessionCookies().cookies);
  });

  for (const mode of ["focused", "sidebar"] as const) {
    test(`Enter after editing a reference keeps the next line visible in ${mode}`, async ({ page }) => {
      const docId = `doc_reference_enter_${mode}`;
      const body = JSON.parse(lexicalDocumentWithText("Source text"));
      const source = body.root.children[0];
      source.blockId = "SourceBlk001";
      body.root.children.unshift({ ...source, blockId: "FocusedBlk01", children: [{
        type: "mega-block-ref", version: 1, blockRef: {
          targetDocId: docId, targetBlockId: "SourceBlk001", label: "Source text", status: "ok", binding: "document",
        },
      }] });
      await stubWorkspace(page, docId, JSON.stringify(body));
      await page.goto(`/en/workspace/docs/${docId}${mode === "focused" ? "?block=FocusedBlk01" : ""}`);
      const main = page.locator('[data-mega-docs="article"] [contenteditable="true"]');
      if (mode === "sidebar") {
        await main.locator('[data-block-id="FocusedBlk01"]').click({ button: "right", position: { x: 8, y: 8 } });
        await page.getByRole("menuitem", { name: "Open in sidebar" }).click();
      }
      const editor = mode === "sidebar" ? page.locator('[data-mega-content="block-side-panel"] [contenteditable="true"]') : main;
      const target = editor.locator('[data-block-id="FocusedBlk01"]');
      await target.locator('[data-mega-content-chip="block-ref"] a').click();
      await target.getByRole("textbox", { name: "Block reference" }).press("Enter");
      await page.keyboard.type("Visible next line");
      const child = target.locator(':scope > [data-block-id]');
      await expect(child).toHaveCount(1);
      await expect(child).toBeVisible();
      await expect(child).toHaveText("Visible next line");
      await expect(main.locator(':scope > [data-block-id]')).toHaveCount(2);
      await expect(main).toContainText("Visible next line");
    });
  }

  test("Enter from a focused leaf keeps successive new lines visible and editable", async ({ page }) => {
    const docId = "doc_roam_focus_enter";
    await stubWorkspace(page, docId, lexicalDocumentWithText("First line"));
    await page.goto(`/en/workspace/docs/${docId}?block=roam-text-block`);

    const editable = page.locator('[data-mega-docs="editor"] [contenteditable="true"]');
    const target = editable.locator('[data-block-id="roam-text-block"]');
    await expect(editable).toBeFocused();
    await editable.press("Enter");
    const children = target.locator(':scope > [data-block-id]');
    await expect(children).toHaveCount(1);
    await expect(children.first()).toBeVisible();
    await editable.pressSequentially("Second line");
    await expect(children.first()).toHaveText("Second line");

    await editable.press("Enter");
    await editable.pressSequentially("Third line");
    await expect(children).toHaveCount(2);
    await expect(children.nth(1)).toBeVisible();
    await expect(children.nth(1)).toHaveText("Third line");
    await expect(page).toHaveURL(new RegExp(`/en/workspace/docs/${docId}\\?block=roam-text-block$`));

    await editable.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/en/workspace/docs/${docId}$`));
    await expect(editable.locator('[data-block-id]')).toHaveCount(3);
    await expect(children.first()).toHaveText("Second line");
    await expect(children.nth(1)).toHaveText("Third line");
  });

  test("a block deep link enters an editable focused outline and Escape restores the document", async ({ page }) => {
    const docId = "doc_roam_block_focus";
    await stubWorkspace(page, docId, lexicalDocumentWithBlockTree());

    await page.goto(`/en/workspace/docs/${docId}?block=roam-focus-block`);

    const outliner = page.locator('[data-mega-content="outliner"]');
    await expect(outliner).toHaveAttribute("data-mega-block-focus", "roam-focus-block");
    await expect(outliner.locator('[data-mega-block-focus="target"]')).toContainText("Focused block");
    await expect(outliner.locator('[data-mega-block-focus="descendant"]')).toContainText("Focused child");
    await expect(outliner.locator('[data-block-id="roam-hidden-sibling"]')).toBeHidden();

    const editable = page.locator('[data-mega-docs="editor"] [contenteditable="true"]');
    await expect(editable).toBeFocused();
    await editable.press("Escape");

    await expect(page).toHaveURL(new RegExp(`/en/workspace/docs/${docId}$`));
    await expect(outliner).not.toHaveAttribute("data-mega-block-focus", "roam-focus-block");
    await expect(outliner.locator('[data-block-id="roam-hidden-sibling"]')).toBeVisible();
  });

  test("Focus on block opens the copied-link editing mode", async ({ page }) => {
    const docId = "doc_roam_context_focus";
    await stubWorkspace(page, docId, lexicalDocumentWithBlockTree());
    await page.goto(`/en/workspace/docs/${docId}`);

    await page.locator('[contenteditable="true"] [data-block-id="roam-focus-block"]').click({ button: "right", position: { x: 8, y: 8 } });
    await page.getByRole("menuitem", { name: "Focus on block" }).click();

    await expect(page).toHaveURL(new RegExp(`/en/workspace/docs/${docId}\\?block=roam-focus-block$`));
    await expect(page.locator('[data-mega-content="outliner"]')).toHaveAttribute("data-mega-block-focus", "roam-focus-block");
  });

  test("block actions use the compact workspace menu density", async ({ page }) => {
    const docId = "doc_roam_context_style";
    await stubWorkspace(page, docId, lexicalDocumentWithBlockTree());
    await page.goto(`/en/workspace/docs/${docId}`);

    await page.locator('[contenteditable="true"] [data-block-id="roam-focus-block"]').click({ button: "right", position: { x: 8, y: 8 } });
    const menu = page.getByRole("menu", { name: "Block actions" });
    await expect(menu).toBeVisible();

    const styles = await menu.evaluate((element) => {
      const action = element.querySelector<HTMLElement>('[data-mega-content="block-context-action"]');
      if (!action) throw new Error("Expected a context-menu action");
      const menuStyle = getComputedStyle(element);
      const actionStyle = getComputedStyle(action);
      return {
        actionMinHeight: actionStyle.minHeight,
        actionPadding: actionStyle.padding,
        borderRadius: menuStyle.borderRadius,
        fontSize: menuStyle.fontSize,
        minWidth: menuStyle.minWidth,
      };
    });

    expect(styles).toEqual({
      actionMinHeight: "28px",
      actionPadding: "0px 8px",
      borderRadius: "4px",
      fontSize: "13px",
      minWidth: "224px",
    });
  });
});
