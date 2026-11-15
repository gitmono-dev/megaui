// megaui-only (FS-22): content-safe user projection.
//
// Enterprise content authors are resolved from the durable profile first. The
// compatibility `user.email` is queried only for rows that have no enterprise
// profile, preserving legacy displays without allowing an enterprise DTO to
// derive a username or merge identity from an address.
import { eq, inArray } from "drizzle-orm";
import { enterpriseProfile, user, type Database } from "@megaui/database";
import type { User } from "@megaui/core";

export interface PublicProfileRow {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly avatarInitials: string;
  readonly avatarColor: string;
}

function initials(value: string): string {
  return value
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() ?? "")
    .join("") || "U";
}

function legacyUsername(email: string, id: string): string {
  return email.split("@")[0] || id;
}

type PublicProfileSource = {
  id: string;
  name: string | null;
  image: string | null;
  loginName: string | null;
  profileDisplayName: string | null;
  legacyEmail?: string;
};

function toProfile(row: PublicProfileSource): PublicProfileRow {
  const username = row.loginName ?? (row.legacyEmail ? legacyUsername(row.legacyEmail, row.id) : row.id);
  const displayName = row.profileDisplayName?.trim() || row.name?.trim() || username;
  return {
    id: row.id,
    username,
    displayName,
    ...(row.image ? { avatarUrl: row.image } : {}),
    avatarInitials: initials(displayName),
    avatarColor: "#64748b",
  };
}

export function toPublicUser(row: PublicProfileRow): User {
  return row;
}

export function fallbackPublicProfile(id: string): User {
  return {
    id,
    username: id,
    displayName: id,
    avatarInitials: "U",
    avatarColor: "#64748b",
  };
}

/** Resolves profiles in input order while keeping legacy fallback isolated. */
export async function resolvePublicProfiles(
  database: Database,
  ids: readonly string[],
): Promise<Map<string, User>> {
  const uniqueIds = Array.from(new Set(ids.filter(id => typeof id === "string" && id.length > 0)));
  if (uniqueIds.length === 0) return new Map();

  const profileRows = await database
    .select({
      id: user.id,
      name: user.name,
      image: user.image,
      loginName: enterpriseProfile.loginName,
      profileDisplayName: enterpriseProfile.displayName,
    })
    .from(user)
    .leftJoin(enterpriseProfile, eq(enterpriseProfile.userId, user.id))
    .where(inArray(user.id, uniqueIds));

  const byId = new Map<string, PublicProfileSource>(profileRows.map(row => [row.id, row]));
  const legacyIds = profileRows
    .filter(row => row.loginName === null)
    .map(row => row.id);
  if (legacyIds.length > 0) {
    const legacyRows = await database
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(inArray(user.id, legacyIds));
    const legacyById = new Map(legacyRows.map(row => [row.id, row.email]));
    for (const row of profileRows) {
      const email = legacyById.get(row.id);
      byId.set(row.id, email === undefined ? row : { ...row, legacyEmail: email });
    }
  }

  return new Map(uniqueIds.flatMap(id => {
    const row = byId.get(id);
    return row ? [[id, toPublicUser(toProfile(row))] as const] : [];
  }));
}
