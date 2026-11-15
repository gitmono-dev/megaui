// megaui:libs/mega/services/chat.ts@0ff3a9d
//
// megaui-only (FS-23): chat author and participant hydration uses the shared
// public-profile projection, never the compatibility email.
import type { Database } from "@megaui/database";
import type { User } from "@megaui/core";
import { fallbackPublicProfile, resolvePublicProfiles } from "../enterprise/public-profile";

export const placeholderUser = fallbackPublicProfile;

export async function resolveUser(database: Database, userId: string): Promise<User> {
  return (await resolvePublicProfiles(database, [userId])).get(userId) ?? placeholderUser(userId);
}
