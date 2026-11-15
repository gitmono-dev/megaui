import { expect, test } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";
import { lexicalDocumentWithText, stubWorkspace } from "./helpers/workspace-docs-roam-fixture";

const text = (value: string) => ({ detail: 0, format: 0, mode: "normal", style: "", text: value, type: "text", version: 1 });
const block = (blockId: string, value: string, variant = "text", children: readonly object[] = []) => ({
  type: "mega-block", version: 1, blockId, variant, collapsed: false, todoChecked: false,
  children: [text(value), ...children], direction: null, format: "", indent: 0,
});

function nestedTodoDocument(includeSibling = true): string {
  return JSON.stringify({
    root: {
      type: "root", version: 1, direction: null, format: "", indent: 0,
      children: [
        block("TodoParent01", "Parent task", "todo", [
          block("TodoChild001", "Child task", "todo", [block("TodoGrand001", "Nested note")]),
        ]),
        ...(includeSibling ? [block("embed-target", "Paste here")] : []),
      ],
    },
  });
}

function nestedEmptyTargetDocument(): string {
  return JSON.stringify({
    root: {
      type: "root", version: 1, direction: null, format: "", indent: 0,
      children: [block("target-parent", "Parent", "text", [block("target-empty", "")])],
    },
  });
}

function singleBlockDocument(blockId: string, value: string, variant = "text"): string {
  return JSON.stringify({
    root: {
      type: "root", version: 1, direction: null, format: "", indent: 0,
      children: [block(blockId, value, variant)],
    },
  });
}

function documentWithTwoEmbeds(targetDocId: string, targetBlockId = "source-block"): string {
  const embedded = (blockId: string) => ({
    type: "mega-block", version: 1, blockId, variant: "text", collapsed: false, todoChecked: false,
    children: [{ type: "mega-embed", version: 1, embed: { targetDocId, targetBlockId } }],
    direction: null, format: "", indent: 0,
  });
  return JSON.stringify({ root: {
    type: "root", version: 1, direction: null, format: "", indent: 0,
    children: [block("before", "Keep before"), embedded("embed-one"), embedded("embed-two"), block("after", "Keep after")],
  } });
}

test.describe("workspace document embeds and nested outline", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies(mintSessionCookies().cookies);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  });

  test("embedded table arrows keep their own lane and fold only the selected outline", async ({ page }) => {
    const sourceDocId = "doc_embed_table_source";
    const docId = "doc_embed_table_target";
    const tableBody = JSON.stringify({ root: {
      type: "root", version: 1, direction: null, format: "", indent: 0,
      children: [
        { type: "mega-outline-table", version: 1, blockId: "TableView001", sourceBlockId: "table-source" },
        { ...block("table-source", ""), tableSource: true, children: [
          { ...block("table-row-one", ""), children: [
            { type: "paragraph", version: 1, direction: null, format: "", indent: 0, children: [text("First row")] },
            block("table-cell-two", "Value one"),
          ] },
          block("table-row-two", "Second row", "text", [block("table-cell-four", "Value two")]),
        ] },
      ],
    } });
    await stubWorkspace(page, docId, documentWithTwoEmbeds(sourceDocId, "TableView001"));
    await page.route("**/api/mega/embed/resolve**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        access: "ok", status: "ok", docId: sourceDocId, blockId: "TableView001", title: "Table source",
        snapshotBody: tableBody, containerBody: tableBody, ancestorChain: [], depth: 0, cycle: false, tooDeep: false,
      } }) });
    });
    await page.goto(`/en/workspace/docs/${docId}`);
    const embeds = page.locator('[data-mega-content="embed-block"]');
    const first = embeds.nth(0);
    const second = embeds.nth(1);
    const table = first.getByRole("table");
    const toggle = first.locator('[data-table-outline="true"]');
    await expect(table).toBeVisible();
    await expect(second.getByRole("table")).toBeVisible();
    const layout = await first.evaluate((element) => {
      const grid = element.querySelector<HTMLElement>('[data-mega-outline-table]')!;
      const arrow = element.querySelector<HTMLElement>('[data-table-outline="true"]')!;
      const gridRect = grid.getBoundingClientRect();
      const arrowRect = arrow.getBoundingClientRect();
      const bullet = getComputedStyle(grid, "::before");
      return {
        gap: gridRect.left + Number.parseFloat(bullet.left) - arrowRect.right,
        width: arrowRect.width,
        verticalOffset: Math.abs(arrowRect.top + arrowRect.height / 2
          - gridRect.top - Number.parseFloat(bullet.top) - Number.parseFloat(bullet.height) / 2),
      };
    });
    expect.soft(layout.gap).toBeGreaterThanOrEqual(4);
    expect.soft(layout.width).toBeGreaterThanOrEqual(14);
    expect.soft(layout.verticalOffset).toBeLessThanOrEqual(1);

    // A cell can have a paragraph (empty-cell repair) or direct inline text.
    for (const rowId of ["table-row-one", "table-row-two"]) {
      const row = first.locator(`[data-block-id="${rowId}"]`);
      const rowToggle = first.locator(`[data-overlay-key="collapse:${rowId}"]`);
      await rowToggle.click();
      await expect(rowToggle).toHaveAttribute("aria-expanded", "false");
      await expect.soft(row.locator(":scope > p, :scope > span")).toBeVisible();
      await expect(row.locator(":scope > [data-mega-block]")).toBeHidden();
      await expect(table).toContainText("Value one");
      await expect(table).toContainText("Value two");
      await rowToggle.press("Enter");
      await expect(row.locator(":scope > [data-mega-block]")).toBeVisible();
    }

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(first.locator('[data-mega-table-source]')).toBeHidden();
    await expect(first.locator('[data-mega-content="collapse-toggle"]')).toHaveCount(1);
    await expect(table).toBeVisible();
    await expect(second.locator('[data-mega-table-source]')).toBeVisible();
    await toggle.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(first.locator('[data-mega-table-source]')).toBeVisible();
    await expect(first.locator('[data-mega-content="collapse-toggle"]')).toHaveCount(3);
  });

  test("nested TODOs keep a compact offset, first-row checkboxes, and ancestor guide lines", async ({ page }) => {
    await stubWorkspace(page, "doc_nested_todo", nestedTodoDocument());
    await page.goto("/en/workspace/docs/doc_nested_todo");
    await expect(page.locator('[data-mega-content="todo-check"][data-block-id="TodoChild001"]')).toBeVisible();

    const layout = await page.evaluate(() => {
      const parent = document.querySelector<HTMLElement>('[data-mega-block="todo"][data-block-id="TodoParent01"]');
      const child = document.querySelector<HTMLElement>('[data-mega-block="todo"][data-block-id="TodoChild001"]');
      const checkbox = document.querySelector<HTMLElement>('[data-mega-content="todo-check"][data-block-id="TodoChild001"]');
      if (!parent || !child || !checkbox) throw new Error("Expected nested TODO blocks and checkbox");
      const guide = getComputedStyle(child, "::after");
      const parentRect = parent.getBoundingClientRect();
      const childRect = child.getBoundingClientRect();
      const checkboxRect = checkbox.getBoundingClientRect();
      const parentBullet = getComputedStyle(parent, "::before");
      return {
        checkboxOffset: checkboxRect.top - childRect.top,
        childOffset: childRect.left - parentRect.left,
        guideColor: guide.borderLeftColor,
        guideHeight: Number.parseFloat(guide.height),
        guideWidth: guide.borderLeftWidth,
        childHeight: childRect.height,
        guideAlignment: childRect.left + Number.parseFloat(guide.left)
          - parentRect.left - Number.parseFloat(parentBullet.left) - Number.parseFloat(parentBullet.width) / 2,
      };
    });

    expect(layout.checkboxOffset).toBeGreaterThanOrEqual(0);
    expect(layout.checkboxOffset).toBeLessThanOrEqual(10);
    expect(layout.childOffset).toBeGreaterThanOrEqual(26);
    expect(layout.childOffset).toBeLessThanOrEqual(28);
    expect(layout.guideWidth).toBe("1px");
    expect(layout.guideColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(Math.abs(layout.guideHeight - layout.childHeight)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.guideAlignment)).toBeLessThanOrEqual(1);
  });

  test("Copy embed pastes a source block subtree into another document", async ({ page }) => {
    const sourceDocId = "doc_block_embed_source";
    const targetDocId = "doc_block_embed_target";
    let resolveCalls = 0;
    const savedBodies: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`/api/mega/docs/${targetDocId}/save`) && request.method() === "POST") {
        savedBodies.push(request.postData() ?? "");
      }
    });
    await stubWorkspace(page, sourceDocId, nestedTodoDocument());
    await page.route("**/api/mega/embed/resolve**", async (route) => {
      resolveCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: {
          access: "ok", status: "ok", docId: sourceDocId, blockId: "TodoParent01", title: "Source document",
          snapshotBody: nestedTodoDocument(false), containerBody: nestedTodoDocument(false), ancestorChain: [],
          depth: 0, cycle: false, tooDeep: false, referenceCount: 2,
        } }),
      });
    });
    await page.goto(`/en/workspace/docs/${sourceDocId}`);

    await page.locator('[data-mega-block="todo"][data-block-id="TodoParent01"]').click({ button: "right", position: { x: 8, y: 8 } });
    await page.getByRole("menuitem", { name: /Copy block ref/ }).hover();
    await page.getByRole("menuitem", { name: /Copy embed/ }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("{{[[embed]]: ((TodoParent01))}}");

    await stubWorkspace(page, targetDocId, lexicalDocumentWithText("Paste here"));
    await page.goto(`/en/workspace/docs/${targetDocId}`);
    await page.locator('[data-mega-block][data-block-id="roam-text-block"]').click();
    await page.keyboard.press("End");
    await page.keyboard.press("ControlOrMeta+V");
    const macro = page.getByRole("textbox", { name: "Embed macro" });
    await expect(macro).toHaveValue("{{[[embed]]: ((TodoParent01))}}");
    await macro.press("Tab");
    const followingBlock = page.locator('[data-mega-block][data-block-id="roam-text-block"] + [data-mega-block] + [data-mega-block]');
    await expect(followingBlock).toBeVisible();
    await expect(page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first()).toBeFocused();
    await page.keyboard.type("After embed");
    await expect(followingBlock).toContainText("After embed");

    const embed = page.locator(`[data-mega-content="embed-block"][data-target-doc="${sourceDocId}"][data-target-block="TodoParent01"]`);
    await expect(embed).toBeVisible();
    await expect(embed.locator('[data-mega-content="embed-snapshot-title"]')).toHaveCount(0);
    await expect(embed.locator('[data-mega-content="embed-outline-preview"]')).toHaveCSS("background-color", "rgb(234, 240, 244)");
    await expect(embed.locator('[data-mega-content="embed-reference-count"]')).toHaveText("2");
    await expect(embed).toContainText("Parent task");
    const embedTypography = await embed.evaluate((element) => {
      const outer = element.closest<HTMLElement>('[data-mega-block]');
      const inner = element.querySelector<HTMLElement>('[data-mega-content="reader"] [data-mega-block]');
      if (!outer || !inner) throw new Error("Expected an outline block and embedded source block");
      return {
        outerSize: getComputedStyle(outer).fontSize,
        innerSize: getComputedStyle(inner).fontSize,
        outerLineHeight: getComputedStyle(outer).lineHeight,
        innerLineHeight: getComputedStyle(inner).lineHeight,
      };
    });
    expect(embedTypography.innerSize).toBe(embedTypography.outerSize);
    expect(embedTypography.innerLineHeight).toBe(embedTypography.outerLineHeight);
    await expect(embed).toContainText("Child task");
    await expect(embed).not.toContainText("Paste here");
    const savedEditors = () => savedBodies.map((body) => JSON.parse((JSON.parse(body) as { body: string }).body) as {
      root: { children: Array<{ type: string; children?: Array<{ type: string }> }> };
    });
    await expect.poll(() => savedEditors().some((state) => JSON.stringify(state).includes('"type":"mega-embed"'))).toBe(true);
    const savedRoot = savedEditors().find((state) => JSON.stringify(state).includes('"type":"mega-embed"'));
    if (!savedRoot) throw new Error("Expected an autosaved embed");
    expect(savedRoot.root.children.every((node) => node.type === "mega-block")).toBe(true);
    expect(savedRoot.root.children.some((node) => node.children?.some((child) => child.type === "mega-embed"))).toBe(true);
    await expect(page.locator('[data-mega-content="todo-overlay"] [data-mega-content="todo-check"]')).toHaveCount(0);
    await expect(embed.locator('[data-mega-content="reader-overlay"] [data-mega-content="todo-check"]')).toHaveCount(2);
    const embeddedTodoLayout = await embed.evaluate((element) => {
      const checkbox = element.querySelector<HTMLElement>('[data-mega-content="reader-overlay"] [data-mega-content="todo-check"]');
      const collapse = element.querySelector<HTMLElement>('[data-mega-content="reader-overlay"] [data-mega-content="collapse-toggle"]');
      const todo = element.querySelector<HTMLElement>('[data-mega-content="reader"] [data-mega-block="todo"]');
      if (!checkbox || !collapse || !todo) throw new Error("Expected embedded TODO controls");
      return {
        controlSeparation: checkbox.getBoundingClientRect().left - collapse.getBoundingClientRect().left,
        collapseOpacity: getComputedStyle(collapse).opacity,
        textLeading: Number.parseFloat(getComputedStyle(todo).paddingLeft),
      };
    });
    expect(embeddedTodoLayout.controlSeparation).toBeGreaterThanOrEqual(18);
    expect(embeddedTodoLayout.collapseOpacity).toBe("1");
    expect(embeddedTodoLayout.textLeading).toBeGreaterThanOrEqual(36);
    expect(resolveCalls).toBeGreaterThan(0);
  });

  test("Copy embed pastes into an empty document block", async ({ page }) => {
    const sourceDocId = "doc_embed_empty_source";
    const targetDocId = "doc_embed_empty_target";
    await stubWorkspace(page, sourceDocId, nestedTodoDocument());
    await page.route("**/api/mega/embed/resolve**", async (route) => {
      const requestedBlock = new URL(route.request().url()).searchParams.get("block");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: {
          access: "ok", status: "ok", docId: sourceDocId, blockId: requestedBlock, title: "Source document",
          snapshotBody: requestedBlock === "TodoChild001" ? singleBlockDocument("TodoChild001", "Child task", "todo") : nestedTodoDocument(false),
          containerBody: requestedBlock === "TodoChild001" ? singleBlockDocument("TodoChild001", "Child task", "todo") : nestedTodoDocument(false),
          ancestorChain: [],
          depth: 0, cycle: false, tooDeep: false,
        } }),
      });
    });
    await page.goto(`/en/workspace/docs/${sourceDocId}`);
    await page.locator('[data-mega-block="todo"][data-block-id="TodoParent01"]').click({ button: "right", position: { x: 8, y: 8 } });
    await page.getByRole("menuitem", { name: /Copy block ref/ }).hover();
    await page.getByRole("menuitem", { name: /Copy embed/ }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("{{[[embed]]: ((TodoParent01))}}");

    await stubWorkspace(page, targetDocId);
    await page.goto(`/en/workspace/docs/${targetDocId}`);
    await page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first().click();
    await page.keyboard.press("ControlOrMeta+V");
    const macro = page.getByRole("textbox", { name: "Embed macro" });
    await expect(macro).toHaveValue("{{[[embed]]: ((TodoParent01))}}");
    await macro.fill("{{[[embed]]: ((TodoChild001))}}");
    await macro.press("Tab");
    const editedEmbed = page.locator(`[data-mega-content="embed-block"][data-target-doc="${sourceDocId}"][data-target-block="TodoChild001"]`);
    await editedEmbed.scrollIntoViewIfNeeded();
    await expect(editedEmbed).toContainText("Child task");
  });

  test("Copy embed pastes into an empty nested block", async ({ page }) => {
    const sourceDocId = "doc_embed_nested_source";
    const targetDocId = "doc_embed_nested_target";
    const savedBodies: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`/api/mega/docs/${targetDocId}/save`) && request.method() === "POST") {
        savedBodies.push(request.postData() ?? "");
      }
    });
    await stubWorkspace(page, sourceDocId, nestedTodoDocument());
    await page.route("**/api/mega/embed/resolve**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: {
          access: "ok", status: "ok", docId: sourceDocId, blockId: "TodoParent01", title: "Source document",
          snapshotBody: nestedTodoDocument(false), containerBody: nestedTodoDocument(false), ancestorChain: [],
          depth: 0, cycle: false, tooDeep: false,
        } }),
      });
    });
    await page.goto(`/en/workspace/docs/${sourceDocId}`);
    await page.locator('[data-mega-block="todo"][data-block-id="TodoParent01"]').click({ button: "right", position: { x: 8, y: 8 } });
    await page.getByRole("menuitem", { name: /Copy block ref/ }).hover();
    await page.getByRole("menuitem", { name: /Copy embed/ }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("{{[[embed]]: ((TodoParent01))}}");

    await stubWorkspace(page, targetDocId, nestedEmptyTargetDocument());
    await page.goto(`/en/workspace/docs/${targetDocId}`);
    await page.locator('[data-mega-block][data-block-id="target-empty"]').click();
    await page.keyboard.press("ControlOrMeta+V");
    const macro = page.getByRole("textbox", { name: "Embed macro" });
    await expect(macro).toHaveValue("{{[[embed]]: ((TodoParent01))}}");
    await macro.press("Enter");
    await expect(page.locator(`[data-mega-block][data-block-id="target-empty"] [data-mega-content="embed-block"][data-target-doc="${sourceDocId}"][data-target-block="TodoParent01"]`)).toBeVisible();
    await expect(page.locator('[data-mega-block][data-block-id="target-empty"] + [data-mega-block]')).toBeVisible();
    await page.keyboard.type("After nested embed");
    await expect(page.locator('[data-mega-block][data-block-id="target-empty"] + [data-mega-block]')).toContainText("After nested embed");
    await expect(page.locator('[data-mega-block][data-block-id="target-parent"]')).toContainText("Parent");
    await expect.poll(() => savedBodies.some((body) => body.includes('mega-embed'))).toBe(true);
  });

  test("Copy embed keeps the editor ready for immediate paste", async ({ page }) => {
    const docId = "doc_embed_immediate_paste";
    await stubWorkspace(page, docId, nestedTodoDocument());
    await page.route("**/api/mega/embed/resolve**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: {
          access: "ok", status: "ok", docId, blockId: "TodoParent01", title: "Source document",
          snapshotBody: nestedTodoDocument(false), containerBody: nestedTodoDocument(false), ancestorChain: [],
          depth: 0, cycle: false, tooDeep: false,
        } }),
      });
    });
    await page.goto(`/en/workspace/docs/${docId}`);
    await page.locator('[data-mega-block][data-block-id="embed-target"]').click();
    await page.keyboard.press("End");
    await page.locator('[data-mega-block][data-block-id="TodoParent01"]').click({ button: "right", position: { x: 8, y: 8 } });
    await page.getByRole("menuitem", { name: /Copy block ref/ }).hover();
    await page.getByRole("menuitem", { name: /Copy embed/ }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("{{[[embed]]: ((TodoParent01))}}");
    await expect(page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first()).toBeFocused();

    await page.keyboard.press("ControlOrMeta+V");
    const macro = page.getByRole("textbox", { name: "Embed macro" });
    await expect(macro).toHaveValue("{{[[embed]]: ((TodoParent01))}}");
    await macro.press("Enter");
    await expect(page.locator('[data-mega-content="embed-block"][data-target-block="TodoParent01"]')).toBeVisible();
  });

  test("an embedded block can be removed with Backspace or its Delete button", async ({ page }) => {
    const sourceDocId = "doc_embed_delete_source";
    const targetDocId = "doc_embed_delete_target";
    const savedBodies: string[] = [];
    let referenceCount = 2;
    page.on("request", (request) => {
      if (request.url().includes(`/api/mega/docs/${targetDocId}/save`) && request.method() === "POST") {
        const payload = request.postData() ?? "";
        savedBodies.push(payload);
        const saved = JSON.parse(payload) as { body?: string };
        referenceCount = (saved.body?.match(/"type":"mega-embed"/g) ?? []).length;
      }
    });
    await stubWorkspace(page, targetDocId, documentWithTwoEmbeds(sourceDocId));
    await page.route("**/api/mega/embed/resolve**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        access: "ok", status: "ok", docId: sourceDocId, blockId: "source-block", title: "Source",
        snapshotBody: singleBlockDocument("source-block", "Source text"),
        containerBody: singleBlockDocument("source-block", "Source text"),
        ancestorChain: [], depth: 0, cycle: false, tooDeep: false, referenceCount,
      } }) });
    });
    await page.goto(`/en/workspace/docs/${targetDocId}`);
    const first = page.locator('[data-block-id="embed-one"] [data-mega-content="editor-embed-shell"]');
    await expect(first).toBeVisible();
    await first.click();
    await expect(first).toBeFocused();
    await page.keyboard.press("Backspace");
    await expect(page.locator('[data-block-id="embed-one"]')).toHaveCount(0);

    const second = page.locator('[data-block-id="embed-two"] [data-mega-content="editor-embed-shell"]');
    await expect(second.locator('[data-mega-content="embed-reference-count"]')).toHaveText("1");
    await second.hover();
    await second.getByRole("button", { name: "Delete embed" }).click();
    await expect(page.locator('[data-block-id="embed-two"]')).toHaveCount(0);
    await expect(page.locator('[data-block-id="before"]')).toContainText("Keep before");
    await expect(page.locator('[data-block-id="after"]')).toContainText("Keep after");
    await expect.poll(() => savedBodies.some((body) => !body.includes('mega-embed'))).toBe(true);
  });

  test("Enter on an existing embed creates a focused line below it", async ({ page }) => {
    const sourceDocId = "doc_embed_enter_source";
    const targetDocId = "doc_embed_enter_target";
    await stubWorkspace(page, targetDocId, documentWithTwoEmbeds(sourceDocId));
    await page.route("**/api/mega/embed/resolve**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        access: "ok", status: "ok", docId: sourceDocId, blockId: "source-block", title: "Source",
        snapshotBody: singleBlockDocument("source-block", "Source text"),
        containerBody: singleBlockDocument("source-block", "Source text"),
        ancestorChain: [], depth: 0, cycle: false, tooDeep: false,
      } }) });
    });
    await page.goto(`/en/workspace/docs/${targetDocId}`);
    const embed = page.locator('[data-block-id="embed-one"] [data-mega-content="editor-embed-shell"]');
    await embed.click();
    await page.keyboard.press("Enter");
    const following = page.locator('[data-block-id="embed-one"] + [data-mega-block]');
    await expect(following).toBeVisible();
    await expect(page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first()).toBeFocused();
    await page.keyboard.type("After existing embed");
    await expect(following).toContainText("After existing embed");
    await expect(page.locator('[data-block-id="embed-two"]')).toBeVisible();
  });

  test("double-brace search inserts a real block embed", async ({ page }) => {
    await stubWorkspace(page, "doc_embed_typeahead");
    await page.route("**/api/mega/embed/resolve**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: {
          access: "ok", status: "ok", docId: "doc_source", blockId: "BlockRef0001", title: "Source document",
          snapshotBody: nestedTodoDocument(false), containerBody: nestedTodoDocument(false), ancestorChain: [],
          depth: 0, cycle: false, tooDeep: false,
        } }),
      });
    });
    await page.goto("/en/workspace/docs/doc_embed_typeahead");
    await page.locator('[data-mega-content="outliner"] [data-mega-block]').first().click();
    await page.keyboard.type("{{Referenced");
    const option = page.locator('[data-mega-content="embed-option"][data-embed-kind="block"]');
    await expect(option).toContainText("Referenced block");
    await option.click();
    await expect(page.locator('[data-mega-content="embed-block"][data-target-doc="doc_source"][data-target-block="BlockRef0001"]'))
      .toContainText("Parent task");
    const blocks = page.locator('[data-mega-docs="editor"] [contenteditable="true"] > [data-mega-block]');
    await expect(blocks).toHaveCount(2);
    await expect(page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first()).toBeFocused();
    await page.keyboard.type("After typeahead embed");
    await expect(blocks.nth(1)).toContainText("After typeahead embed");
  });
});
