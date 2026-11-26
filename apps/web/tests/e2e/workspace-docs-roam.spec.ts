import { expect, test } from "@playwright/test";

import { e2eBaseURL } from "./helpers/base-url";
import { mintSessionCookies } from "./helpers/session";
import { lexicalDocumentWithBlockTree, lexicalDocumentWithText, stubWorkspace } from "./helpers/workspace-docs-roam-fixture";

test.describe("workspace docs writable outliner (FIX-RO-02 through FIX-RO-07)", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies(mintSessionCookies().cookies);
  });

  test("empty writer shows a block hint, keeps hierarchy, and isolates the snapshot reader", async ({ page }) => {
    const docId = "doc_roam_outliner";
    await stubWorkspace(page, docId);

    await page.goto(`/en/workspace/docs/${docId}`);
    await expect(page.locator('[data-mega-docs="page-write"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="editor"]')).toBeVisible({ timeout: 20_000 });

    const hint = page.locator('[data-mega-docs="empty-block-hint"]');
    const blocks = page.locator('[data-mega-content="outliner"] [data-mega-block]');
    await expect(hint).toBeVisible();
    await expect(page.locator('[data-mega-docs="empty-body"]')).toHaveCount(0);
    await expect(blocks).toHaveCount(1);
    const firstBlockHasBullet = await blocks.first().evaluate((element) => {
      const bullet = getComputedStyle(element, "::before");
      return bullet.width !== "auto" && bullet.backgroundColor !== "rgba(0, 0, 0, 0)";
    });
    expect(firstBlockHasBullet).toBe(true);
    await expect(blocks.first()).toHaveCSS("font-size", "14px");
    await expect(blocks.first()).toHaveCSS("line-height", "22px");

    const editable = page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first();
    await editable.click();
    const editorSurfaceVisuals = await editable.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        backgroundColor: styles.backgroundColor,
        borderTopWidth: styles.borderTopWidth,
        boxShadow: styles.boxShadow,
        outlineStyle: styles.outlineStyle,
      };
    });
    expect(editorSurfaceVisuals).toEqual({
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderTopWidth: "0px",
      boxShadow: "none",
      outlineStyle: "none",
    });
    await page.keyboard.type("First block");
    await expect(hint).toBeHidden();
    const focusedBlockVisuals = await blocks.first().evaluate((element) => {
      const styles = getComputedStyle(element);
      return { backgroundColor: styles.backgroundColor, boxShadow: styles.boxShadow, outlineStyle: styles.outlineStyle };
    });
    expect(focusedBlockVisuals).toEqual({ backgroundColor: "rgba(0, 0, 0, 0)", boxShadow: "none", outlineStyle: "none" });
    await page.keyboard.press("Enter");
    await page.keyboard.type("Nested block");
    await page.keyboard.press("Tab");
    await expect(blocks).toHaveCount(2);
    const nestedMargin = await blocks.nth(1).evaluate((element) => getComputedStyle(element).marginLeft);
    expect(Number.parseFloat(nestedMargin)).toBeGreaterThan(0);

    await page.goto(`/en/workspace/docs/${docId}?v=1`);
    await expect(page.locator('[data-mega-docs="detail"]')).toBeVisible();
    await expect(hint).toHaveCount(0);
    await expect(page.locator('[data-mega-content="outliner"]')).toHaveCount(0);
  });

  test("quick commands match the block context menu and hand off to the page reference trigger", async ({ page }) => {
    const docId = "doc_roam_quick_commands";
    await stubWorkspace(page, docId);
    await page.goto(`/en/workspace/docs/${docId}`);
    const editable = page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first();
    const menuStyle = (menu: ReturnType<typeof page.locator>) => menu.evaluate((element) => {
      const style = getComputedStyle(element);
      const action = element.querySelector('[data-mega-content="block-context-action"], [data-mega-content="quick-command-option"]');
      if (!action) throw new Error("Missing menu action");
      const row = getComputedStyle(action);
      return {
        background: style.backgroundColor, border: style.border, radius: style.borderRadius,
        shadow: style.boxShadow, font: style.font, padding: style.padding,
        width: element.getBoundingClientRect().width,
        rowFont: row.font, rowHeight: row.minHeight, rowPadding: row.padding,
      };
    });
    await editable.locator('[data-block-id]').first().click({ button: "right" });
    const contextMenu = page.getByRole("menu", { name: "Block actions" });
    await expect(contextMenu).toBeVisible();
    const contextStyle = await menuStyle(contextMenu);
    const contextAction = contextMenu.locator('[data-mega-content="block-context-action"]').first();
    await contextAction.hover();
    const highlight = await contextAction.evaluate(element => getComputedStyle(element).backgroundColor);
    await page.keyboard.press("Escape");
    await editable.click();
    await page.keyboard.type("/");

    const quickCommands = page.locator('[data-mega-content="quick-command-menu"]');
    await expect(quickCommands).toBeVisible();
    await expect(quickCommands).toContainText("TODO");
    await expect(quickCommands).toContainText("Page reference");
    await expect(quickCommands).toContainText("Block reference");
    await expect(quickCommands).toContainText("Tag page");
    await expect(quickCommands).toContainText("Table");
    await expect(quickCommands).toContainText("Image");

    expect(await menuStyle(quickCommands)).toEqual(contextStyle);
    await expect(quickCommands.locator('[aria-selected="true"]')).toHaveCSS("background-color", highlight);
    await expect(quickCommands.locator('[data-mega-content="quick-command-shortcut"]')).toHaveText(["⌘↵", "2 × 2", "↥", "[[", "((", "#"]);

    await quickCommands.getByRole("option", { name: "Page reference" }).click();
    await expect(page.locator('[data-mega-content="wikilink-menu"]')).toBeVisible();
  });

  test("Enter chooses the first quick command and changes the current block to TODO", async ({ page }) => {
    const docId = "doc_roam_quick_todo";
    await stubWorkspace(page, docId);
    await page.goto(`/en/workspace/docs/${docId}`);
    const hint = page.locator('[data-mega-docs="empty-block-hint"]');
    await expect(hint).toBeVisible();
    const editable = page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first();
    await editable.click();
    await page.keyboard.type("/");

    await expect(page.locator('[data-mega-content="quick-command-option"]').first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-mega-content="outliner"] [data-mega-block="todo"]')).toHaveCount(1);
    await expect(hint).toHaveCount(0);
  });

  test("TODO blocks expose a checkbox that persists the checked state in the editable outline", async ({ page }) => {
    const docId = "doc_roam_todo_checkbox";
    await stubWorkspace(page, docId);
    await page.goto(`/en/workspace/docs/${docId}`);
    const editable = page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first();
    await editable.click();
    await page.keyboard.type("/");
    await expect(page.locator('[data-mega-content="quick-command-option"]').first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");

    const todo = page.locator('[data-mega-content="outliner"] [data-mega-block="todo"]');
    await expect(todo).toHaveCount(1);
    const checkbox = page.getByRole("button", { name: "Mark TODO complete" });
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toHaveAttribute("data-mega-content", "todo-check");
    await expect(checkbox).toHaveAttribute("aria-pressed", "false");
    const todoVisuals = await todo.evaluate((block) => {
      const checkboxElement = document.querySelector<HTMLElement>('[data-mega-content="todo-check"]');
      if (!checkboxElement) throw new Error("Expected the TODO checkbox");
      const checkboxStyles = getComputedStyle(checkboxElement);
      const checkboxRect = checkboxElement.getBoundingClientRect();
      const blockRect = block.getBoundingClientRect();
      const bullet = getComputedStyle(block, "::before");
      return {
        bulletDisplay: bullet.display,
        bulletLeft: Number.parseFloat(bullet.left),
        bulletWidth: Number.parseFloat(bullet.width),
        checkboxHeight: checkboxStyles.height,
        checkboxOffset: checkboxRect.left - blockRect.left,
        checkboxWidth: checkboxStyles.width,
        centerDelta: Math.abs(
          checkboxRect.top + checkboxRect.height / 2 - (blockRect.top + blockRect.height / 2),
        ),
      };
    });
    expect(todoVisuals).toMatchObject({ checkboxHeight: "14px", checkboxWidth: "14px", bulletDisplay: "block" });
    expect(Math.abs(todoVisuals.checkboxOffset - todoVisuals.bulletLeft)).toBeLessThanOrEqual(1);
    expect(todoVisuals.centerDelta).toBeLessThanOrEqual(1);
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Mark TODO incomplete" })).toHaveAttribute("aria-pressed", "true");
    await expect(todo).toHaveAttribute("data-todo-checked", "true");
  });

  test("Backspace at the start of a TODO removes its checkbox and keeps the block text", async ({ page }) => {
    const docId = "doc_roam_remove_todo_checkbox";
    await stubWorkspace(page, docId);
    await page.goto(`/en/workspace/docs/${docId}`);
    const editable = page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first();
    await editable.click();
    await page.keyboard.type("/");
    await expect(page.locator('[data-mega-content="quick-command-option"]').first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");

    const blocks = page.locator('[data-mega-content="outliner"] [data-mega-block]');
    await expect(blocks.first()).toHaveAttribute("data-mega-block", "todo");
    await page.keyboard.press("Backspace");
    await expect(blocks.first()).toHaveAttribute("data-mega-block", "text");
    await expect(page.locator('[data-mega-content="todo-check"]')).toHaveCount(0);

    await page.keyboard.type("Keep this task");
    await blocks.first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Make TODO" }).click();
    await expect(blocks.first()).toHaveAttribute("data-mega-block", "todo");
    await blocks.first().click({ position: { x: 90, y: 16 } });
    await page.keyboard.press("Meta+ArrowLeft");
    const caret = await page.evaluate(() => ({
      active: document.activeElement?.getAttribute("contenteditable"),
      offset: window.getSelection()?.anchorOffset,
      text: window.getSelection()?.anchorNode?.textContent,
    }));
    expect(caret).toEqual({ active: "true", offset: 0, text: "Keep this task" });
    // Let Lexical synchronize the browser selection before dispatching Backspace.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.keyboard.press("Backspace");
    await expect(blocks.first()).toHaveAttribute("data-mega-block", "text");
    await expect(blocks.first()).toContainText("Keep this task");
    await expect(page.locator('[data-mega-content="todo-check"]')).toHaveCount(0);
  });

  test("hovering a parent bullet reveals an arrow that collapses and expands its children", async ({ page }) => {
    const docId = "doc_roam_fold_bullet";
    await stubWorkspace(page, docId, lexicalDocumentWithBlockTree());
    await page.goto(`/en/workspace/docs/${docId}`);

    const parent = page.locator('[data-mega-block][data-block-id="roam-focus-block"]');
    const child = page.locator('[data-mega-block][data-block-id="roam-focused-child"]');
    const sibling = page.locator('[data-mega-block][data-block-id="roam-hidden-sibling"]');
    const arrow = page.locator('[data-mega-content="collapse-toggle"][data-block-id="roam-focus-block"]');
    await expect(arrow).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-mega-content="collapse-toggle"][data-block-id="roam-hidden-sibling"]')).toHaveCount(0);
    await expect(arrow).toHaveCSS("opacity", "0");
    const expandedBullet = await parent.evaluate((block) => getComputedStyle(block, "::before").boxShadow);
    expect(expandedBullet).toBe("none");

    const bullet = await parent.evaluate((block) => {
      const rect = block.getBoundingClientRect();
      const style = getComputedStyle(block, "::before");
      return {
        x: rect.left + Number.parseFloat(style.left) + Number.parseFloat(style.width) / 2,
        y: rect.top + Number.parseFloat(style.top) + Number.parseFloat(style.height) / 2,
      };
    });
    await page.mouse.move(bullet.x, bullet.y);
    await expect(arrow).toHaveCSS("opacity", "1");
    const arrowRect = await arrow.boundingBox();
    expect(arrowRect).not.toBeNull();
    expect(arrowRect!.x + arrowRect!.width).toBeLessThan(bullet.x);

    await arrow.click();
    await expect(parent).toHaveAttribute("data-collapsed", "true");
    await expect(arrow).toHaveAttribute("aria-expanded", "false");
    const collapsedBullet = await parent.evaluate((block) => getComputedStyle(block, "::before").boxShadow);
    expect(collapsedBullet).toContain("4px");
    await expect(child).toBeHidden();
    await expect(sibling).toBeVisible();

    await arrow.click();
    await expect(parent).not.toHaveAttribute("data-collapsed", "true");
    await expect(arrow).toHaveAttribute("aria-expanded", "true");
    const reopenedBullet = await parent.evaluate((block) => getComputedStyle(block, "::before").boxShadow);
    expect(reopenedBullet).toBe("none");
    await expect(child).toBeVisible();
  });

  test("block context menu hides the raw ID and exposes Roam-style block actions", async ({ context, page }) => {
    const docId = "doc_roam_block_context_menu";
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: e2eBaseURL() });
    await stubWorkspace(page, docId);
    await page.goto(`/en/workspace/docs/${docId}`);

    const block = page.locator('[data-mega-content="outliner"] [data-mega-block]').first();
    const blockId = await block.getAttribute("data-block-id");
    expect(blockId).toBeTruthy();
    await block.click({ button: "right" });

    const menu = page.getByRole("menu", { name: "Block actions" });
    await expect(menu).toBeVisible();
    await expect(menu).not.toContainText(blockId!);
    await expect(menu.getByRole("menuitem", { name: /Copy block ref/ })).toBeVisible();
    await menu.getByRole("menuitem", { name: /Copy block ref/ }).hover();
    await expect(menu.getByRole("menuitem", { name: "Copy block ID" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Copy block link" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Focus on block" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Open in sidebar" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Expand all" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Collapse all" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Make TODO" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Heading 1" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Copy block ID" }).click();
    await expect(menu).toBeHidden();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`((${blockId}))`);
  });

  test("Enter chooses the first [[ candidate and keeps literal page brackets", async ({ page }) => {
    const docId = "doc_roam_first_page_reference";
    await stubWorkspace(page, docId);
    await page.goto(`/en/workspace/docs/${docId}`);
    const editable = page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first();
    await editable.click();
    await page.keyboard.type("[[");

    const linkMenu = page.locator('[data-mega-content="wikilink-menu"]');
    await expect(linkMenu.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-mega-content="ref"][data-ref-kind="doc"]')).toHaveText("Planning");
    await expect(editable).toContainText("[[Planning]]");
  });

  test("[[ creates a page once with Enter and inserts the bracketed resolved reference", async ({ page }) => {
    const docId = "doc_roam_page_reference";
    const requests = await stubWorkspace(page, docId);
    await page.goto(`/en/workspace/docs/${docId}`);
    const editable = page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first();
    await editable.click();
    await page.keyboard.type("[[Brand New Page");

    const linkMenu = page.locator('[data-mega-content="wikilink-menu"]');
    await expect(linkMenu.getByText('Create "Brand New Page"')).toBeVisible();
    await page.keyboard.press("Enter");
    await expect.poll(requests.resolveOrCreateCalls).toBe(1);
    await expect(page.locator('[data-mega-content="ref"][data-ref-kind="doc"]')).toHaveText("Brand New Page");
    await expect(editable).toContainText("[[Brand New Page]]");
  });

  test("slash keyboard selection inserts the block-reference trigger", async ({ page }) => {
    const docId = "doc_roam_quick_block_reference";
    await stubWorkspace(page, docId);
    await page.goto(`/en/workspace/docs/${docId}`);
    const editable = page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first();
    await editable.click();
    await page.keyboard.type("/");
    await expect(page.locator('[data-mega-content="quick-command-menu"]')).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect(editable).toContainText("((");
  });

  test("a block opens in the sidebar with its nested content", async ({ page }) => {
    const docId = "doc_roam_sidebar_block";
    await stubWorkspace(page, docId, lexicalDocumentWithBlockTree());
    await page.goto(`/en/workspace/docs/${docId}`);
    await page.locator('[data-mega-block][data-block-id="roam-focus-block"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open in sidebar" }).click();
    const panel = page.getByRole("complementary", { name: "Block sidebar" });
    await expect(panel).toContainText("Focused block");
    await expect(panel).toContainText("Focused child");
    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel).toHaveCount(0);
  });

  test("a cited block shows its readable reference count and sources", async ({ page }) => {
    const docId = "doc_roam_reference_count";
    await stubWorkspace(page, docId, lexicalDocumentWithBlockTree());
    await page.route(`**/api/mega/docs/${docId}/backlinks`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { items: [{ sourceType: "doc", sourceId: "source-1", sourceTitle: "Source document", contextSummary: "Referenced the block", href: "/docs/source-1", targetBlockId: "roam-focus-block" }] } }),
    }));
    await page.goto(`/en/workspace/docs/${docId}`);
    const badge = page.getByRole("button", { name: "1 references" });
    await expect(badge).toBeVisible();
    await badge.click();
    const panel = page.getByRole("complementary", { name: "Block sidebar" });
    await expect(panel).toContainText("Source document");
    await expect(panel).toContainText("Referenced the block");
  });

  test("slash command inserts a table without leaving an empty block", async ({ page }) => {
    const docId = "doc_roam_table";
    await stubWorkspace(page, docId);
    await page.goto(`/en/workspace/docs/${docId}`);
    const block = page.locator('[data-mega-content="outliner"] [data-mega-block]').first();
    await block.click();
    await page.keyboard.type("/table");
    await page.getByRole("option", { name: "Table" }).click();
    await expect(page.locator('[data-mega-outline-table] tr')).toHaveCount(2);
    await expect(page.locator('[data-mega-outline-table] td')).toHaveCount(4);
    await expect(page.locator('[data-mega-table-source] [data-mega-block]')).toHaveCount(4);
    const table = page.locator('[data-mega-outline-table]');
    const source = page.locator('[data-mega-table-source]');
    const arrow = page.locator('[data-mega-content="collapse-toggle"][data-table-outline="true"]');
    await expect(arrow).toHaveAttribute('aria-expanded', 'true');
    await expect(arrow).toHaveCSS('opacity', '1');
    const tableRect = await table.boundingBox();
    const arrowRect = await arrow.boundingBox();
    expect(arrowRect!.x + arrowRect!.width).toBeLessThan(tableRect!.x);
    expect(arrowRect!.y).toBeLessThan(tableRect!.y + 30);
    expect(arrowRect!.y).toBeGreaterThanOrEqual(tableRect!.y);
    await arrow.click();
    await expect(arrow).toHaveAttribute('aria-expanded', 'false');
    await expect(source.locator('[data-mega-block]').first()).toBeHidden();
    await expect(table).toBeVisible();
    const firstCell = page.getByRole('textbox', { name: 'Row 1, column 1' });
    await firstCell.fill('Shared cell');
    const firstOutlineCell = page.locator('[data-mega-table-source] [data-mega-block]').first();
    await expect(firstOutlineCell).toContainText('Shared cell');
    await arrow.focus();
    await page.keyboard.press('Space');
    await expect(arrow).toHaveAttribute('aria-expanded', 'true');
    await expect(firstOutlineCell).toBeVisible();
    await firstOutlineCell.click({ position: { x: 75, y: 12 } });
    await page.keyboard.press('End');
    await page.keyboard.type(' updated');
    await expect(firstCell).toHaveValue(/updated/);
    await page.getByRole('textbox', { name: 'Row 2, column 2' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-mega-outline-table] tr')).toHaveCount(3);
    await expect(page.getByRole('textbox', { name: 'Row 3, column 1' })).toBeFocused();
  });

  test("empty first-column outline rows remain separate and editable without changing the second column", async ({ page }) => {
    const docId = "doc_roam_empty_table_cells";
    await stubWorkspace(page, docId);
    await page.goto(`/en/workspace/docs/${docId}`);
    await page.locator('[data-mega-content="outliner"] [data-mega-block]').first().click();
    await page.keyboard.type("/table");
    await page.getByRole("option", { name: "Table" }).click();
    for (const row of [1, 2]) {
      const first = page.getByRole('textbox', { name: `Row ${row}, column 1`, exact: true });
      const second = page.getByRole('textbox', { name: `Row ${row}, column 2`, exact: true });
      await second.fill(`Second ${row}`);
      const outline = page.locator('[data-mega-table-source] > [data-mega-block]').nth(row - 1);
      await outline.click({ position: { x: 75, y: 12 } });
      await page.keyboard.type(`First ${row}`);
      await expect(first).toHaveValue(`First ${row}`);
      await expect(second).toHaveValue(`Second ${row}`);
      await expect(page.locator('[data-mega-content="outline-table-actions"]')).toHaveCount(0);
      const gap = await page.locator('[data-mega-table-source]').evaluate((element) =>
        element.querySelector('[data-mega-block]')!.getBoundingClientRect().top - element.querySelector('[data-mega-outline-table]')!.getBoundingClientRect().bottom);
      expect(gap).toBeLessThanOrEqual(12);
      await first.fill('');
      await outline.click({ position: { x: 75, y: 12 } });
      await page.keyboard.type(`Restored ${row}`);
      await expect(first).toHaveValue(`Restored ${row}`);
      await expect(second).toHaveValue(`Second ${row}`);
      const positions = await outline.evaluate((element) => ({
        parent: element.getBoundingClientRect().top,
        child: element.querySelector('[data-mega-block]')!.getBoundingClientRect().top,
      }));
      expect(positions.child - positions.parent).toBeGreaterThanOrEqual(22);
    }
  });

  test("a saved collapsed table remains visible and can be expanded in a snapshot", async ({ page }) => {
    const docId = "doc_roam_table_snapshot";
    const state = JSON.parse(lexicalDocumentWithBlockTree());
    const source = state.root.children[0];
    source.collapsed = true;
    source.children = [
      { type: "mega-roam-macro", version: 1, text: "{{[[table]]}}" },
      ...source.children.filter((node: { type: string }) => node.type === "mega-block"),
    ];
    await stubWorkspace(page, docId, JSON.stringify(state));
    await page.goto(`/en/workspace/docs/${docId}?v=1`);
    const table = page.locator('[data-mega-outline-table]');
    const outline = page.locator('[data-mega-table-source]');
    const arrow = page.locator('[data-mega-content="collapse-toggle"][data-table-outline="true"]');
    await expect(table).toBeVisible();
    await expect(outline.locator('[data-mega-block]').first()).toBeHidden();
    await expect(arrow).toHaveAttribute('aria-expanded', 'false');
    const tableRect = await table.boundingBox();
    const arrowRect = await arrow.boundingBox();
    expect(arrowRect!.x + arrowRect!.width).toBeLessThanOrEqual(tableRect!.x);
    expect(arrowRect!.y).toBeLessThan(tableRect!.y + 30);
    await arrow.click();
    await expect(outline.locator('[data-mega-block]').first()).toBeVisible();
    await expect(arrow).toHaveAttribute('aria-expanded', 'true');
    await expect(table.getByRole('textbox')).toHaveValue('Focused child');
    await expect(table.getByRole('textbox')).toHaveAttribute('readonly', '');
    await arrow.focus();
    await page.keyboard.press('Enter');
    await expect(outline.locator('[data-mega-block]').first()).toBeHidden();
    await expect(table).toBeVisible();
    await expect(page.locator('[data-mega-content="reader"] [data-block-id="roam-hidden-sibling"]')).toBeVisible();
  });

  test("slash command inserts an external image", async ({ page }) => {
    const docId = "doc_roam_image_url";
    await stubWorkspace(page, docId);
    await page.goto(`/en/workspace/docs/${docId}`);
    const block = page.locator('[data-mega-content="outliner"] [data-mega-block]').first();
    await block.click();
    await page.keyboard.type("/image");
    await page.getByRole("option", { name: "Image" }).click();
    const dialog = page.getByRole("dialog", { name: "Insert image" });
    await dialog.getByLabel("Image URL").fill("https://example.com/chart.png");
    await dialog.getByLabel("Description").fill("Chart");
    await dialog.getByRole("button", { name: "Insert" }).click();
    await expect(page.locator('[data-mega-content="editor"] img[alt="Chart"]')).toHaveAttribute("src", "https://example.com/chart.png");
    const blocks = page.locator('[data-mega-content="outliner"] [data-mega-block]');
    await expect(blocks).toHaveCount(2);
    await expect(page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first()).toBeFocused();
    await page.keyboard.type("After image");
    await expect(blocks.nth(1)).toContainText("After image");
  });

  test("a saved document ending in an image restores an editable outliner row", async ({ page }) => {
    const docId = "doc_roam_saved_terminal_image";
    const body = JSON.stringify({ root: {
      type: "root", version: 1, direction: null, format: "", indent: 0,
      children: [{
        type: "mega-block", version: 1, blockId: "saved-image", variant: "text",
        collapsed: false, todoChecked: false, direction: null, format: "", indent: 0,
        children: [{ type: "mega-image", version: 1, image: { src: "https://example.com/saved.png", alt: "Saved image" } }],
      }],
    } });
    await stubWorkspace(page, docId, body);
    await page.goto(`/en/workspace/docs/${docId}`);

    const rows = page.locator('[data-mega-docs="editor"] [contenteditable="true"] > [data-mega-block]');
    await expect(rows).toHaveCount(2);
    await expect(rows.first().locator('img[alt="Saved image"]')).toBeVisible();
    await rows.last().click();
    await page.keyboard.type("After the saved image");
    await expect(rows.last()).toContainText("After the saved image");
  });

  test("an uploaded image is inserted through the authenticated attachment route", async ({ page }) => {
    const docId = "doc_roam_image_upload";
    await stubWorkspace(page, docId);
    await page.goto(`/en/workspace/docs/${docId}`);
    await page.locator('[data-mega-content="outliner"] [data-mega-block]').first().click();
    await page.keyboard.type("/image");
    await page.getByRole("option", { name: "Image" }).click();
    const dialog = page.getByRole("dialog", { name: "Insert image" });
    await dialog.getByLabel("Or upload a file").setInputFiles({
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64"),
    });
    const image = page.locator('[data-mega-content="editor"] img[alt="pixel.png"]');
    await expect(image).toHaveAttribute("src", /\/attachments\/.*\.png$/);
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    await page.keyboard.type("After upload");
    await expect(page.locator('[data-mega-content="outliner"] [data-mega-block]').nth(1)).toContainText("After upload");
  });

  test("[[Title]] keeps neutral brackets and a colored page title that creates and navigates when clicked", async ({ page }) => {
    const docId = "doc_roam_closed_page_reference";
    const requests = await stubWorkspace(page, docId, lexicalDocumentWithText("[[MegaUI]]"));
    await page.goto(`/en/workspace/docs/${docId}`);

    const unresolvedPage = page.locator('[data-mega-content="ref-unresolved"][data-ref-kind="doc"]');
    await expect(unresolvedPage).toHaveText("MegaUI");
    const brackets = page.locator('[data-mega-content="ref-bracket"]');
    await expect(brackets).toHaveText(["[[", "]]"]);
    const colors = await page.locator('[data-mega-docs="editor"] [contenteditable="true"]').evaluate((editor) => ({
      editor: getComputedStyle(editor).color,
      title: getComputedStyle(document.querySelector('[data-mega-content="ref-unresolved"]')!).color,
      brackets: [...document.querySelectorAll<HTMLElement>('[data-mega-content="ref-bracket"]')].map((bracket) => getComputedStyle(bracket).color),
    }));
    expect(colors.title).not.toBe(colors.editor);
    expect(colors.brackets).toEqual(["rgb(167, 182, 194)", "rgb(167, 182, 194)"]);
    expect(colors.title).toBe("rgb(16, 107, 163)");

    await unresolvedPage.click();
    await expect.poll(requests.resolveOrCreateCalls).toBe(1);
    await expect(page).toHaveURL(new RegExp(`/en/workspace/docs/doc_created$`));
  });

  test("(( inserts an ACL-filtered document block reference", async ({ page }) => {
    const docId = "doc_roam_block_reference";
    await stubWorkspace(page, docId);
    await page.goto(`/en/workspace/docs/${docId}`);
    const editable = page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first();
    await editable.click();
    await page.keyboard.type("((reference");

    const blockMenu = page.locator('[data-mega-content="block-ref-menu"]');
    await expect(blockMenu.getByText("Referenced block")).toBeVisible();
    await blockMenu.getByText("Referenced block").click();
    await expect(page.locator('[data-mega-content="block-ref"]')).toHaveAttribute("data-ref-editing", "true");
    await expect(page.locator('[data-mega-content="block-ref"]')).toContainText("((BlockRef0001))");
    await page.locator('[data-mega-docs="detail-title"]').click();
    await expect(page.locator('[data-mega-content="block-ref"]')).toContainText("Referenced block");
  });

  test("# creates a page tag without breaking #number Issue references", async ({ page }) => {
    const docId = "doc_roam_page_tag";
    await stubWorkspace(page, docId);
    await page.goto(`/en/workspace/docs/${docId}`);
    const editable = page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first();
    await editable.click();
    await page.keyboard.type("#Planning");

    const linkMenu = page.locator('[data-mega-content="wikilink-menu"]');
    await expect(linkMenu.getByText("Planning")).toBeVisible();
    await linkMenu.getByText("Planning").click();
    await expect(page.locator('[data-mega-docs="editor"]')).toContainText("#Planning");
    const tag = page.locator('[data-mega-docs="editor"] [data-ref-notation="tag"]');
    await expect(tag).toHaveText("#Planning");
    await expect(tag).toHaveCSS("color", "rgb(167, 182, 194)");

    await editable.click();
    // macOS End scrolls the document; preserve the intended caret-at-line-end input.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await page.keyboard.type(" #42");
    await expect(linkMenu.getByText("Fix shortcut issue")).toBeVisible();
    await linkMenu.getByText("Fix shortcut issue").click();
    await expect(page.locator('[data-mega-content="ref"][data-ref-kind="issue"]')).toContainText("Fix shortcut issue");
  });

  test("legacy page tags use one gray-blue hash link and delete without merging neighboring blocks", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const body = JSON.parse(lexicalDocumentWithText("Before"));
    const template = body.root.children[0];
    const text = (value: string) => ({ ...template.children[0], text: value });
    const ref = { type: "mega-ref", version: 1, ref: { kind: "doc", notation: "tag", targetTitle: "Planning", targetId: "doc_planning" } };
    body.root.children = [
      template,
      { ...template, blockId: "tag-one", children: [text("#"), ref] },
      { ...template, blockId: "tag-two", children: [text("#"), ref, text(" suffix")] },
      { ...template, blockId: "after-tags", children: [text("After")] },
    ];
    const docId = "doc_roam_tag_deletion";
    await stubWorkspace(page, docId, JSON.stringify(body));
    await page.goto(`/en/workspace/docs/${docId}`);
    const editor = page.locator('[data-mega-docs="editor"]');
    const tags = editor.locator('[data-ref-notation="tag"]');
    const first = editor.locator('[data-block-id="tag-one"]');
    const second = editor.locator('[data-block-id="tag-two"]');
    const rows = editor.locator('[data-mega-block]');
    await expect(tags).toHaveCount(2);
    await expect(tags.first()).toHaveText("#Planning");
    await expect(tags.first()).toHaveCSS("color", "rgb(167, 182, 194)");
    await expect(first).toHaveText("#Planning");

    // Click the row's empty right side, avoiding the tag's navigation link.
    const bounds = await first.boundingBox();
    if (!bounds) throw new Error("Missing tag row");
    await first.click({ position: { x: bounds.width - 4, y: bounds.height / 2 } });
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    await expect(first).toBeEmpty();
    await expect(rows).toHaveCount(4);
    await expect(second).toHaveText("#Planning suffix");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(first).toHaveText("#Planning");
    await expect(rows).toHaveCount(4);
    await expect(second).toHaveText("#Planning suffix");

    await second.click({ position: { x: bounds.width - 4, y: bounds.height / 2 } });
    // Place the DOM caret before the chip: Home differs between macOS and Linux.
    await second.evaluate((element) => {
      const range = document.createRange();
      range.setStart(element, 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await expect.poll(() => second.evaluate((element) => {
      const selection = window.getSelection();
      return selection?.anchorNode === element && selection.anchorOffset === 0 && selection.isCollapsed;
    })).toBe(true);
    await page.keyboard.press("Delete");
    await expect(second).toHaveText(" suffix");
    await expect(rows).toHaveCount(4);
    await expect(first).toHaveText("#Planning");
    await expect(editor.locator('[data-block-id="after-tags"]')).toHaveText("After");
    expect(errors).toEqual([]);

    await page.goto(`/en/workspace/docs/${docId}?v=1`);
    const readerTags = page.locator('[data-mega-content="reader"] [data-ref-notation="tag"]');
    await expect(readerTags).toHaveCount(2);
    await expect(readerTags.first()).toHaveText("#Planning");
    await expect(readerTags.first()).toHaveCSS("color", "rgb(167, 182, 194)");
    expect(errors).toEqual([]);
  });
});
