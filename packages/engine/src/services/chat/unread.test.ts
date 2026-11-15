import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, megaChannelMembers } from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMegaDatabase } from "../../seed";
import { USERS } from "../../testing/fixtures";
import { createChatDomain } from "./index";
import { aggregateUnreadCounts, computeChannelUnread, ensureMemberRowForWatermark } from "./unread";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] chat/unread.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] chat/unread.test.ts: DATABASE_URL is unset — skipping PG closure/unread suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function muteMember(database: import("@megaui/database").Database, channelId: string, userId: string): Promise<void> {
  await database
    .update(megaChannelMembers)
    .set({ muted: true })
    .where(and(eq(megaChannelMembers.channelId, channelId), eq(megaChannelMembers.userId, userId)));
}

describe.skipIf(!adminDatabaseUrl)(
  "chat closure aggregation + unread-math (EG-07 AC2, PK-02 integration, throwaway PG)",
  () => {
    const testDbName = `megaui_test_chat_unread_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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

    it("computeChannelUnread is all-zero for an unauthenticated actor (fail-closed default)", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const { chat } = createChatDomain(client.db);
        const channel = await chat.createChannel({ name: "unread-anon", visibility: "public" }, USERS.tianjing.id);
        expect(await computeChannelUnread(client.db, channel.id, null)).toEqual({
          unreadCount: 0,
          mentionCount: 0,
          muted: false,
        });
      } finally {
        await client.close();
      }
    });

    it("sendChatMessage auto-advances the sender's watermark; other members see the new message as unread", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const { chat } = createChatDomain(client.db);
        const channel = await chat.createChannel({ name: "unread-basic", visibility: "public" }, USERS.tianjing.id);
        await chat.inviteChannelMember({
          channelId: channel.id,
          userId: USERS.rafael.id,
          actorUserId: USERS.tianjing.id,
        });

        const sent = await chat.sendChatMessage(
          { channelId: channel.id, segments: [{ type: "text", text: "unread me" }] },
          USERS.tianjing.id,
        );

        const senderView = await computeChannelUnread(client.db, channel.id, USERS.tianjing.id);
        expect(senderView.unreadCount).toBe(0);
        expect(senderView.lastReadMessageId).toBe(sent.id);

        const otherMemberView = await computeChannelUnread(client.db, channel.id, USERS.rafael.id);
        expect(otherMemberView.unreadCount).toBe(1);
      } finally {
        await client.close();
      }
    });

    it("markChannelRead resets unread/mention counts to zero and pins the watermark to the latest message", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const { chat } = createChatDomain(client.db);
        const channel = await chat.createChannel({ name: "unread-mark-read", visibility: "public" }, USERS.tianjing.id);
        await chat.inviteChannelMember({
          channelId: channel.id,
          userId: USERS.rafael.id,
          actorUserId: USERS.tianjing.id,
        });
        const sent = await chat.sendChatMessage(
          { channelId: channel.id, segments: [{ type: "text", text: "please read" }] },
          USERS.tianjing.id,
        );

        expect((await computeChannelUnread(client.db, channel.id, USERS.rafael.id)).unreadCount).toBe(1);
        const read = await chat.markChannelRead(channel.id, USERS.rafael.id);
        expect(read.unreadCount).toBe(0);
        expect(read.mentionCount).toBe(0);
        expect(read.lastReadMessageId).toBe(sent.id);
        expect((await computeChannelUnread(client.db, channel.id, USERS.rafael.id)).unreadCount).toBe(0);
      } finally {
        await client.close();
      }
    });

    it("a muted member always reports zero unread/mention counts (closure aggregation rule)", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const { chat } = createChatDomain(client.db);
        const channel = await chat.createChannel({ name: "unread-muted", visibility: "public" }, USERS.tianjing.id);
        await chat.inviteChannelMember({
          channelId: channel.id,
          userId: USERS.rafael.id,
          actorUserId: USERS.tianjing.id,
        });
        // Implicitly create Rafael's membership row via a read, then mute it.
        await ensureMemberRowForWatermark(client.db, channel.id, USERS.rafael.id);
        await muteMember(client.db, channel.id, USERS.rafael.id);

        await chat.sendChatMessage(
          { channelId: channel.id, segments: [{ type: "text", text: "noisy" }] },
          USERS.tianjing.id,
        );

        const muted = await computeChannelUnread(client.db, channel.id, USERS.rafael.id);
        expect(muted).toMatchObject({ unreadCount: 0, mentionCount: 0, muted: true });
      } finally {
        await client.close();
      }
    });

    it("@-mentions (user-ref segments) increment mentionCount and set latestMentionMessageId only for the mentioned actor", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const { chat } = createChatDomain(client.db);
        const channel = await chat.createChannel({ name: "unread-mentions", visibility: "public" }, USERS.tianjing.id);
        await chat.inviteChannelMember({
          channelId: channel.id,
          userId: USERS.rafael.id,
          actorUserId: USERS.tianjing.id,
        });
        await chat.inviteChannelMember({
          channelId: channel.id,
          userId: USERS.eleanor.id,
          actorUserId: USERS.tianjing.id,
        });

        const mention = await chat.sendChatMessage(
          {
            channelId: channel.id,
            segments: [
              { type: "text", text: "hey " },
              { type: "user-ref", username: USERS.rafael.username },
            ],
          },
          USERS.tianjing.id,
        );

        const mentionedView = await computeChannelUnread(client.db, channel.id, USERS.rafael.id);
        expect(mentionedView.mentionCount).toBe(1);
        expect(mentionedView.latestMentionMessageId).toBe(mention.id);

        const bystanderView = await computeChannelUnread(client.db, channel.id, USERS.eleanor.id);
        expect(bystanderView.mentionCount).toBe(0);
        // Bystander still has an unread message, just not a mention.
        expect(bystanderView.unreadCount).toBe(1);
      } finally {
        await client.close();
      }
    });

    it("aggregateUnreadCounts sums across channels, excluding muted memberships", () => {
      expect(
        aggregateUnreadCounts([
          { unreadCount: 3, mentionCount: 1, muted: false },
          { unreadCount: 5, mentionCount: 2, muted: true },
          { unreadCount: 2, mentionCount: 0, muted: false },
        ]),
      ).toEqual({ unreadCount: 5, mentionCount: 1 });
    });

    it("thread replies count toward channel unread the same as top-level messages", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const { chat } = createChatDomain(client.db);
        const channel = await chat.createChannel({ name: "unread-threads", visibility: "public" }, USERS.tianjing.id);
        await chat.inviteChannelMember({
          channelId: channel.id,
          userId: USERS.rafael.id,
          actorUserId: USERS.tianjing.id,
        });
        const root = await chat.sendChatMessage(
          { channelId: channel.id, segments: [{ type: "text", text: "root" }] },
          USERS.tianjing.id,
        );
        await chat.markChannelRead(channel.id, USERS.rafael.id);
        expect((await computeChannelUnread(client.db, channel.id, USERS.rafael.id)).unreadCount).toBe(0);

        await chat.replyToChatThread(
          root.id,
          { segments: [{ type: "text", text: "a reply" }] },
          USERS.tianjing.id,
        );
        expect((await computeChannelUnread(client.db, channel.id, USERS.rafael.id)).unreadCount).toBe(1);
      } finally {
        await client.close();
      }
    });

    it("DM channel projection exposes the peer's watermark via participantLastReadMessageId", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const { chat } = createChatDomain(client.db);
        const dm = await chat.openOrCreateDm(USERS.rafael.id, USERS.tianjing.id);
        const sent = await chat.sendChatMessage(
          { channelId: dm.id, segments: [{ type: "text", text: "yo" }] },
          USERS.tianjing.id,
        );

        const beforePeerRead = await chat.listChannels(USERS.tianjing.id);
        const dmBefore = beforePeerRead.find((c) => c.id === dm.id);
        expect(dmBefore?.kind).toBe("dm");
        if (dmBefore?.kind !== "dm") throw new Error("expected dm");
        expect(dmBefore.participantLastReadMessageId).toBeUndefined();

        await chat.markChannelRead(dm.id, USERS.rafael.id);

        const afterPeerRead = await chat.listChannels(USERS.tianjing.id);
        const dmAfter = afterPeerRead.find((c) => c.id === dm.id);
        if (dmAfter?.kind !== "dm") throw new Error("expected dm");
        expect(dmAfter.participantLastReadMessageId).toBe(sent.id);
      } finally {
        await client.close();
      }
    });
  },
);
