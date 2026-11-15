import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";
import { e2eBaseURL } from "./helpers/base-url";

const AUTHOR = {
  id: "user_author",
  username: "ada",
  displayName: "Ada",
  avatarInitials: "A",
};

const PEER = {
  id: "user_peer",
  username: "bob",
  displayName: "Bob",
  avatarInitials: "B",
};

const CHANNEL = {
  id: "ch_main",
  kind: "channel" as const,
  name: "wa14-general",
  visibility: "public" as const,
  topic: "WA-14 chat",
  unreadCount: 0,
  mentionCount: 0,
};

const DM = {
  id: "dm_1",
  kind: "dm" as const,
  name: "Bob",
  participant: PEER,
  unreadCount: 0,
  mentionCount: 0,
};

function makeMessage(
  id: string,
  text: string,
  options?: { reactions?: { emoji: string; count: number; reactedByMe: boolean }[]; createdAt?: string },
) {
  return {
    id,
    channelId: CHANNEL.id,
    author: AUTHOR,
    body: undefined,
    segments: [{ type: "text" as const, text }],
    reactions: options?.reactions ?? [],
    createdAt: options?.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

async function stubNotifications(page: Page): Promise<void> {
  await page.route("**/api/mega/notifications/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { count: 0 } }),
    });
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

async function stubChatApis(
  page: Page,
  options?: {
    memberRole?: "admin" | "member";
    selfUserId?: string;
    messageCount?: number;
  },
): Promise<{
  getMessages: () => ReturnType<typeof makeMessage>[];
  getMembers: () => {
    id: string;
    channelId: string;
    userId: string;
    user: typeof AUTHOR;
    role: "admin" | "member";
    muted: boolean;
    joinedAt: string;
  }[];
}> {
  await stubNotifications(page);

  let channels: Array<{
    id: string;
    kind: "channel" | "dm";
    name: string;
    visibility?: "public" | "private";
    topic?: string;
    participant?: typeof PEER;
    unreadCount: number;
    mentionCount: number;
  }> = [CHANNEL, DM];
  let messages = [makeMessage("msg_1", "Hello WA-14")];
  if (options?.messageCount && options.messageCount > 1) {
    messages = Array.from({ length: options.messageCount }, (_, index) =>
      makeMessage(`msg_${index + 1}`, `Message ${index + 1}`, {
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      }),
    );
  }

  const selfUserId = options?.selfUserId ?? "user_self";
  let members = [
    {
      id: "mem_self",
      channelId: CHANNEL.id,
      userId: selfUserId,
      user: { ...AUTHOR, id: selfUserId, username: "self", displayName: "Self" },
      role: (options?.memberRole ?? "admin") as "admin" | "member",
      muted: false,
      joinedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "mem_peer",
      channelId: CHANNEL.id,
      userId: PEER.id,
      user: PEER,
      role: "member" as const,
      muted: false,
      joinedAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  const threads: {
    id: string;
    rootMessageId: string;
    channelId: string;
    messages: ReturnType<typeof makeMessage>[];
    participantIds: string[];
  }[] = [];

  await page.route("**/api/mega/**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const path = new URL(url).pathname.replace(/^\/api\/mega\/?/, "");

    if (path === "channels" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: channels }),
      });
      return;
    }

    if (path === "channels" && method === "POST") {
      const body = route.request().postDataJSON() as {
        name: string;
        visibility: "public" | "private";
        topic?: string;
      };
      const created = {
        ...CHANNEL,
        id: "ch_created",
        name: body.name,
        visibility: body.visibility,
        topic: body.topic,
      };
      channels = [created, CHANNEL, DM];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: created }),
      });
      return;
    }

    if (path === `channels/${CHANNEL.id}/messages` || path === "channels/ch_created/messages") {
      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: messages }),
        });
        return;
      }
      if (method === "POST") {
        const body = route.request().postDataJSON() as { body: string };
        const created = makeMessage(`msg_${messages.length + 1}`, body.body, {
          createdAt: new Date().toISOString(),
        });
        messages = [...messages, created];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: created }),
        });
        return;
      }
    }

    if (path === `channels/${CHANNEL.id}/threads` || path === "channels/ch_created/threads") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: threads }),
      });
      return;
    }

    if (path === `channels/${CHANNEL.id}/members` || path === "channels/ch_created/members") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: members }),
      });
      return;
    }

    if (path.endsWith("/members/invite") && method === "POST") {
      const body = route.request().postDataJSON() as { userId: string };
      const invited = {
        id: `mem_${body.userId}`,
        channelId: CHANNEL.id,
        userId: body.userId,
        user: { ...PEER, id: body.userId, username: body.userId, displayName: body.userId },
        role: "member" as const,
        muted: false,
        joinedAt: new Date().toISOString(),
      };
      members = [...members, invited];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: invited }),
      });
      return;
    }

    if (path.startsWith("chat-threads/") && path.endsWith("/reply") && method === "POST") {
      const rootId = path.split("/")[1]!;
      const body = route.request().postDataJSON() as { body: string };
      const reply = makeMessage(`reply_${Date.now()}`, body.body, {
        createdAt: new Date().toISOString(),
      });
      const existing = threads.find((thread) => thread.rootMessageId === rootId);
      if (existing) {
        existing.messages = [...existing.messages, reply];
      } else {
        threads.push({
          id: `thread_${rootId}`,
          rootMessageId: rootId,
          channelId: CHANNEL.id,
          // Engine contract: Thread.messages is replies-only (root stays in channel list).
          messages: [reply],
          participantIds: [AUTHOR.id, selfUserId],
        });
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: reply }),
      });
      return;
    }

    if (path.startsWith("chat-threads/") && method === "GET") {
      const rootId = path.split("/")[1]!;
      const thread = threads.find((item) => item.rootMessageId === rootId);
      if (!thread) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "MEGA_NOT_FOUND", messageKey: "errors.mega.notFound", message: "missing" },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: thread }),
      });
      return;
    }

    if (path.includes("/reactions") && method === "POST") {
      const messageId = path.split("/")[1]!;
      const body = route.request().postDataJSON() as { emoji: string };
      messages = messages.map((message) => {
        if (message.id !== messageId) return message;
        const existing = message.reactions.find((reaction) => reaction.emoji === body.emoji);
        const reactions = existing
          ? message.reactions.map((reaction) =>
              reaction.emoji === body.emoji
                ? {
                    ...reaction,
                    count: reaction.reactedByMe ? reaction.count - 1 : reaction.count + 1,
                    reactedByMe: !reaction.reactedByMe,
                  }
                : reaction,
            )
          : [...message.reactions, { emoji: body.emoji, count: 1, reactedByMe: true }];
        return { ...message, reactions: reactions.filter((reaction) => reaction.count > 0) };
      });
      const updated = messages.find((message) => message.id === messageId)!;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: updated }),
      });
      return;
    }

    if (path === `channels/${DM.id}/messages` && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [makeMessage("dm_msg_1", "DM hello")] }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: null }),
    });
  });

  return {
    getMessages: () => messages,
    getMembers: () => members,
  };
}

test.describe("workspace chat (WA-14)", () => {
  test("create channel → send → thread reply → reaction", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const selfUserId = await resolveSessionUserId(context);
    const page = await context.newPage();
    await stubChatApis(page, { selfUserId, memberRole: "admin" });

    await page.goto("/en/workspace/channels/new");
    await page.locator('[data-mega-chat="create-name"]').fill("wa14-created");
    await page.locator('[data-mega-chat="create-submit"]').click();
    await expect(page).toHaveURL(/\/en\/workspace\/channels\/ch_created/);
    await expect(page.locator('[data-mega-chat="channel-title"]')).toContainText("wa14-created");

    await page.locator('[data-mega-chat="composer-input"]').fill("Root for thread");
    await page.locator('[data-mega-chat="composer-send"]').click();
    await expect(page.locator('[data-mega-chat="message-row"]').filter({ hasText: "Root for thread" })).toBeVisible();

    const rootRow = page.locator('[data-mega-chat="message-row"]').filter({ hasText: "Root for thread" });
    await rootRow.locator('[data-mega-chat="thread-open"]').click();
    await expect(page.locator('[data-mega-chat="thread-panel"]')).toBeVisible();
    await page.locator('[data-mega-chat="thread-composer-input"]').fill("Thread reply body");
    await page.locator('[data-mega-chat="thread-composer-send"]').click();
    await expect(page.locator('[data-mega-chat="thread-messages"]')).toContainText("Root for thread");
    await expect(page.locator('[data-mega-chat="thread-messages"]')).toContainText("Thread reply body");

    await page.locator('[data-slot="reactions-bar-add"] button').first().click();
    await page.locator('[data-slot="reactions-bar-add"]').getByRole("button", { name: "👍" }).click();
    await expect(page.locator('[data-slot="reactions-bar"]').first()).toContainText("👍");

    await context.close();
  });

  test("virtual list jump to latest with 1000 messages", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const selfUserId = await resolveSessionUserId(context);
    const page = await context.newPage();
    await stubChatApis(page, { selfUserId, messageCount: 1000 });

    await page.goto("/en/workspace/channels/ch_main");
    await expect(page.locator('[data-mega-chat="message-list"]')).toHaveAttribute("data-virtualized", "true");
    await page.locator('[data-mega-chat="message-list"]').evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(page.locator('[data-mega-chat="jump-to-latest"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-mega-chat="jump-to-latest"]').click();
    await expect(page.locator('[data-mega-chat="message-row"]').filter({ hasText: "Message 1000" })).toBeVisible({
      timeout: 10_000,
    });

    await context.close();
  });

  test("invite chrome visible for admin only", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const selfUserId = await resolveSessionUserId(context);

    const adminPage = await context.newPage();
    await stubChatApis(adminPage, { selfUserId, memberRole: "admin" });
    await adminPage.goto("/en/workspace/channels/ch_main");
    await adminPage.locator('[data-mega-chat="open-members"]').click();
    await expect(adminPage.locator('[data-mega-chat="invite-form"]')).toBeVisible();
    await adminPage.close();

    const memberPage = await context.newPage();
    await stubChatApis(memberPage, { selfUserId, memberRole: "member" });
    await memberPage.goto("/en/workspace/channels/ch_main");
    await memberPage.locator('[data-mega-chat="open-members"]').click();
    await expect(memberPage.locator('[data-mega-chat="members-panel"]')).toBeVisible();
    await expect(memberPage.locator('[data-mega-chat="invite-form"]')).toHaveCount(0);

    await context.close();
  });

  test("dm page resolves by username", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubChatApis(page);

    await page.goto("/en/workspace/dm/bob");
    await expect(page.locator('[data-mega-chat="dm-title"]')).toContainText("Bob");
    await expect(page.locator('[data-mega-chat="message-row"]')).toContainText("DM hello");

    await context.close();
  });
});
