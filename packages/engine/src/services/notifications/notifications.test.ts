import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, megaNotifications } from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MegaBadRequestError, MegaNotFoundError, MegaUnauthorizedError } from "../../errors";
import { seedMegaDatabase } from "../../seed";
import { USERS } from "../../testing/fixtures";
import type { EmailDeliveryPort } from "./types";
import { createNotificationsService } from "./notifications";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] notifications/notifications.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] notifications/notifications.test.ts: DATABASE_URL is unset — skipping PG notifications suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe.skipIf(!adminDatabaseUrl)("createNotificationsService (EG-09, throwaway PG)", () => {
  const testDbName = `megaui_test_notifications_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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

  describe("AC1: event -> notification generation is idempotent", () => {
    it("replaying the same idempotencyKey resolves to the same row instead of inserting a duplicate", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const notifications = createNotificationsService(client.db);
        const input = {
          userId: USERS.eleanor.id,
          kind: "mention" as const,
          entityType: "issue",
          entityId: "42",
          url: "/issues/42",
          summary: "tianjing mentioned you in issue #42",
          idempotencyKey: "evt_issue_42_mention_eleanor",
        };

        const first = await notifications.generateNotification(input);
        expect(first.created).toBe(true);

        const replay = await notifications.generateNotification(input);
        expect(replay.created).toBe(false);
        expect(replay.notification.id).toBe(first.notification.id);
        expect(replay.notification.createdAt).toBe(first.notification.createdAt);

        const rows = await client.db
          .select()
          .from(megaNotifications)
          .where(eq(megaNotifications.userId, USERS.eleanor.id));
        expect(rows.filter((row) => row.entityId === "42")).toHaveLength(1);
      } finally {
        await client.close();
      }
    });

    it("a different idempotencyKey for the same recipient creates a distinct row", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const notifications = createNotificationsService(client.db);
        const base = {
          userId: USERS.rafael.id,
          kind: "reply" as const,
          entityType: "issue",
          entityId: "43",
          url: "/issues/43",
          summary: "reply",
        };
        const a = await notifications.generateNotification({ ...base, idempotencyKey: "evt_a" });
        const b = await notifications.generateNotification({ ...base, idempotencyKey: "evt_b" });
        expect(a.created).toBe(true);
        expect(b.created).toBe(true);
        expect(a.notification.id).not.toBe(b.notification.id);
      } finally {
        await client.close();
      }
    });

    it("rejects a missing idempotencyKey, an unknown recipient, and an invalid kind", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const notifications = createNotificationsService(client.db);
        await expect(
          notifications.generateNotification({
            userId: USERS.eleanor.id,
            kind: "mention",
            entityType: "issue",
            entityId: "1",
            url: "/issues/1",
            summary: "s",
            idempotencyKey: "  ",
          }),
        ).rejects.toBeInstanceOf(MegaBadRequestError);

        await expect(
          notifications.generateNotification({
            userId: "usr_does_not_exist",
            kind: "mention",
            entityType: "issue",
            entityId: "1",
            url: "/issues/1",
            summary: "s",
            idempotencyKey: "evt_unknown_user",
          }),
        ).rejects.toBeInstanceOf(MegaNotFoundError);

        await expect(
          notifications.generateNotification({
            userId: USERS.eleanor.id,
            kind: "not-a-real-kind" as never,
            entityType: "issue",
            entityId: "1",
            url: "/issues/1",
            summary: "s",
            idempotencyKey: "evt_bad_kind",
          }),
        ).rejects.toBeInstanceOf(MegaBadRequestError);
      } finally {
        await client.close();
      }
    });
  });

  describe("AC2: unread aggregation + read semantics", () => {
    it("aggregates unread count, marks read idempotently/monotonically, and supports markAllRead", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const notifications = createNotificationsService(client.db);
        const recipient = USERS.tianjing.id;
        const n1 = await notifications.generateNotification({
          userId: recipient,
          kind: "mention",
          entityType: "cl",
          entityId: "1",
          url: "/cls/1",
          summary: "n1",
          idempotencyKey: "evt_unread_1",
        });
        const n2 = await notifications.generateNotification({
          userId: recipient,
          kind: "reply",
          entityType: "cl",
          entityId: "2",
          url: "/cls/2",
          summary: "n2",
          idempotencyKey: "evt_unread_2",
        });

        const before = await notifications.getUnreadCount(recipient);
        expect(before).toBeGreaterThanOrEqual(2);

        await expect(notifications.getUnreadCount(null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
        await expect(notifications.listNotifications(null)).rejects.toBeInstanceOf(MegaUnauthorizedError);

        const listUnread = await notifications.listNotifications(recipient, { unreadOnly: true });
        expect(listUnread.items.every((item) => item.readAt === undefined)).toBe(true);
        expect(listUnread.items.some((item) => item.id === n1.notification.id)).toBe(true);

        const read = await notifications.markNotificationRead(n1.notification.id, recipient);
        expect(read.readAt).toBeDefined();

        const afterOneRead = await notifications.getUnreadCount(recipient);
        expect(afterOneRead).toBe(before - 1);

        // Idempotent + monotonic: marking an already-read notification read
        // again succeeds and does not change its readAt.
        const readAgain = await notifications.markNotificationRead(n1.notification.id, recipient);
        expect(readAgain.readAt).toBe(read.readAt);
        expect(await notifications.getUnreadCount(recipient)).toBe(before - 1);

        const { markedCount } = await notifications.markAllRead(recipient);
        expect(markedCount).toBeGreaterThanOrEqual(1);
        expect(await notifications.getUnreadCount(recipient)).toBe(0);

        // markAllRead is itself idempotent: a second call marks nothing new.
        const second = await notifications.markAllRead(recipient);
        expect(second.markedCount).toBe(0);

        void n2;
      } finally {
        await client.close();
      }
    });

    it("fails closed: markNotificationRead requires a session and is scoped to the owning recipient", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const notifications = createNotificationsService(client.db);
        const owner = USERS.tianjing.id;
        const other = USERS.eleanor.id;
        const created = await notifications.generateNotification({
          userId: owner,
          kind: "invite",
          entityType: "channel",
          entityId: "chn_general",
          url: "/chat/chn_general",
          summary: "invited",
          idempotencyKey: "evt_scope_check",
        });

        await expect(
          notifications.markNotificationRead(created.notification.id, null),
        ).rejects.toBeInstanceOf(MegaUnauthorizedError);
        await expect(
          notifications.markNotificationRead(created.notification.id, other),
        ).rejects.toBeInstanceOf(MegaNotFoundError);
        await expect(
          notifications.markNotificationRead("ntf_does_not_exist", owner),
        ).rejects.toBeInstanceOf(MegaNotFoundError);
      } finally {
        await client.close();
      }
    });
  });

  describe("AC3: email delivery failure must not block the in-app write", () => {
    it("commits the notification row even when the injected email port throws", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const notifications = createNotificationsService(client.db);
        const failingPort: EmailDeliveryPort = {
          send: vi.fn().mockRejectedValue(new Error("SMTP outage")),
        };

        const result = await notifications.notifyEvent(
          {
            userId: USERS.rafael.id,
            kind: "mention",
            entityType: "issue",
            entityId: "99",
            url: "/issues/99",
            summary: "mention",
            idempotencyKey: "evt_email_failure",
            email: {
              to: "rafael@example.com",
              eventType: "issue.comment.created",
              ctaUrl: "https://example.test/issues/99",
              payload: {},
            },
          },
          failingPort,
        );

        expect(result.created).toBe(true);
        expect(result.email).toEqual({ ok: false, code: "delivery_failed", message: "SMTP outage" });

        // The in-app row is really there, independent of the email result.
        const listed = await notifications.listNotifications(USERS.rafael.id);
        expect(listed.items.some((item) => item.id === result.notification.id)).toBe(true);
      } finally {
        await client.close();
      }
    });

    it("does not re-attempt email delivery for a replayed (already-created) event", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const notifications = createNotificationsService(client.db);
        const port: EmailDeliveryPort = { send: vi.fn().mockResolvedValue({ ok: true }) };
        const eventInput = {
          userId: USERS.eleanor.id,
          kind: "reply" as const,
          entityType: "cl",
          entityId: "7",
          url: "/cls/7",
          summary: "reply",
          idempotencyKey: "evt_dedupe_email",
          email: {
            to: "eleanor@example.com",
            eventType: "cl.comment.created",
            ctaUrl: "https://example.test/cls/7",
            payload: {},
          },
        };

        const first = await notifications.notifyEvent(eventInput, port);
        expect(first.created).toBe(true);
        expect(first.email).toEqual({ ok: true });
        expect(port.send).toHaveBeenCalledTimes(1);

        const replay = await notifications.notifyEvent(eventInput, port);
        expect(replay.created).toBe(false);
        expect(replay.email).toEqual({ ok: false, code: "skipped_duplicate" });
        expect(port.send).toHaveBeenCalledTimes(1);
      } finally {
        await client.close();
      }
    });
  });
});
