import { expect, test } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";
import { lexicalDocumentWithBlockTree, stubWorkspace } from "./helpers/workspace-docs-roam-fixture";

test("Shift+Tab outdents a nested block and keeps the typing focus in it", async ({ context, page }) => {
  // Given: a nested block is being edited in a document.
  await context.addCookies(mintSessionCookies().cookies);
  await stubWorkspace(page, "doc_roam_outdent_focus", lexicalDocumentWithBlockTree());
  await page.goto("/en/workspace/docs/doc_roam_outdent_focus");
  const editor = page.locator('[data-mega-content="content-editable"]');
  const child = editor.locator('[data-block-id="roam-focused-child"]');
  await child.click();
  await expect(editor).toBeFocused();

  // When: the author moves the selected block left by one level.
  await page.keyboard.press("Shift+Tab");

  // Then: the block is a root sibling, and typing still targets the editor.
  await expect(editor.locator(':scope > [data-block-id="roam-focused-child"]')).toBeVisible();
  await expect(editor).toBeFocused();
  await expect.poll(() => child.evaluate((element) => element.contains(window.getSelection()?.anchorNode ?? null)))
    .toBe(true);
});
