// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (notifications segments)

import { z } from "zod";

import { getNotificationsDomain } from "@/lib/engine";
import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { resolveActorUserId } from "../session";
import { invalidRoute, only, readJsonQuery, segmentText } from "./shared";

const notificationFilterSchema = z.object({
  unreadOnly: z.boolean().optional(),
});

async function dispatchNotificationsGet(context: MegaDispatchContext): Promise<unknown> {
  const { segments, searchParams, headers } = context;
  const actorUserId = await resolveActorUserId(headers);
  const { notifications } = getNotificationsDomain();

  if (only(segments, ["notifications"])) {
    return notifications.listNotifications(
      actorUserId,
      notificationFilterSchema.parse(readJsonQuery(searchParams.get("filter"), {})),
    );
  }
  if (only(segments, ["notifications", "unread-count"])) {
    return { count: await notifications.getUnreadCount(actorUserId) };
  }

  return invalidRoute(segments);
}

async function dispatchNotificationsPost(context: MegaDispatchContext): Promise<unknown> {
  const { segments, headers } = context;
  const actorUserId = await resolveActorUserId(headers);
  const { notifications } = getNotificationsDomain();

  if (segments[0] === "notifications" && segments[1] === "mark-all-read" && segments.length === 2) {
    return notifications.markAllRead(actorUserId);
  }
  if (segments[0] === "notifications" && segments[2] === "read" && segments.length === 3) {
    return notifications.markNotificationRead(segmentText(segments[1]), actorUserId);
  }

  return invalidRoute(segments);
}

registerMegaRoute({
  match: (_method, segments) => segments[0] === "notifications",
  handle: async (context) => {
    switch (context.method) {
      case "GET":
        return dispatchNotificationsGet(context);
      case "POST":
        return dispatchNotificationsPost(context);
      default:
        return invalidRoute(context.segments);
    }
  },
});
