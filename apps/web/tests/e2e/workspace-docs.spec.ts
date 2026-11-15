import { expect, test } from "@playwright/test";

import { mintSessionCookies, type SessionCookie } from "./helpers/session";

const AUTHOR = {
  id: "user_author",
  displayName: "Ada",
  email: "ada@example.com",
  avatarInitials: "A",
};

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

const SAMPLE_DOC = {
  id: "doc_welcome",
  title: "Welcome to Mega Docs",
  body: lexicalDoc("Hello from WA-12 reader blocks."),
  excerpt: "Hello from WA-12",
  author: AUTHOR,
  collaborators: [AUTHOR],
  tags: [],
  linkedCLs: [],
  linkedIssues: [],
  versions: [
    {
      id: "ver_1",
      version: 1,
      author: AUTHOR,
      createdAt: "2026-01-01T00:00:00.000Z",
      summary: "Initial",
      body: lexicalDoc("Snapshot body v1."),
    },
  ],
  starred: false,
  preview: ["Hello from WA-12"],
  status: "draft",
  viewCount: 3,
  commentCount: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const SAMPLE_COMMENT = {
  id: "dc_1",
  docId: "doc_welcome",
  author: AUTHOR,
  body: "Nice doc.",
  createdAt: "2026-01-01T12:00:00.000Z",
  reactions: [],
};

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

async function stubDocsApis(
  page: import("@playwright/test").Page,
  options?: {
    emptyBody?: boolean;
    emptyList?: boolean;
    failList?: boolean;
    failRestore?: boolean;
    failComment?: boolean;
    missingDoc?: boolean;
  },
): Promise<void> {
  await stubRail(page);
  let doc = options?.emptyBody
    ? {
        ...SAMPLE_DOC,
        starred: false,
        body: lexicalDoc(""),
        versions: SAMPLE_DOC.versions.map((version) => ({ ...version, body: lexicalDoc("") })),
      }
    : { ...SAMPLE_DOC, starred: false };
  let comments = [SAMPLE_COMMENT];

  await page.route("**/api/mega/docs**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (options?.failList && /\/api\/mega\/docs(\?|$)/.test(url) && method === "GET") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "MEGA_INTERNAL_ERROR", messageKey: "errors.mega.internal", message: "boom" },
        }),
      });
      return;
    }

    if (/\/api\/mega\/docs(\?|$)/.test(url) && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: options?.emptyList ? [] : [doc] }),
      });
      return;
    }

    if (/\/api\/mega\/docs(\?|$)/.test(url) && method === "POST") {
      const body = route.request().postDataJSON() as { title: string };
      const created = { ...SAMPLE_DOC, id: "doc_new", title: body.title, versions: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: created }) });
      return;
    }

    if (url.includes("/comments") && method === "POST") {
      if (options?.failComment) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "MEGA_FORBIDDEN", messageKey: "errors.mega.forbidden", message: "forbidden" },
          }),
        });
        return;
      }
      const posted = route.request().postDataJSON() as { body: string };
      const created = {
        ...SAMPLE_COMMENT,
        id: `dc_${comments.length + 1}`,
        body: posted.body,
      };
      comments = [...comments, created];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: created }),
      });
      return;
    }

    if (url.includes("/comments") && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: comments }),
      });
      return;
    }

    if (url.includes("/backlinks") && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            items: [
              {
                sourceType: "doc",
                sourceId: "doc_other",
                sourceTitle: "Related design notes",
                contextSummary: null,
                href: "/docs/doc_other",
              },
            ],
          },
        }),
      });
      return;
    }

    if (url.includes("/unlinked") && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            items: [
              {
                kind: "doc",
                targetId: "doc_orphan",
                targetTitle: "Orphan mention",
              },
            ],
          },
        }),
      });
      return;
    }

    if (url.includes("/toggle-star") && method === "POST") {
      doc = { ...doc, starred: !doc.starred };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: doc }) });
      return;
    }

    if (url.includes("/view") && method === "POST") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: doc }) });
      return;
    }

    if (url.includes("/save") && method === "POST") {
      if (options?.failRestore) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "MEGA_FORBIDDEN", messageKey: "errors.mega.forbidden", message: "forbidden" },
          }),
        });
        return;
      }
      const body = route.request().postDataJSON() as { body?: string; summary?: string };
      const nextBody = body.body ?? doc.body;
      doc = {
        ...doc,
        body: nextBody,
        versions: [
          ...doc.versions,
          {
            id: "ver_restored",
            version: doc.versions.length + 1,
            author: AUTHOR,
            createdAt: "2026-01-03T00:00:00.000Z",
            summary: body.summary ?? "Restored",
            body: nextBody,
          },
        ],
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: doc }) });
      return;
    }

    if (/\/api\/mega\/docs\/[^/?]+(\?|$)/.test(url) && method === "GET") {
      if (options?.missingDoc || url.includes("/missing")) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "MEGA_NOT_FOUND", messageKey: "errors.mega.notFound", message: "missing" },
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: doc }) });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
}

test.describe("workspace docs guest (RO-01)", () => {
  test("unsigned visitor never sees the editor", async ({ page }) => {
    await page.goto("/en/workspace/docs/doc_welcome");
    await expect(page).toHaveURL(/\/en\/signin/);
    await expect(page.locator('[data-mega-docs="editor"]')).toHaveCount(0);
  });
});

test.describe("workspace docs (WA-12)", () => {
  test.describe.configure({ mode: "serial" });

  let sessionCookies: SessionCookie[];

  test.beforeAll(() => {
    sessionCookies = mintSessionCookies().cookies;
  });

  test.beforeEach(async ({ context }) => {
    await context.addCookies(sessionCookies);
  });

  test("library grid + new entry", async ({ page }) => {
    await stubDocsApis(page);
    await page.goto("/en/workspace/docs");
    await expect(page.locator('[data-mega-docs="grid"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="card"]')).toContainText("Welcome to Mega Docs");
    await page.locator('[data-mega-docs="header-new"]').click();
    await expect(page.locator('[data-mega-docs="new-dialog"]')).toBeVisible();
  });

  test("library starred filter", async ({ page }) => {
    await stubRail(page);
    const starred = { ...SAMPLE_DOC, id: "doc_star", title: "Starred only", starred: true };
    const plain = { ...SAMPLE_DOC, id: "doc_plain", title: "Plain doc", starred: false };
    await page.route("**/api/mega/docs**", async (route) => {
      const url = route.request().url();
      if (/\/api\/mega\/docs(\?|$)/.test(url) && route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: [starred, plain] }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
    });
    await page.goto("/en/workspace/docs");
    await expect(page.locator('[data-mega-docs="card"]')).toHaveCount(2);
    await page.locator('[data-mega-docs="nav"][data-nav="starred"]').click();
    await expect(page).toHaveURL(/filter=starred/);
    await expect(page.locator('[data-mega-docs="card"]')).toHaveCount(1);
    await expect(page.locator('[data-mega-docs="card"]')).toContainText("Starred only");
  });

  test("library empty + search filter", async ({ page }) => {
    await stubDocsApis(page, { emptyList: true });
    await page.goto("/en/workspace/docs");
    await expect(page.locator('[data-mega-docs="empty"]')).toBeVisible();
  });

  test("library search and title sort", async ({ page }) => {
    await stubRail(page);
    const zebra = { ...SAMPLE_DOC, id: "doc_z", title: "Zebra pack", updatedAt: "2026-03-01T00:00:00.000Z" };
    const alpha = { ...SAMPLE_DOC, id: "doc_a", title: "Alpha notes", updatedAt: "2026-01-01T00:00:00.000Z" };
    await page.route("**/api/mega/docs**", async (route) => {
      const url = route.request().url();
      if (/\/api\/mega\/docs(\?|$)/.test(url) && route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: [zebra, alpha] }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
    });
    await page.goto("/en/workspace/docs");
    await expect(page.locator('[data-mega-docs="card"]').first()).toContainText("Zebra pack");
    await page.locator('[data-mega-docs="sort"]').click();
    await expect(page).toHaveURL(/sort=title/);
    await expect(page.locator('[data-mega-docs="card"]').first()).toContainText("Alpha notes");
    await page.locator('[data-mega-docs="search"]').fill("Zebra");
    await expect(page).toHaveURL(/q=Zebra/);
    await expect(page.locator('[data-mega-docs="card"]')).toHaveCount(1);
    await expect(page.locator('[data-mega-docs="card"]')).toContainText("Zebra pack");
  });

  test("library folder and tag filters", async ({ page }) => {
    await stubRail(page);
    const rust = {
      ...SAMPLE_DOC,
      id: "doc_rust",
      title: "Rust folder doc",
      folderId: "rust",
      tags: [{ id: "rfc", name: "RFC", color: "#2563eb" }],
    };
    const loose = { ...SAMPLE_DOC, id: "doc_loose", title: "Loose doc", tags: [] };
    await page.route("**/api/mega/docs**", async (route) => {
      const url = route.request().url();
      if (/\/api\/mega\/docs(\?|$)/.test(url) && route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: [rust, loose] }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
    });
    await page.goto("/en/workspace/docs");
    await expect(page.locator('[data-mega-docs="card"]')).toHaveCount(2);
    await page.locator('[data-mega-docs="scope-folder"][data-folder-id="rust"]').click();
    await expect(page).toHaveURL(/folder=rust/);
    await expect(page.locator('[data-mega-docs="card"]')).toHaveCount(1);
    await expect(page.locator('[data-mega-docs="card"]')).toContainText("Rust folder doc");
    await page.locator('[data-mega-docs="scope-tag"][data-tag-id="rfc"]').click();
    await expect(page).toHaveURL(/tag=rfc/);
    await expect(page.locator('[data-mega-docs="card"]')).toContainText("Rust folder doc");
  });

  test("library error retry", async ({ page }) => {
    await stubDocsApis(page, { failList: true });
    await page.goto("/en/workspace/docs");
    await expect(page.locator('[data-mega-docs="page"] [role="alert"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="retry"]')).toBeVisible();
  });

  test("signed-in latest page is writable", async ({ page }) => {
    await stubDocsApis(page);
    await page.goto("/en/workspace/docs/doc_welcome");
    await expect(page.locator('[data-mega-docs="page-write"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="editor"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-mega-docs="editor"]')).toContainText("Hello from WA-12 reader blocks");
    await expect(page.locator('[data-mega-docs="reader"]')).toHaveCount(0);
    await expect(page.locator('[data-mega-docs="page-write"] [data-mega-docs="edit-entry"]')).toHaveCount(0);
    await expect(page.locator('[data-mega-docs="page-write"] [data-mega-docs="empty-body"]')).toHaveCount(0);
    await expect(page.locator('[data-mega-docs="chrome"] [data-mega-docs="save-state"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="chrome"] [data-mega-docs="collab-mode"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="detail-title"]')).toHaveText("Welcome to Mega Docs");
    await expect(page.locator('[data-mega-docs="linked-ref"]')).toContainText("Related design notes");
    await expect(page.locator('[data-mega-docs="unlinked-ref"]')).toContainText("Orphan mention");
    await expect(page.locator('[data-mega-docs="backlinks"]')).toHaveCount(0);
    await expect(page.locator('[data-mega-docs="comment"]')).toContainText("Nice doc");
    const editorBorder = await page.locator('[data-mega-docs="editor"]').evaluate((el) => {
      const style = getComputedStyle(el);
      return `${style.borderTopWidth} ${style.borderTopStyle}`;
    });
    expect(editorBorder).not.toMatch(/1px\s+solid/);
  });

  test("linked and unlinked refs sit below the body (new)", async ({ page }) => {
    await stubDocsApis(page);
    await page.goto("/en/workspace/docs/doc_welcome");
    await expect(page.locator('[data-mega-docs="page-write"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="editor"]')).toBeVisible({ timeout: 20_000 });
    const editor = page.locator('[data-mega-docs="editor"]');
    const linked = page.locator('[data-mega-docs="linked-refs"]');
    const unlinked = page.locator('[data-mega-docs="unlinked-refs"]');
    const comments = page.locator('[data-mega-docs="comments"]');
    await expect(linked).toBeVisible();
    await expect(unlinked).toBeVisible();
    await expect(page.locator('[data-mega-docs="linked-ref"]')).toHaveCount(1);
    await expect(page.locator('[data-mega-docs="unlinked-ref"]')).toHaveCount(1);
    const editorBottom = await editor.evaluate((el) => el.getBoundingClientRect().bottom);
    const linkedTop = await linked.evaluate((el) => el.getBoundingClientRect().top);
    const unlinkedTop = await unlinked.evaluate((el) => el.getBoundingClientRect().top);
    const commentsTop = await comments.evaluate((el) => el.getBoundingClientRect().top);
    expect(editorBottom).toBeLessThanOrEqual(linkedTop);
    expect(linkedTop).toBeLessThan(unlinkedTop);
    expect(unlinkedTop).toBeLessThan(commentsTop);
  });

  for (const suffix of ["", "?block=b-1"]) {
    test(`backlinks group repeated sources with superscript counts (${suffix ? "focused" : "full page"})`, async ({ page }) => {
      await stubDocsApis(page);
      const source = {
        sourceType: "doc",
        sourceId: "doc_other",
        sourceTitle: "Mega",
        contextSummary: null,
        href: "/docs/doc_other",
      };
      await page.route("**/api/mega/docs/doc_welcome/backlinks", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: { items: [
            source,
            { ...source, sourceId: "doc_same_title", href: "/docs/doc_same_title" },
            { ...source, targetBlockId: "b-1", contextSummary: "Block embed" },
            { ...source, sourceType: "issue", href: "/issues/doc_other" },
          ] } }),
        });
      });
      await page.goto(`/en/workspace/docs/doc_welcome${suffix}`);
      const references = page.locator('[data-mega-docs="linked-ref"]');
      await expect(references).toHaveCount(3);
      const repeated = references.nth(0);
      await expect(repeated.locator("a")).toHaveText("Mega2");
      await expect(repeated.locator("a")).toHaveAttribute("href", "/en/workspace/docs/doc_other");
      await expect(repeated.locator("sup")).toHaveText("2");
      await expect(references.nth(1).locator("a")).toHaveAttribute("href", "/en/workspace/docs/doc_same_title");
      await expect(references.nth(2).locator("a")).toHaveAttribute("href", "/en/workspace/issues/doc_other");
      await expect(references.nth(1).locator("sup")).toHaveCount(0);
      await expect(references.nth(2).locator("sup")).toHaveCount(0);
      const positions = await repeated.evaluate((el) => {
        const link = el.querySelector("a")!;
        const title = document.createRange();
        title.selectNodeContents(link.firstChild!);
        return { titleTop: title.getBoundingClientRect().top, countTop: el.querySelector("sup")!.getBoundingClientRect().top };
      });
      expect(positions.countTop).toBeLessThan(positions.titleTop);
    });
  }

  test("writable empty body has no empty-body CTA", async ({ page }) => {
    await stubDocsApis(page, { emptyBody: true });
    await page.goto("/en/workspace/docs/doc_welcome");
    await expect(page.locator('[data-mega-docs="page-write"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="editor"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-mega-docs="empty-body"]')).toHaveCount(0);
    await expect(page.locator('[data-mega-docs="edit-entry"]')).toHaveCount(0);
    await expect(page.locator('[data-mega-docs="detail-title"]')).toHaveText("Welcome to Mega Docs");
  });

  test("readonly empty snapshot has empty-body without /edit", async ({ page }) => {
    await stubDocsApis(page, { emptyBody: true });
    await page.goto("/en/workspace/docs/doc_welcome?v=1");
    await expect(page.locator('[data-mega-docs="detail"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="empty-body"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="empty-body"] a[href*="/edit"]')).toHaveCount(0);
    await expect(page.locator('[data-mega-docs="detail-title"]')).toHaveText("Welcome to Mega Docs");
    await expect(page.locator('[data-mega-docs="edit-entry"]')).toHaveAttribute(
      "href",
      "/en/workspace/docs/doc_welcome",
    );
    await expect(page.locator('[data-mega-docs="chrome"] [data-mega-docs="save-state"]')).toHaveCount(0);
  });

  test("snapshot query keeps the page readonly even before body resolves", async ({ page }) => {
    await stubDocsApis(page);
    await page.goto("/en/workspace/docs/doc_welcome?v=999");
    await expect(page.locator('[data-mega-docs="detail"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="editor"]')).toHaveCount(0);
    await expect(page.locator('[data-mega-docs="page-write"]')).toHaveCount(0);
  });

  test("reader comment composer visibility (new)", async ({ page }) => {
    await stubDocsApis(page);
    await page.goto("/en/workspace/docs/doc_welcome");
    await expect(page.locator('[data-mega-docs="composer"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="comment-draft"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="comment-submit"]')).toBeVisible();

    await page.goto("/en/workspace/docs/doc_welcome?v=1");
    await expect(page.locator('[data-mega-docs="snapshot-banner"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="composer"]')).toHaveCount(0);
  });

  test("reader comment submit adds body to list (new)", async ({ page }) => {
    await stubDocsApis(page);
    await page.goto("/en/workspace/docs/doc_welcome");
    await page.locator('[data-mega-docs="comment-draft"]').fill("Composer body from e2e");
    await page.locator('[data-mega-docs="comment-submit"]').click();
    await expect(page.locator('[data-mega-docs="comment"]').filter({ hasText: "Composer body from e2e" })).toBeVisible();
    await expect(page.locator('[data-mega-docs="toast"][data-mega-toast="success"]')).toContainText("Comment added");
  });

  test("reader comment submit error toast (new)", async ({ page }) => {
    await stubDocsApis(page, { failComment: true });
    await page.goto("/en/workspace/docs/doc_welcome");
    await page.locator('[data-mega-docs="comment-draft"]').fill("Will fail");
    await page.locator('[data-mega-docs="comment-submit"]').click();
    await expect(page.locator('[data-mega-docs="toast"][data-mega-toast="error"]')).toContainText(
      "You do not have permission",
    );
  });

  test("version snapshot + restore success", async ({ page }) => {
    await stubDocsApis(page);
    await page.goto("/en/workspace/docs/doc_welcome?v=1");
    await expect(page.locator('[data-mega-docs="snapshot-banner"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="detail-title"]')).toHaveText("Welcome to Mega Docs");
    await expect(page.locator('[data-mega-docs="reader"]')).toContainText("Snapshot body v1");
    await expect(page.locator('[data-mega-docs="edit-entry"]')).toHaveAttribute(
      "href",
      "/en/workspace/docs/doc_welcome",
    );
    await page.locator('[data-mega-docs="restore"]').click();
    await expect(page.locator('[data-mega-docs="toast"][data-mega-toast="success"]')).toContainText("Version restored");
  });

  test("version restore forbidden toast", async ({ page }) => {
    await stubDocsApis(page, { failRestore: true });
    await page.goto("/en/workspace/docs/doc_welcome?v=1");
    await page.locator('[data-mega-docs="restore"]').click();
    await expect(page.locator('[data-mega-docs="toast"][data-mega-toast="error"]')).toContainText(
      "You do not have permission",
    );
  });

  test("missing doc shows not-found", async ({ page }) => {
    await stubDocsApis(page, { missingDoc: true });
    await page.goto("/en/workspace/docs/missing");
    await expect(page.locator('[data-mega-docs="not-found"]')).toBeVisible();
  });

  test("zh-CN docs library", async ({ page }) => {
    await stubDocsApis(page);
    await page.goto("/zh-CN/workspace/docs");
    await expect(page.locator('[data-mega-docs="page"]')).toBeVisible();
    await expect(page.locator('[data-mega-docs="search"]')).toBeVisible();
  });
});
