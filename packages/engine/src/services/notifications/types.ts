// megaui:libs/mega/services/types.ts@0ff3a9d (notification-shaped input/output slice)
//
// Diff vs upstream (GC-03, registered on the EG-09 task card):
// - `kind` is validated against `@megaui/database`'s `megaNotificationKinds`
//   (the 4 values the `mega_notifications.kind` column default/DB layer
//   actually wires up: mention/reply/dm/invite), not `@megaui/core`'s wider
//   8-value `MEGA_NOTIFICATION_KINDS` (which also lists review/ci/cifail/
//   issue — no persisted-row producer exists for those yet). Widening this
//   set is a schema-layer decision (`packages/database`), out of this
//   card's write set.
// - The persisted/service-facing shape (`EngineNotification`) mirrors the
//   flat `mega_notifications` columns (entityType/entityId/url/summary)
//   rather than `@megaui/core`'s richer `Notification`/`NotificationPayload`
//   (title/actor/payload/starred/packageId) — those enrichment fields have
//   no backing column yet (no `mega_notifications.title`, no actor FK, no
//   starred flag). Consumers that need the core-shaped `Notification` can
//   layer that mapping on top; this module stays truthful to what is
//   actually persisted (GC-02).
// - Email delivery is modeled as an injected `EmailDeliveryPort` (this
//   module defines the port + the pure `deliverNotificationEmail` isolation
//   wrapper only) rather than a direct `@megaui/email` import — wiring a
//   concrete `@megaui/email`-backed implementation touches
//   `packages/engine/package.json` (declaring the workspace dependency),
//   which is outside this card's write set
//   (`packages/engine/src/services/notifications/**` only). The port's
//   shape is intentionally compatible with `EmailSender.sendProductNotificationEmail`
//   (PK-07) so that wiring is a thin adapter, not a redesign.
// - Webhook delivery channel intentionally omitted (DEFER-RW-06, card
//   Out-of-scope).
import type { MegaNotificationKind } from "@megaui/database";
import type { PaginationInput } from "../../context";

/** Service-facing notification shape — mirrors `mega_notifications` columns 1:1 (see file header diff note). */
export interface EngineNotification {
  id: string;
  userId: string;
  kind: MegaNotificationKind;
  entityType: string;
  entityId: string;
  url: string;
  summary: string;
  /** `undefined` while unread; an ISO timestamp once read (AC2). */
  readAt: string | undefined;
  createdAt: string;
}

export interface GenerateNotificationInput {
  /** Recipient — the notification's `mega_notifications.user_id`. */
  userId: string;
  kind: MegaNotificationKind;
  entityType: string;
  entityId: string;
  url: string;
  summary: string;
  /**
   * Caller-supplied dedupe key for the *source event*, e.g.
   * `${eventId}` or `${entityType}:${entityId}:${eventKind}`. Combined with
   * `userId` to derive a deterministic row id (AC1) — replaying the same
   * event for the same recipient always resolves to the same row instead
   * of inserting a duplicate. Must not be derived from wall-clock time.
   */
  idempotencyKey: string;
}

export interface GenerateNotificationResult {
  notification: EngineNotification;
  /** `false` when `idempotencyKey` already had a row (AC1 dedupe hit) — callers use this to skip re-delivering email for a replayed event. */
  created: boolean;
}

export interface ListNotificationsInput {
  pagination?: PaginationInput;
  /** Defaults to `false` (all notifications). `true` restricts to unread rows (AC2). */
  unreadOnly?: boolean;
}

export interface ListNotificationsResult {
  items: EngineNotification[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Injected email-delivery seam (AC3). Shaped to match
 * `EmailSender.sendProductNotificationEmail`'s parameters 1:1 (PK-07) so a
 * concrete `@megaui/email`-backed adapter is a thin pass-through — see
 * module diff header for why the concrete import isn't wired here.
 */
export interface EmailDeliveryPort {
  send(params: NotificationEmailParams): Promise<EmailDeliverySendResult>;
}

export interface NotificationEmailParams {
  to: string;
  eventType: string;
  ctaUrl: string;
  payload: Record<string, unknown>;
}

export type EmailDeliverySendResult = { ok: true } | { ok: false; message: string };

export type EmailDeliveryResult =
  | { ok: true }
  | { ok: false; code: "no_provider" }
  | { ok: false; code: "skipped_duplicate" }
  | { ok: false; code: "delivery_failed"; message: string };

export interface NotifyEventInput extends GenerateNotificationInput {
  /** Omit to skip email delivery entirely for this event (in-app only). */
  email?: NotificationEmailParams;
}

export interface NotifyEventResult {
  notification: EngineNotification;
  created: boolean;
  email: EmailDeliveryResult;
}
