// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (settings / profile-prefs + user notifications)

import { MEGA_USERNAME_PATTERN } from "@megaui/core";
import { MegaBadRequestError } from "@megaui/engine";
import { z } from "zod";

import { resolveWebActor } from "@/lib/enterprise-session";
import {
  projectProfilePrefs,
  updateProfilePrefs,
  type ProfilePrefsUser,
} from "../profile-prefs";
import {
  getUserNotificationPreferences,
  updateUserNotificationPreferences,
} from "../mega2/user-notifications";
import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { invalidRoute, only } from "./shared";

const WORKSPACE_NOTIFICATION_DELIVERY_MODES = ["in_app", "email"] as const;

const notificationLocaleSchema = z
  .string()
  .trim()
  .max(32)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/);

const updateWorkspaceNotificationConfigSchema = z.object({
  enabled: z.boolean().optional(),
  deliveryMode: z.enum(WORKSPACE_NOTIFICATION_DELIVERY_MODES).optional(),
  preferredLocale: notificationLocaleSchema.optional(),
  preferences: z.array(z.object({
    eventTypeCode: z.string().trim().min(1),
    enabled: z.boolean(),
  })).optional(),
}).strict();

const profilePrefsUpdateSchema = z.object({
  username: z.string().trim().regex(MEGA_USERNAME_PATTERN).optional(),
  bio: z.string().max(280).optional(),
  clDefaultReviewersRequired: z.boolean().optional(),
  clAutoSubscribe: z.boolean().optional(),
  clDraftByDefault: z.boolean().optional(),
});

async function resolveProfilePrefsUser(headers: Headers): Promise<ProfilePrefsUser> {
  const actor = await resolveWebActor(headers);
  if (!actor) {
    throw new MegaBadRequestError("Authenticated user required for profile prefs");
  }
  return { id: actor.userId, email: actor.email ?? null };
}

async function dispatchSettingsGet(context: MegaDispatchContext): Promise<unknown> {
  const { segments, headers } = context;

  if (only(segments, ["profile-prefs"])) {
    return projectProfilePrefs(await resolveProfilePrefsUser(headers));
  }
  if (only(segments, ["user", "notifications"])) {
    return getUserNotificationPreferences(headers);
  }

  return invalidRoute(segments);
}

async function dispatchSettingsPost(context: MegaDispatchContext): Promise<unknown> {
  const { segments, body, headers } = context;

  if (only(segments, ["profile-prefs"])) {
    const input = profilePrefsUpdateSchema.parse(body);
    try {
      return updateProfilePrefs(await resolveProfilePrefsUser(headers), input);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new MegaBadRequestError(error.message);
      }
      throw error;
    }
  }

  return invalidRoute(segments);
}

async function dispatchSettingsPut(context: MegaDispatchContext): Promise<unknown> {
  const { segments, body, headers } = context;

  if (only(segments, ["user", "notifications"])) {
    return updateUserNotificationPreferences(
      updateWorkspaceNotificationConfigSchema.parse(body ?? {}),
      headers,
    );
  }

  return invalidRoute(segments);
}

function matchesSettingsRoutes(_method: string, segments: readonly string[]): boolean {
  if (only(segments, ["profile-prefs"])) return true;
  if (only(segments, ["user", "notifications"])) return true;
  return false;
}

registerMegaRoute({
  match: matchesSettingsRoutes,
  handle: async (context) => {
    switch (context.method) {
      case "GET":
        return dispatchSettingsGet(context);
      case "POST":
        return dispatchSettingsPost(context);
      case "PUT":
        return dispatchSettingsPut(context);
      default:
        return invalidRoute(context.segments);
    }
  },
});
