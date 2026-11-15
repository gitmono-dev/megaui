import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient } from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCollabInternalBridge } from "../collab/internal-bridge";
import {
  MegaBadRequestError,
  MegaForbiddenError,
  MegaNotFoundError,
  MegaUnauthorizedError,
} from "../../errors";
import { seedMegaDatabase } from "../../seed";
import { USERS } from "../../testing/fixtures";
import { MAX_CHAT_MESSAGE_REACTIONS, MAX_CHAT_MESSAGE_SEGMENTS } from "./limits";
import { createChatDomain } from "./index";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] chat/chat.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] chat/chat.test.ts: DATABASE_URL is unset — skipping PG chat suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe.skipIf(!adminDatabaseUrl)(
  "createChatDomain channels/DM/messages/threads/reactions (EG-07, throwaway PG)",
  () => {
    const testDbName = `megaui_test_chat_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    let adminPool: import("pg").Pool;
    let connectionString: string;

    beforeAll(async () => {
      const { Pool } = await import("pg");
      adminPool = new Pool({ connectionString: adminDatabaseUrl });
      await adminPool.query(`CREATE DATABASE "${testDbName}"`);
      connectionString = oneShotDatabaseUrl(adminDatabaseUrl!, testDbName);
      const migratePool = new Pool({ connectionString });
      const client = createDatabaseClient({ connectionString });
      try {
        await migrate((await import("drizzle-orm/node-postgres")).drizzle(migratePool), { migrationsFolder });
        await seedMegaDatabase(client.db);
      } finally {
        await client.close();
        await migratePool.end();
      }
    });

    afterAll(async () => {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [testDbName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
      await adminPool.end();
    });

    describe("AC1: channel CRUD + permissions", () => {
      it("creates a public channel; any authenticated user can read/send without an explicit membership row", async () => {
        const client = createDatabaseClient({ connectionString });
        try {
          const { chat } = createChatDomain(client.db);
          const channel = await chat.createChannel(
            { name: "eg07-public", visibility: "public" },
            USERS.tianjing.id,
          );
          expect(channel.kind).toBe("channel");
          expect(channel.visibility).toBe("public");

          const sent = await chat.sendChatMessage(
            { channelId: channel.id, segments: [{ type: "text", text: "hello from rafael" }] },
            USERS.rafael.id,
          );
          expect(sent.author.id).toBe(USERS.rafael.id);
          expect(sent.channelId).toBe(channel.id);

          const messages = await chat.listChatMessages(channel.id, USERS.eleanor.id);
          expect(messages.map((m) => m.id)).toContain(sent.id);
        } finally {
          await client.close();
        }
      });

      it("denies unauthenticated and non-member access to a private channel; allows the creator", async () => {
        const client = createDatabaseClient({ connectionString });
        try {
          const { chat } = createChatDomain(client.db);
          const channel = await chat.createChannel(
            { name: "eg07-private", visibility: "private" },
            USERS.tianjing.id,
          );

          await expect(chat.listChatMessages(channel.id, null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
          await expect(chat.listChatMessages(channel.id, USERS.rafael.id)).rejects.toBeInstanceOf(
            MegaForbiddenError,
          );
          await expect(
            chat.sendChatMessage(
              { channelId: channel.id, segments: [{ type: "text", text: "nope" }] },
              USERS.rafael.id,
            ),
          ).rejects.toBeInstanceOf(MegaForbiddenError);

          const sent = await chat.sendChatMessage(
            { channelId: channel.id, segments: [{ type: "text", text: "owner can post" }] },
            USERS.tianjing.id,
          );
          expect(sent.author.id).toBe(USERS.tianjing.id);

          await chat.inviteChannelMember({
            channelId: channel.id,
            userId: USERS.rafael.id,
            actorUserId: USERS.tianjing.id,
          });
          const messages = await chat.listChatMessages(channel.id, USERS.rafael.id);
          expect(messages.map((m) => m.id)).toContain(sent.id);
        } finally {
          await client.close();
        }
      });

      it("ER-05 P1: listChannels never fail-opens a private channel for a missing actor (undefined/null/empty all filter)", async () => {
        const client = createDatabaseClient({ connectionString });
        try {
          const { chat } = createChatDomain(client.db);
          const channel = await chat.createChannel(
            { name: "eg07-private-acl", visibility: "private" },
            USERS.tianjing.id,
          );

          expect((await chat.listChannels(undefined)).some((c) => c.id === channel.id)).toBe(false);
          expect((await chat.listChannels(null)).some((c) => c.id === channel.id)).toBe(false);
          expect((await chat.listChannels("")).some((c) => c.id === channel.id)).toBe(false);
          expect((await chat.listChannels(USERS.rafael.id)).some((c) => c.id === channel.id)).toBe(false);
          expect((await chat.listChannels(USERS.tianjing.id)).some((c) => c.id === channel.id)).toBe(true);
        } finally {
          await client.close();
        }
      });

      it("404s sending to an unknown channel", async () => {
        const client = createDatabaseClient({ connectionString });
        try {
          const { chat } = createChatDomain(client.db);
          await expect(
            chat.sendChatMessage(
              { channelId: "channel_does_not_exist", segments: [{ type: "text", text: "hi" }] },
              USERS.tianjing.id,
            ),
          ).rejects.toBeInstanceOf(MegaNotFoundError);
        } finally {
          await client.close();
        }
      });
    });

    describe("AC1: DM CRUD + permissions", () => {
      it("opens a DM, derives `name`/`participant` per viewer, and restricts access to the two participants", async () => {
        const client = createDatabaseClient({ connectionString });
        try {
          const { chat } = createChatDomain(client.db);
          const dmFromTianjing = await chat.openOrCreateDm(USERS.eleanor.id, USERS.tianjing.id);
          expect(dmFromTianjing.kind).toBe("dm");
          if (dmFromTianjing.kind !== "dm") throw new Error("expected dm");
          expect(dmFromTianjing.participant.id).toBe(USERS.eleanor.id);
          expect(dmFromTianjing.name).toBe(USERS.eleanor.displayName);

          // Same physical channel row, viewed by the other participant — the
          // *derived* name/participant must reflect the viewer, not a
          // one-sided value frozen at creation time (see channels.ts diff header).
          const channels = await chat.listChannels(USERS.eleanor.id);
          const sameDm = channels.find((c) => c.id === dmFromTianjing.id);
          expect(sameDm?.kind).toBe("dm");
          if (sameDm?.kind !== "dm") throw new Error("expected dm");
          expect(sameDm.participant.id).toBe(USERS.tianjing.id);
          expect(sameDm.name).toBe(USERS.tianjing.displayName);

          await expect(chat.listChatMessages(dmFromTianjing.id, USERS.rafael.id)).rejects.toBeInstanceOf(
            MegaForbiddenError,
          );

          const sent = await chat.sendChatMessage(
            { channelId: dmFromTianjing.id, segments: [{ type: "text", text: "hey" }] },
            USERS.tianjing.id,
          );
          const messages = await chat.listChatMessages(dmFromTianjing.id, USERS.eleanor.id);
          expect(messages.map((m) => m.id)).toContain(sent.id);
        } finally {
          await client.close();
        }
      });
    });

    describe("AC1: message edit permissions", () => {
      it("lets only the author edit; rejects other actors and unknown messages", async () => {
        const client = createDatabaseClient({ connectionString });
        try {
          const { chat } = createChatDomain(client.db);
          const channel = await chat.createChannel({ name: "eg07-edit", visibility: "public" }, USERS.tianjing.id);
          const sent = await chat.sendChatMessage(
            { channelId: channel.id, segments: [{ type: "text", text: "original" }] },
            USERS.rafael.id,
          );

          await expect(
            chat.editChatMessage(sent.id, { segments: [{ type: "text", text: "hijack" }] }, USERS.eleanor.id),
          ).rejects.toBeInstanceOf(MegaForbiddenError);
          await expect(
            chat.editChatMessage("msg_does_not_exist", { segments: [{ type: "text", text: "x" }] }, USERS.rafael.id),
          ).rejects.toBeInstanceOf(MegaNotFoundError);

          const edited = await chat.editChatMessage(
            sent.id,
            { segments: [{ type: "text", text: "edited by author" }] },
            USERS.rafael.id,
          );
          expect(edited.segments).toEqual([{ type: "text", text: "edited by author" }]);
          expect(edited.editedAt).toBeDefined();
        } finally {
          await client.close();
        }
      });
    });

    describe("AC3: long-message boundary (GC-10, end-to-end)", () => {
      it("rejects a message with more than MAX_CHAT_MESSAGE_SEGMENTS segments", async () => {
        const client = createDatabaseClient({ connectionString });
        try {
          const { chat } = createChatDomain(client.db);
          const channel = await chat.createChannel({ name: "eg07-limits", visibility: "public" }, USERS.tianjing.id);
          const tooMany = Array.from({ length: MAX_CHAT_MESSAGE_SEGMENTS + 1 }, () => ({
            type: "text" as const,
            text: "x",
          }));
          await expect(
            chat.sendChatMessage({ channelId: channel.id, segments: tooMany }, USERS.tianjing.id),
          ).rejects.toBeInstanceOf(MegaBadRequestError);
        } finally {
          await client.close();
        }
      });

      it("rejects an empty-segments message and a reply that violates the same cap", async () => {
        const client = createDatabaseClient({ connectionString });
        try {
          const { chat } = createChatDomain(client.db);
          const channel = await chat.createChannel({ name: "eg07-limits-2", visibility: "public" }, USERS.tianjing.id);
          await expect(
            chat.sendChatMessage({ channelId: channel.id, segments: [] }, USERS.tianjing.id),
          ).rejects.toBeInstanceOf(MegaBadRequestError);

          const root = await chat.sendChatMessage(
            { channelId: channel.id, segments: [{ type: "text", text: "root" }] },
            USERS.tianjing.id,
          );
          await expect(
            chat.replyToChatThread(root.id, { segments: [] }, USERS.rafael.id),
          ).rejects.toBeInstanceOf(MegaBadRequestError);
        } finally {
          await client.close();
        }
      });
    });

    describe("AC1 + AC2: threads", () => {
      it("404s a thread with no replies yet, then starts it implicitly on the first reply", async () => {
        const client = createDatabaseClient({ connectionString });
        try {
          const { chat } = createChatDomain(client.db);
          const channel = await chat.createChannel({ name: "eg07-threads", visibility: "public" }, USERS.tianjing.id);
          const root = await chat.sendChatMessage(
            { channelId: channel.id, segments: [{ type: "text", text: "root message" }] },
            USERS.tianjing.id,
          );

          await expect(chat.getChatThread(root.id, USERS.tianjing.id)).rejects.toBeInstanceOf(MegaNotFoundError);
          expect(await chat.listChatThreads(channel.id, USERS.tianjing.id)).toEqual([]);

          const reply1 = await chat.replyToChatThread(
            root.id,
            { segments: [{ type: "text", text: "first reply" }] },
            USERS.rafael.id,
          );
          expect(reply1.threadId).toBe(root.id);
          expect(reply1.channelId).toBe(channel.id);

          const reply2 = await chat.replyToChatThread(
            root.id,
            { segments: [{ type: "text", text: "second reply" }] },
            USERS.eleanor.id,
          );

          const thread = await chat.getChatThread(root.id, USERS.tianjing.id);
          expect(thread.id).toBe(root.id);
          expect(thread.rootMessageId).toBe(root.id);
          expect(thread.messages.map((m) => m.id)).toEqual([reply1.id, reply2.id]);
          expect(new Set(thread.participantIds)).toEqual(
            new Set([USERS.tianjing.id, USERS.rafael.id, USERS.eleanor.id]),
          );

          // Replies must not leak into the top-level channel message list.
          const topLevel = await chat.listChatMessages(channel.id, USERS.tianjing.id);
          expect(topLevel.map((m) => m.id)).toEqual([root.id]);

          const threads = await chat.listChatThreads(channel.id, USERS.tianjing.id);
          expect(threads).toHaveLength(1);
          expect(threads[0]?.id).toBe(root.id);
        } finally {
          await client.close();
        }
      });

      it("gates thread access on the underlying channel's permissions", async () => {
        const client = createDatabaseClient({ connectionString });
        try {
          const { chat } = createChatDomain(client.db);
          const channel = await chat.createChannel({ name: "eg07-thread-perm", visibility: "private" }, USERS.tianjing.id);
          const root = await chat.sendChatMessage(
            { channelId: channel.id, segments: [{ type: "text", text: "root" }] },
            USERS.tianjing.id,
          );
          await chat.replyToChatThread(root.id, { segments: [{ type: "text", text: "reply" }] }, USERS.tianjing.id);

          await expect(chat.getChatThread(root.id, USERS.rafael.id)).rejects.toBeInstanceOf(MegaForbiddenError);
          await expect(
            chat.replyToChatThread(root.id, { segments: [{ type: "text", text: "nope" }] }, USERS.rafael.id),
          ).rejects.toBeInstanceOf(MegaForbiddenError);
        } finally {
          await client.close();
        }
      });
    });

    describe("AC1 + AC3: reactions", () => {
      it("toggles a reaction on/off per actor and gates on channel access", async () => {
        const client = createDatabaseClient({ connectionString });
        try {
          const { chat } = createChatDomain(client.db);
          const channel = await chat.createChannel({ name: "eg07-reactions", visibility: "private" }, USERS.tianjing.id);
          const sent = await chat.sendChatMessage(
            { channelId: channel.id, segments: [{ type: "text", text: "react to me" }] },
            USERS.tianjing.id,
          );

          await expect(chat.toggleMessageReaction(sent.id, "👍", USERS.rafael.id)).rejects.toBeInstanceOf(
            MegaForbiddenError,
          );
          await expect(chat.toggleMessageReaction(sent.id, "👍", null)).rejects.toBeInstanceOf(
            MegaUnauthorizedError,
          );

          const reacted = await chat.toggleMessageReaction(sent.id, "👍", USERS.tianjing.id);
          expect(reacted.reactions).toEqual([{ emoji: "👍", count: 1, reactedByMe: true }]);

          // A second actor's `reactedByMe` is computed independently (per-actor projection, see reactions.ts).
          const asOtherViewer = (await chat.listChatMessages(channel.id, USERS.tianjing.id)).find(
            (m) => m.id === sent.id,
          );
          expect(asOtherViewer?.reactions).toEqual([{ emoji: "👍", count: 1, reactedByMe: true }]);

          const unreacted = await chat.toggleMessageReaction(sent.id, "👍", USERS.tianjing.id);
          expect(unreacted.reactions).toEqual([]);
        } finally {
          await client.close();
        }
      });

      it("rejects a brand-new distinct emoji once MAX_CHAT_MESSAGE_REACTIONS is reached (GC-10 超量 reactions)", async () => {
        const client = createDatabaseClient({ connectionString });
        try {
          const { chat } = createChatDomain(client.db);
          const channel = await chat.createChannel({ name: "eg07-reaction-cap", visibility: "public" }, USERS.tianjing.id);
          const sent = await chat.sendChatMessage(
            { channelId: channel.id, segments: [{ type: "text", text: "cap me" }] },
            USERS.tianjing.id,
          );

          for (let index = 0; index < MAX_CHAT_MESSAGE_REACTIONS; index += 1) {
            await chat.toggleMessageReaction(sent.id, `emoji-${index}`, USERS.tianjing.id);
          }
          await expect(
            chat.toggleMessageReaction(sent.id, "one-too-many", USERS.tianjing.id),
          ).rejects.toBeInstanceOf(MegaBadRequestError);

          // Toggling an existing one off is still allowed at the cap.
          const after = await chat.toggleMessageReaction(sent.id, "emoji-0", USERS.tianjing.id);
          expect(after.reactions).toHaveLength(MAX_CHAT_MESSAGE_REACTIONS - 1);
        } finally {
          await client.close();
        }
      });
    });

    describe("RT-07 collection push after mutation", () => {
      it("appends on send/reply, bumps on edit/reaction, and does not throw when the bridge fails", async () => {
        const client = createDatabaseClient({ connectionString });
        try {
          const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
          const bridge = createCollabInternalBridge({
            internalUrl: "http://127.0.0.1:17999",
            token: "test-internal",
            fetchImpl,
            retry: { maxAttempts: 1 },
          });
          const { chat } = createChatDomain(client.db, { collabBridge: bridge });
          const channel = await chat.createChannel(
            { name: "rt07-push", visibility: "public" },
            USERS.tianjing.id,
          );
          const sent = await chat.sendChatMessage(
            { channelId: channel.id, segments: [{ type: "text", text: "push me" }] },
            USERS.tianjing.id,
          );
          expect(sent.id).toBeTruthy();
          expect(fetchImpl).toHaveBeenCalledWith(
            expect.stringContaining("/internal/collection/append"),
            expect.anything(),
          );

          const edited = await chat.editChatMessage(
            sent.id,
            { segments: [{ type: "text", text: "edited" }] },
            USERS.tianjing.id,
          );
          expect(edited.segments[0]).toMatchObject({ text: "edited" });
          expect(fetchImpl).toHaveBeenCalledWith(
            expect.stringContaining("/internal/collection/bump"),
            expect.anything(),
          );

          const failing = createCollabInternalBridge({
            internalUrl: "http://127.0.0.1:17999",
            token: "test-internal",
            fetchImpl: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
            retry: { maxAttempts: 1 },
          });
          const { chat: chatFail } = createChatDomain(client.db, { collabBridge: failing });
          await expect(
            chatFail.sendChatMessage(
              { channelId: channel.id, segments: [{ type: "text", text: "still persisted" }] },
              USERS.tianjing.id,
            ),
          ).resolves.toMatchObject({ channelId: channel.id });
        } finally {
          await client.close();
        }
      });

      it("skips push when the bridge is unconfigured", async () => {
        const client = createDatabaseClient({ connectionString });
        try {
          const fetchImpl = vi.fn();
          const bridge = createCollabInternalBridge({ env: {}, fetchImpl });
          const { chat } = createChatDomain(client.db, { collabBridge: bridge });
          const channel = await chat.createChannel(
            { name: "rt07-skip", visibility: "public" },
            USERS.tianjing.id,
          );
          await chat.sendChatMessage(
            { channelId: channel.id, segments: [{ type: "text", text: "skip" }] },
            USERS.tianjing.id,
          );
          expect(fetchImpl).not.toHaveBeenCalled();
        } finally {
          await client.close();
        }
      });
    });
  },
);
