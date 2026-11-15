/**
 * RT-09 two-client chat realtime + collab-down polling fallback.
 * Uses the real BFF (no route stubs). Compose web/collab is preferred;
 * a local collab-server is spawned for the transport assertion so the
 * spec never treats skip as pass.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

import { mintCollabTicket } from "@megaui/core/collab/ticket";

import { e2eBaseURL } from "./helpers/base-url";
import { mintSessionCookies } from "./helpers/session";

const SECRET = "e2e-chat-live-collab-secret";

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

async function waitForHealth(url: string, timeoutMs = 8_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // retry
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  return false;
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

async function resolveSessionUserId(context: BrowserContext): Promise<string> {
  const response = await context.request.get("/api/auth/get-session");
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as { user?: { id?: string } };
  const userId = payload.user?.id;
  expect(userId).toBeTruthy();
  return userId!;
}

function stopLocalCollabOnPort(port: number): void {
  try {
    execFileSync("bash", ["-lc", `lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill -TERM`], {
      stdio: "ignore",
    });
  } catch {
    // already down
  }
}

function stopComposeCollab(): void {
  try {
    execFileSync(
      "docker",
      [
        "compose",
        "-p",
        "mega2-it",
        "-f",
        resolve(process.cwd(), "../mega2/docker-compose.test.yml"),
        "stop",
        "megaui-collab",
      ],
      { stdio: "ignore" },
    );
  } catch {
    // compose project may not exist
  }
}

async function readChannelUnread(request: APIRequestContext, channelId: string): Promise<number> {
  const response = await request.get("/api/mega/channels");
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as { data?: Array<{ id: string; unreadCount?: number }> };
  const channel = payload.data?.find((item) => item.id === channelId);
  return channel?.unreadCount ?? 0;
}

async function openAuthedPage(
  browser: Browser,
  cookies: ReturnType<typeof mintSessionCookies>["cookies"],
  baseURL: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL });
  await context.addCookies(cookies);
  const page = await context.newPage();
  return { context, page };
}

test.describe("workspace chat live (RT-09)", () => {
  test.describe.configure({ mode: "serial" });
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
    const healthy = await waitForHealth(`http://127.0.0.1:${port}/health`, 15_000);
    if (!healthy) {
      throw new Error("local collab-server health timed out (RT-09 transport gate)");
    }
  });

  test.afterAll(async () => {
    if (child) {
      child.kill("SIGTERM");
      child = null;
    }
  });

  test("two collection-room clients converge after internal append/bump", async () => {
    const roomName = "collection:channel:e2e-live";
    const wsUrl = `ws://127.0.0.1:${port}`;
    const yA = new Y.Doc();
    const yB = new Y.Doc();
    const providerA = new HocuspocusProvider({
      url: wsUrl,
      name: roomName,
      document: yA,
      token: mintCollabTicket("e2e-a", SECRET, { roomName }),
    });
    const providerB = new HocuspocusProvider({
      url: wsUrl,
      name: roomName,
      document: yB,
      token: mintCollabTicket("e2e-b", SECRET, { roomName }),
    });
    await waitFor(() => Boolean(providerA.synced && providerB.synced));

    const append = await fetch(`http://127.0.0.1:${port}/internal/collection/append`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roomName, childId: "msg-live-1" }),
    });
    expect(append.status).toBe(200);
    await waitFor(() => yB.getArray<string>("childIds").toArray().includes("msg-live-1"));

    const bump = await fetch(`http://127.0.0.1:${port}/internal/collection/bump`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roomName, kind: "reaction", messageId: "msg-live-1", at: 7 }),
    });
    expect(bump.status).toBe(200);
    await waitFor(() => yB.getMap("revision").get("kind") === "reaction");

    providerA.destroy();
    providerB.destroy();
  });

  test("two browsers see send/edit/reaction and unread does not double-count", async ({
    browser,
  }) => {
    const composeWeb = await waitForHealth("http://127.0.0.1:17001/api/health", 1_000);
    const composeCollab = await waitForHealth("http://127.0.0.1:17002/health", 1_000);
    const localWeb = await waitForHealth(`${e2eBaseURL()}/api/health`, 1_000);
    const baseURL = composeWeb && composeCollab ? "http://127.0.0.1:17001" : e2eBaseURL();
    if (!(composeWeb && composeCollab) && !localWeb) {
      throw new Error(
        "DEP-RT-01: neither compose website:17001 nor local web health is up; cannot run UI live chat",
      );
    }

    const userA = mintSessionCookies();
    const userB = mintSessionCookies();
    const a = await openAuthedPage(browser, userA.cookies, baseURL);
    const b = await openAuthedPage(browser, userB.cookies, baseURL);
    const marker = `rt09-${Date.now()}`;

    try {
      await a.page.goto("/en/workspace/channels/new");
      await a.page.locator('[data-mega-chat="create-name"]').fill(marker);
      await a.page.locator('[data-mega-chat="create-submit"]').click();
      await expect(a.page.locator('[data-mega-chat="channel-title"]')).toContainText(marker, {
        timeout: 20_000,
      });
      const channelUrl = a.page.url();

      await b.page.goto(channelUrl);
      await expect(b.page.locator('[data-mega-chat="channel-title"]')).toContainText(marker, {
        timeout: 20_000,
      });

      const channelId = decodeURIComponent(new URL(channelUrl).pathname.split("/").pop() ?? "");
      const userB = await resolveSessionUserId(b.context);
      const invite = await a.context.request.post(`/api/mega/channels/${channelId}/members/invite`, {
        data: { userId: userB },
      });
      expect(invite.ok()).toBeTruthy();
      await b.page.reload();
      await expect(b.page.locator('[data-mega-chat="channel-title"]')).toContainText(marker, {
        timeout: 20_000,
      });

      await a.page.locator('[data-mega-chat="composer-input"]').fill(`hello ${marker}`);
      await a.page.locator('[data-mega-chat="composer-send"]').click();
      await expect(
        b.page.locator('[data-mega-chat="message-row"]').filter({ hasText: `hello ${marker}` }),
      ).toBeVisible({ timeout: 20_000 });

      expect(await readChannelUnread(a.context.request, channelId)).toBe(0);
      expect(await readChannelUnread(b.context.request, channelId)).toBe(1);

      const row = a.page.locator('[data-mega-chat="message-row"]').filter({ hasText: `hello ${marker}` });
      await row.locator('[data-mega-chat="message-edit"]').click();
      await a.page.locator('[data-mega-chat="message-edit-input"]').fill(`edited ${marker}`);
      await a.page.locator('[data-mega-chat="message-edit-save"]').click();
      await expect(
        b.page.locator('[data-mega-chat="message-row"]').filter({ hasText: `edited ${marker}` }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(b.page.locator('[data-slot="chat-message-edited"]').first()).toBeVisible({
        timeout: 20_000,
      });

      const editedRow = a.page.locator('[data-mega-chat="message-row"]').filter({ hasText: `edited ${marker}` });
      await editedRow.locator('[data-slot="reactions-bar-add"] button').first().click();
      await a.page.locator('[data-slot="reactions-bar-add"]').getByRole("button", { name: "👍" }).click();
      await expect(b.page.locator('[data-slot="reactions-bar"]').first()).toContainText("👍", {
        timeout: 20_000,
      });

      expect(await readChannelUnread(a.context.request, channelId)).toBe(0);
      expect(await readChannelUnread(b.context.request, channelId)).toBeLessThanOrEqual(1);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test("REST send still works and the peer sees the message after collab is down", async ({
    browser,
  }) => {
    const composeWeb = await waitForHealth("http://127.0.0.1:17001/api/health", 1_000);
    const localWeb = await waitForHealth(`${e2eBaseURL()}/api/health`, 1_000);
    const baseURL = composeWeb ? "http://127.0.0.1:17001" : e2eBaseURL();
    if (!composeWeb && !localWeb) {
      throw new Error("DEP-RT-01: web health is down; cannot assert polling fallback");
    }

    if (composeWeb) {
      stopComposeCollab();
    } else {
      stopLocalCollabOnPort(7002);
    }
    if (child) {
      child.kill("SIGTERM");
      child = null;
    }

    const userA = mintSessionCookies();
    const userB = mintSessionCookies();
    const a = await openAuthedPage(browser, userA.cookies, baseURL);
    const b = await openAuthedPage(browser, userB.cookies, baseURL);
    const marker = `rt09-down-${Date.now()}`;

    try {
      await a.page.goto("/en/workspace/channels/new");
      await a.page.locator('[data-mega-chat="create-name"]').fill(marker);
      await a.page.locator('[data-mega-chat="create-submit"]').click();
      await expect(a.page.locator('[data-mega-chat="channel-title"]')).toContainText(marker, {
        timeout: 20_000,
      });
      const channelUrl = a.page.url();
      await b.page.goto(channelUrl);

      await a.page.locator('[data-mega-chat="composer-input"]').fill(`fallback ${marker}`);
      await a.page.locator('[data-mega-chat="composer-send"]').click();
      await expect(
        a.page.locator('[data-mega-chat="message-row"]').filter({ hasText: `fallback ${marker}` }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        b.page.locator('[data-mega-chat="message-row"]').filter({ hasText: `fallback ${marker}` }),
      ).toBeVisible({ timeout: 25_000 });
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });
});
