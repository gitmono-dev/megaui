// megaui:libs/mega/services/notifications.ts@0ff3a9d
// megaui:libs/mega/services/unread.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-09 task card):
// - No `MEGA_NOTIFICATIONS_DATA_BACKEND` mock/database switch (DEBT-04) —
//   this is the only (drizzle PG) implementation.
// - Single PG dialect (ADR-ARCH-02): no sqlite/d1 transaction branch.
// - Event -> notification generation is idempotent by construction: the row
//   id is `deterministicNotificationId(userId, idempotencyKey)` (a sha256
//   digest, not `randomUUID()`), and the insert uses
//   `.onConflictDoNothing({ target: megaNotifications.id })`. Replaying the
//   same event for the same recipient always resolves to the same row
//   instead of a race-prone "check-then-insert" (AC1). Upstream had no
//   idempotency-key concept at all (webhook channel, since dropped, was its
//   own retry surface — DEFER-RW-06).
// - Email delivery (AC3) is layered on top via `notifyEvent`, which only
//   attempts delivery when `generateNotification` actually created a new
//   row — a replayed event (dedupe hit) is never re-delivered by email
//   either. Delivery itself never throws (`deliverNotificationEmail`,
//   `notification-delivery.ts`); a delivery failure is returned as data
//   next to the already-committed notification, never rolled back into it.
// - Read semantics (`markNotificationRead`/`markAllRead`) are monotonic and
//   idempotent (`unread.ts` AC2): marking an already-read row read again is
//   a successful no-op, not `MegaConflictError`, mirroring `unread-math`'s
//   "never move backwards" watermark philosophy applied to a nullable
//   per-row timestamp instead of an ordered message list.
// - Recipient-scoped fail-closed reads: `markNotificationRead` scopes its
//   `WHERE` to `(id, user_id)` together, so a caller can never discover
//   whether a notification *belonging to someone else* exists by probing
//   ids (`MegaNotFoundError` either way — GC-07).
import { createHash, randomUUID } from "node:crypto";
import {
  megaNotifications,
  megaNotificationKinds,
  user,
  type Database,
  type MegaNotification,
} from "@megaui/database";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { MegaBadRequestError, MegaForbiddenError, MegaNotFoundError, MegaUnauthorizedError } from "../../errors";
import { parsePagination } from "../../context";
import { deliverNotificationEmail } from "./notification-delivery";
import type {
  EmailDeliveryPort,
  EngineNotification,
  GenerateNotificationInput,
  GenerateNotificationResult,
  ListNotificationsInput,
  ListNotificationsResult,
  NotifyEventInput,
  NotifyEventResult,
} from "./types";

const VALID_KINDS = new Set<string>(Object.values(megaNotificationKinds));

function toEngineNotification(row: MegaNotification): EngineNotification {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind as EngineNotification["kind"],
    entityType: row.entityType,
    entityId: row.entityId,
    url: row.url,
    summary: row.summary,
    readAt: row.readAt ? row.readAt.toISOString() : undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

/** AC1: deterministic (not random) row id — same `(userId, idempotencyKey)` always maps to the same id, making the insert below idempotent. */
function deterministicNotificationId(userId: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(`${userId}\0${idempotencyKey}`, "utf8").digest("hex");
  return `ntf_${digest.slice(0, 24)}`;
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new MegaBadRequestError(`${field} is required`);
  return trimmed;
}

export function createNotificationsService(database: Database) {
  async function assertRecipientExists(userId: string): Promise<void> {
    const [row] = await database.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
    if (!row) throw new MegaNotFoundError("User", userId);
  }

  /** Card AC1: idempotent event -> notification generation. */
  async function generateNotification(input: GenerateNotificationInput): Promise<GenerateNotificationResult> {
    const userId = requireNonEmpty(input.userId, "userId");
    const entityType = requireNonEmpty(input.entityType, "entityType");
    const entityId = requireNonEmpty(input.entityId, "entityId");
    const url = requireNonEmpty(input.url, "url");
    const summary = requireNonEmpty(input.summary, "summary");
    const idempotencyKey = requireNonEmpty(input.idempotencyKey, "idempotencyKey");
    if (!VALID_KINDS.has(input.kind)) {
      throw new MegaBadRequestError(`Invalid notification kind: ${String(input.kind)}`);
    }
    await assertRecipientExists(userId);

    const id = deterministicNotificationId(userId, idempotencyKey);
    const now = new Date();

    const inserted = await database
      .insert(megaNotifications)
      .values({ id, userId, kind: input.kind, entityType, entityId, url, summary, readAt: null, createdAt: now })
      .onConflictDoNothing({ target: megaNotifications.id })
      .returning();

    if (inserted[0]) {
      return { notification: toEngineNotification(inserted[0]), created: true };
    }

    // Conflict hit (AC1 dedupe): read back the existing row instead of
    // inserting a duplicate.
    const [existing] = await database.select().from(megaNotifications).where(eq(megaNotifications.id, id)).limit(1);
    if (!existing) {
      throw new MegaForbiddenError(`Notification insert conflicted but no row was found for id ${id}`);
    }
    return { notification: toEngineNotification(existing), created: false };
  }

  /**
   * Card AC1 + AC3 composed: generate the in-app row idempotently, then —
   * only for a genuinely new row — attempt email delivery through the
   * injected port. `email.result` is always populated (never throws) so a
   * delivery outage can never take down the in-app write above it.
   */
  async function notifyEvent(input: NotifyEventInput, emailPort?: EmailDeliveryPort): Promise<NotifyEventResult> {
    const { notification, created } = await generateNotification(input);

    if (!input.email) {
      return { notification, created, email: { ok: false, code: "no_provider" } };
    }
    if (!created) {
      return { notification, created, email: { ok: false, code: "skipped_duplicate" } };
    }

    const email = await deliverNotificationEmail(emailPort, input.email);
    return { notification, created, email };
  }

  async function listNotifications(
    actorUserId: string | null | undefined,
    input: ListNotificationsInput = {},
  ): Promise<ListNotificationsResult> {
    const recipient = actorUserId?.trim();
    if (!recipient) throw new MegaUnauthorizedError("A signed-in session is required");
    const { offset, limit } = parsePagination(input.pagination);

    const conditions = input.unreadOnly
      ? and(eq(megaNotifications.userId, recipient), isNull(megaNotifications.readAt))
      : eq(megaNotifications.userId, recipient);

    const [totalRow] = await database.select({ value: count() }).from(megaNotifications).where(conditions);
    const rows = await database
      .select()
      .from(megaNotifications)
      .where(conditions)
      .orderBy(desc(megaNotifications.createdAt), desc(megaNotifications.id))
      .offset(offset)
      .limit(limit);

    return {
      items: rows.map(toEngineNotification),
      total: Number(totalRow?.value ?? 0),
      offset,
      limit,
    };
  }

  /** Card AC2: unread aggregation — backed by the `mega_notifications_user_unread_idx` partial index. */
  async function getUnreadCount(actorUserId: string | null | undefined): Promise<number> {
    const recipient = actorUserId?.trim();
    if (!recipient) throw new MegaUnauthorizedError("A signed-in session is required");
    const [row] = await database
      .select({ value: count() })
      .from(megaNotifications)
      .where(and(eq(megaNotifications.userId, recipient), isNull(megaNotifications.readAt)));
    return Number(row?.value ?? 0);
  }

  /**
   * Card AC2: read semantics — monotonic + idempotent (see module diff
   * header). Fail-closed and recipient-scoped: an id that exists but
   * belongs to a different user reports `MegaNotFoundError`, same as an id
   * that does not exist at all (GC-07).
   */
  async function markNotificationRead(
    notificationId: string,
    actorUserId: string | null | undefined,
  ): Promise<EngineNotification> {
    const recipient = actorUserId?.trim();
    if (!recipient) throw new MegaUnauthorizedError("A signed-in session is required");
    const id = requireNonEmpty(notificationId, "notificationId");

    const now = new Date();
    const updated = await database
      .update(megaNotifications)
      .set({ readAt: now })
      .where(and(eq(megaNotifications.id, id), eq(megaNotifications.userId, recipient), isNull(megaNotifications.readAt)))
      .returning();

    if (updated[0]) return toEngineNotification(updated[0]);

    // Either already read (idempotent no-op success) or genuinely absent —
    // disambiguate by re-reading the scoped row.
    const [existing] = await database
      .select()
      .from(megaNotifications)
      .where(and(eq(megaNotifications.id, id), eq(megaNotifications.userId, recipient)))
      .limit(1);
    if (!existing) throw new MegaNotFoundError("Notification", id);
    return toEngineNotification(existing);
  }

  /** Card AC2: bulk read — idempotent (a second call marks 0 additional rows). */
  async function markAllRead(actorUserId: string | null | undefined): Promise<{ markedCount: number }> {
    const recipient = actorUserId?.trim();
    if (!recipient) throw new MegaUnauthorizedError("A signed-in session is required");

    const updated = await database
      .update(megaNotifications)
      .set({ readAt: new Date() })
      .where(and(eq(megaNotifications.userId, recipient), isNull(megaNotifications.readAt)))
      .returning({ id: megaNotifications.id });
    return { markedCount: updated.length };
  }

  return {
    generateNotification,
    notifyEvent,
    listNotifications,
    getUnreadCount,
    markNotificationRead,
    markAllRead,
  };
}

export type NotificationsService = ReturnType<typeof createNotificationsService>;

export { megaNotificationKinds };

// Re-exported so tests/consumers of this module can mint a fresh randomUUID
// (e.g. `entityId`) without importing `node:crypto` themselves — the same
// convention `issues.ts` follows for its own id helpers.
export function newNotificationEntityId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
