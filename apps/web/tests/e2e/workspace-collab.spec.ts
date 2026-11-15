/**
 * CS-01 dual-client collab e2e (WA-13 联测).
 * Spawns a real collab-server process and asserts Yjs convergence.
 * When NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL is baked into the web build,
 * also asserts the edit page enters collab mode.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

import { mintCollabTicket } from "@megaui/core/collab/ticket";

import { mintSessionCookies } from "./helpers/session";
import { e2eBaseURL } from "./helpers/base-url";

const SECRET = "e2e-collab-secret-cs01";
/** Compose `megaui-collab` verifies tickets with MEGA_COLLAB_INTERNAL_TOKEN. */
const uiTicketSecret =
  process.env.MEGA_COLLAB_INTERNAL_TOKEN?.trim() || SECRET;

async function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForHealth(port: number, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("collab-server health timed out");
}

function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolveWait, reject) => {
    const tick = () => {
      if (predicate()) {
        resolveWait();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitFor timeout"));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

test.describe("workspace collab (CS-01)", () => {
  let child: ChildProcess | null = null;
  let port = 0;

  test.beforeAll(async () => {
    port = await reservePort();
    child = spawn(
      "pnpm",
      ["exec", "tsx", "--tsconfig", "apps/collab-server/tsconfig.json", "apps/collab-server/src/index.ts"],
      {
        cwd: resolve(process.cwd()),
        env: {
          ...process.env,
          MEGA_COLLAB_PORT: String(port),
          MEGA_COLLAB_BIND: "127.0.0.1",
          MEGA_COLLAB_INTERNAL_TOKEN: SECRET,
          MEGA_COLLAB_DEV_ALLOW_AUTHENTICATED: "1",
          MEGA_COLLAB_QUIET: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await waitForHealth(port);
  });

  test.afterAll(async () => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (!child.killed) child.kill("SIGKILL");
    }
    child = null;
  });

  test("two clients sync edits on container:doc room", async () => {
    const wsUrl = `ws://127.0.0.1:${port}`;
    const room = "container:doc:e2e-shared";
    const yA = new Y.Doc();
    const yB = new Y.Doc();
    const a = new HocuspocusProvider({
      url: wsUrl,
      name: room,
      document: yA,
      token: mintCollabTicket("e2e-a", SECRET),
    });
    const b = new HocuspocusProvider({
      url: wsUrl,
      name: room,
      document: yB,
      token: mintCollabTicket("e2e-b", SECRET),
    });

    await waitFor(() => a.synced && b.synced);
    yA.getText("body").insert(0, "dual-client-ok");
    await waitFor(() => yB.getText("body").toString() === "dual-client-ok");
    expect(yB.getText("body").toString()).toBe("dual-client-ok");

    a.destroy();
    b.destroy();
  });

  test("edit page shows collab mode when public URL is configured", async ({ browser }) => {
    test.skip(
      !process.env.NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL?.trim(),
      "NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL not baked into web build",
    );

    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();

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
    await page.route("**/api/mega/collab/token**", async (route) => {
      const token = mintCollabTicket("e2e-ui", uiTicketSecret);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { token, userId: "e2e-ui", expiresAtMs: Date.now() + 3_600_000 },
        }),
      });
    });
    await page.route("**/api/mega/docs/**", async (route) => {
      const url = route.request().url();
      const method = route.request().method();
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
      if (url.includes("/view") && method === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: { ok: true } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "doc_collab",
            title: "Collab doc",
            body: JSON.stringify({
              root: {
                type: "root",
                version: 1,
                children: [],
                direction: null,
                format: "",
                indent: 0,
              },
            }),
            excerpt: "",
            author: { id: "e2e-ui", displayName: "E2E", email: "e2e@example.com", avatarInitials: "E" },
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

    await page.goto("/en/workspace/docs/doc_collab/edit");
    await expect(page.locator('[data-mega-docs="collab-mode"]')).toHaveAttribute("data-mode", "collab", {
      timeout: 20_000,
    });
    await context.close();
  });
});
