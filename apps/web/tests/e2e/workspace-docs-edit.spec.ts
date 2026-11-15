import { expect, test } from "@playwright/test";

import { mintCollabTicket } from "@megaui/core/collab/ticket";

import { mintSessionCookies } from "./helpers/session";

const AUTHOR = {
  id: "user_author",
  displayName: "Ada",
  email: "ada@example.com",
  avatarInitials: "A",
};

/**
 * When NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL is baked into the web build (compose
 * live), force auth-failed → local autosave by minting a well-formed ticket
 * with the wrong secret.
 */
async function forceLocalAutosave(page: import("@playwright/test").Page): Promise<void> {
  const token = mintCollabTicket("local-force", "not-the-compose-collab-secret");
  await page.route("**/api/mega/collab/token**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { token, userId: "local-force", expiresAtMs: Date.now() + 3_600_000 },
      }),
    });
  });
}

function lexicalDoc(text: string): string {
  return JSON.stringify({
    root: {
      type: "root",
      version: 1,
      children: [
        {
          type: "mega-block",
          version: 1,
          blockId: "b-1",
          variant: "text",
          collapsed: false,
          todoChecked: false,
          children: [
            {
              type: "paragraph",
              version: 1,
              children: [{ type: "text", version: 1, text, detail: 0, format: 0, mode: "normal", style: "" }],
              direction: "ltr",
              format: "",
              indent: 0,
            },
          ],
          direction: null,
          format: "",
          indent: 0,
        },
      ],
      direction: null,
      format: "",
      indent: 0,
    },
  });
}

async function stubRail(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/api/mega/channels**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
  await page.route("**/api/mega/notifications/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { count: 0 } }),
    });
  });
}

test.describe("workspace docs edit + graph (WA-13)", () => {
  test.beforeEach(async ({ context }) => {
    const { cookies } = mintSessionCookies();
    await context.addCookies(cookies);
  });

  const collabUrlBaked = Boolean(process.env.NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL?.trim());

  test("edit autosave then reopen shows saved content", async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(
      collabUrlBaked,
      "Local autosave path; skipped when collab URL is baked (live collab covered by workspace-collab)",
    );
    await stubRail(page);
    await forceLocalAutosave(page);
    let body = lexicalDoc("Initial draft body.");
    let updatedAt = "2026-01-01T00:00:00.000Z";

    await page.route("**/api/mega/docs**", async (route) => {
      const url = route.request().url();
      const method = route.request().method();

      if (url.includes("/save") && method === "POST") {
        const payload = route.request().postDataJSON() as { body: string };
        body = payload.body;
        updatedAt = "2026-01-02T00:00:00.000Z";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              id: "doc_edit",
              title: "Editable doc",
              body,
              excerpt: "",
              author: AUTHOR,
              collaborators: [],
              tags: [],
              linkedCLs: [],
              linkedIssues: [],
              versions: [],
              starred: false,
              preview: [],
              viewCount: 0,
              commentCount: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt,
            },
          }),
        });
        return;
      }

      if (url.includes("/view") && method === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: { ok: true } }),
        });
        return;
      }

      if (url.includes("/comments") || url.includes("/backlinks") || url.includes("/unlinked")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: url.includes("/backlinks") || url.includes("/unlinked") ? { items: [] } : [],
          }),
        });
        return;
      }

      if (/\/api\/mega\/docs\/[^/?]+/.test(url) && method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              id: "doc_edit",
              title: "Editable doc",
              body,
              excerpt: "",
              author: AUTHOR,
              collaborators: [],
              tags: [],
              linkedCLs: [],
              linkedIssues: [],
              versions: [],
              starred: false,
              preview: [],
              viewCount: 0,
              commentCount: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt,
            },
          }),
        });
        return;
      }

      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
    });

    await page.goto("/en/workspace/docs/doc_edit/edit");
    await expect(page).toHaveURL(/\/en\/workspace\/docs\/doc_edit$/);
    await expect(page).not.toHaveURL(/[?&]v=/);
    await expect(page.locator('[data-mega-docs="page-write"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-mega-docs="editor"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-mega-docs="page-write"] [data-mega-docs="edit-entry"]')).toHaveCount(0);
    await expect(page.locator('[data-mega-docs="chrome"] [data-mega-docs="save-state"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="chrome"] [data-mega-docs="collab-mode"]')).toHaveAttribute(
      "data-mode",
      "local",
      { timeout: 20_000 },
    );
    await expect(page.locator('[data-mega-docs="detail-title"]')).toHaveText("Editable doc");
    const editorBorder = await page.locator('[data-mega-docs="editor"]').evaluate((el) => {
      const style = getComputedStyle(el);
      return `${style.borderTopWidth} ${style.borderTopStyle}`;
    });
    expect(editorBorder).not.toMatch(/1px\s+solid/);
    const editable = page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first();
    await editable.click();
    await page.keyboard.type(" WA13-save-marker");
    await expect(page.locator('[data-mega-docs="save-state"]')).toHaveAttribute("data-state", "saved", {
      timeout: 8_000,
    });
    expect(body).toContain("WA13-save-marker");

    await page.goto("/en/workspace/docs/doc_edit");
    await expect(page.locator('[data-mega-docs="page-write"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="editor"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-mega-docs="editor"]')).toContainText("WA13-save-marker", {
      timeout: 10_000,
    });
    await expect(page.locator('[data-mega-docs="reader"]')).toHaveCount(0);
  });

  test("save conflict shows toast", async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(
      collabUrlBaked,
      "Local autosave conflict path; skipped when collab URL is baked",
    );
    await stubRail(page);
    await forceLocalAutosave(page);
    await page.route("**/api/mega/docs**", async (route) => {
      const url = route.request().url();
      const method = route.request().method();
      if (url.includes("/save") && method === "POST") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "MEGA_CONFLICT", messageKey: "errors.mega.conflict", message: "conflict" },
          }),
        });
        return;
      }
      if (url.includes("/comments") || url.includes("/backlinks") || url.includes("/unlinked")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: url.includes("/backlinks") || url.includes("/unlinked") ? { items: [] } : [],
          }),
        });
        return;
      }
      if (/\/api\/mega\/docs\/[^/?]+/.test(url) && method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              id: "doc_conflict",
              title: "Conflict doc",
              body: lexicalDoc("Conflict base."),
              excerpt: "",
              author: AUTHOR,
              collaborators: [],
              tags: [],
              linkedCLs: [],
              linkedIssues: [],
              versions: [],
              starred: false,
              preview: [],
              viewCount: 0,
              commentCount: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
    });

    await page.goto("/en/workspace/docs/doc_conflict/edit");
    await expect(page).toHaveURL(/\/en\/workspace\/docs\/doc_conflict$/);
    await expect(page.locator('[data-mega-docs="page-write"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-mega-docs="editor"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-mega-docs="chrome"] [data-mega-docs="collab-mode"]')).toHaveAttribute(
      "data-mode",
      "local",
      { timeout: 20_000 },
    );
    const editable = page.locator('[data-mega-docs="editor"] [contenteditable="true"]').first();
    await editable.click();
    await page.keyboard.type(" boom");
    await expect(page.locator('[data-mega-docs="toast"][data-mega-toast="error"]')).toContainText(
      "updated elsewhere",
      { timeout: 8_000 },
    );
    await expect(page.locator('[data-mega-docs="save-state"]')).toHaveAttribute("data-state", "conflict");
  });

  test("graph renders nodes and click navigates", async ({ page }) => {
    await stubRail(page);
    await page.route("**/api/mega/graph**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            nodes: [
              {
                id: "doc:doc_a",
                kind: "doc",
                entityId: "doc_a",
                title: "Doc Alpha",
                href: "/docs/doc_a",
              },
              {
                id: "issue:1",
                kind: "issue",
                entityId: "issue_1",
                entityNumber: 1,
                title: "Issue One",
                href: "/issues/1",
              },
            ],
            edges: [
              {
                id: "e1",
                kind: "wikilink",
                sourceNodeId: "doc:doc_a",
                targetNodeId: "issue:1",
              },
            ],
          },
        }),
      });
    });
    await page.route("**/api/mega/docs**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "doc_a",
            title: "Doc Alpha",
            body: lexicalDoc("From graph click."),
            excerpt: "",
            author: AUTHOR,
            collaborators: [],
            tags: [],
            linkedCLs: [],
            linkedIssues: [],
            versions: [],
            starred: false,
            preview: [],
            viewCount: 0,
            commentCount: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      });
    });

    await page.goto("/en/workspace/docs/graph");
    await expect(page.locator('[data-mega-docs="graph-view"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-mega-docs="graph-node"]')).toHaveCount(2);
    await page.locator('[data-mega-docs="graph-node"][data-kind="doc"]').click();
    await expect(page).toHaveURL(/\/en\/workspace\/docs\/doc_a/);
  });

  test("graph empty state", async ({ page }) => {
    await stubRail(page);
    await page.route("**/api/mega/graph**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { nodes: [], edges: [] } }),
      });
    });
    await page.goto("/en/workspace/docs/graph");
    await expect(page.locator('[data-mega-docs="graph-empty"]')).toBeVisible();
  });
});
