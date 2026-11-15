// megaui:libs/mega/services/repos/cls-repo.ts@0ff3a9d (toMegaUser / userById)
//
// Shared user-hydration helpers for the CL domain (EG-05 core + EG-06
// attachments) — single source of truth so `cls.ts`, `inline.ts`, and
// `revisions.ts` never diverge on how a bare user id becomes a `User`.
import type { Database } from "@megaui/database";
import type { User } from "@megaui/core";
import { fallbackPublicProfile, resolvePublicProfiles } from "../enterprise/public-profile";

export function fallbackUser(id: string): User {
  return fallbackPublicProfile(id);
}

export async function resolveUsers(database: Database, ids: readonly string[]): Promise<Map<string, User>> {
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) return new Map();
  return resolvePublicProfiles(database, uniqueIds);
}
