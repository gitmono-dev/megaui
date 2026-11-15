import type { Page } from "@playwright/test";

const AUTHOR = {
  id: "user_roam",
  displayName: "Roam Tester",
  email: "roam@example.com",
  avatarInitials: "R",
};

function emptyLexicalDocument(): string {
  return JSON.stringify({
    root: {
      type: "root",
      version: 1,
      children: [
        {
          type: "mega-block",
          version: 1,
          blockId: "roam-empty-block",
          variant: "text",
          collapsed: false,
          todoChecked: false,
          children: [],
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

export function lexicalDocumentWithText(text: string): string {
  return JSON.stringify({
    root: {
      type: "root",
      version: 1,
      children: [
        {
          type: "mega-block",
          version: 1,
          blockId: "roam-text-block",
          variant: "text",
          collapsed: false,
          todoChecked: false,
          children: [{ detail: 0, format: 0, mode: "normal", style: "", text, type: "text", version: 1 }],
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

/** A parent, its child, and a sibling make focused-block isolation observable. */
export function lexicalDocumentWithBlockTree(): string {
  const text = (value: string) => ({ detail: 0, format: 0, mode: "normal", style: "", text: value, type: "text", version: 1 });
  const block = (blockId: string, value: string, children: readonly object[] = []) => ({
    type: "mega-block",
    version: 1,
    blockId,
    variant: "text",
    collapsed: false,
    todoChecked: false,
    children: [text(value), ...children],
    direction: null,
    format: "",
    indent: 0,
  });

  return JSON.stringify({
    root: {
      type: "root",
      version: 1,
      children: [
        block("roam-focus-block", "Focused block", [block("roam-focused-child", "Focused child")]),
        block("roam-hidden-sibling", "Hidden sibling"),
      ],
      direction: null,
      format: "",
      indent: 0,
    },
  });
}

export async function stubWorkspace(
  page: Page,
  docId: string,
  body = emptyLexicalDocument(),
): Promise<{ resolveOrCreateCalls: () => number }> {
  let resolveOrCreateCalls = 0;
  const doc = {
    id: docId,
    title: "Empty outliner",
    body,
    excerpt: "",
    author: AUTHOR,
    collaborators: [AUTHOR],
    tags: [],
    linkedCLs: [],
    linkedIssues: [],
    versions: [
      {
        id: "version_roam_empty",
        version: 1,
        author: AUTHOR,
        createdAt: "2026-09-19T00:00:00.000Z",
        summary: "Empty document",
        body,
      },
    ],
    starred: false,
    preview: [],
    status: "draft",
    viewCount: 0,
    commentCount: 0,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  };

  await page.route("**/api/mega/channels**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
  await page.route("**/api/mega/notifications/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { count: 0 } }) });
  });
  await page.route("**/api/mega/search**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    const searchBody = query
      ? {
          docs: [
            {
              kind: "doc",
              sourceId: "doc_source",
              blockId: "BlockRef0001",
              title: "Source document",
              snippet: "Referenced block",
            },
          ],
        }
      : { docs: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { body: searchBody } }) });
  });
  await page.route("**/api/mega/blocks/resolve**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      targetDocId: params.get("doc") || "doc_source", targetBlockId: params.get("block"),
      label: params.get("block") === "BlockRef0001" ? "Referenced block" : `((${params.get("block")}))`,
      status: params.get("block") === "BlockRef0001" ? "ok" : "unresolved",
    } }) });
  });
  await page.route("**/api/mega/docs**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes("/title-index")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            { kind: "doc", targetId: "doc_planning", targetTitle: "Planning" },
            { kind: "doc", targetId: "doc_roadmap", targetTitle: "Roadmap" },
            { kind: "issue", targetId: "42", targetTitle: "Fix shortcut issue" },
          ],
        }),
      });
      return;
    }
    if (url.includes("/resolve-or-create") && method === "POST") {
      resolveOrCreateCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { targetId: "doc_created", created: true } }),
      });
      return;
    }
    if (url.includes("/comments")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
      return;
    }
    if (url.includes("/backlinks") || url.includes("/unlinked")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { items: [] } }) });
      return;
    }
    if (url.includes("/view") || url.includes("/save") || (/\/api\/mega\/docs\/[^/?]+/.test(url) && method === "GET")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: doc }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [doc] }) });
  });
  return { resolveOrCreateCalls: () => resolveOrCreateCalls };
}
