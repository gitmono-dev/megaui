// megaui-only (EG-09) barrel, mirroring the `issues/index.ts` /
// `cls/index.ts` per-domain-barrel convention.
//
// Diff vs that convention (GC-03, registered on the EG-09 task card): this
// barrel is intentionally **not** re-exported from
// `packages/engine/src/index.ts` — this card's write set is scoped to
// `packages/engine/src/services/notifications/**` only, and wiring the
// domain into the package root barrel (plus the README diff table) is left
// to the integration task that does that wiring (e.g. WA-05, which also
// owns the actual `MEGA2_INTERNAL_MAIL_BEARER` HTTP route consuming
// `compareBearerToken` below).
import type { Database } from "@megaui/database";
import { createNotificationsService, type NotificationsService } from "./notifications";

export {
  createNotificationsService,
  megaNotificationKinds,
  newNotificationEntityId,
  type NotificationsService,
} from "./notifications";
export {
  compareBearerToken,
  deliverNotificationEmail,
  extractBearerToken,
} from "./notification-delivery";
export { countUnread, isReadTransition, isUnread, mergeReadAt, type UnreadRow } from "./unread";
export type {
  EmailDeliveryPort,
  EmailDeliveryResult,
  EmailDeliverySendResult,
  EngineNotification,
  GenerateNotificationInput,
  GenerateNotificationResult,
  ListNotificationsInput,
  ListNotificationsResult,
  NotificationEmailParams,
  NotifyEventInput,
  NotifyEventResult,
} from "./types";

export interface NotificationsDomain {
  notifications: NotificationsService;
}

/** Wires the notifications-domain service against one `Database` (EG-09). */
export function createNotificationsDomain(database: Database): NotificationsDomain {
  return { notifications: createNotificationsService(database) };
}
