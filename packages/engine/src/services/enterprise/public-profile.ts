// megaui-only (FS-22, FSL-153): content-safe user projection.
//
// Users bound in `feishu_identities` (FSL-153) are projected from their opaque
// user ID and a filtered `user.name`; their login email is read only to filter
// the name and never becomes part of the row. Enterprise content authors are
// resolved from the durable profile first. The compatibility `user.email` is
// otherwise queried only for rows that have no enterprise profile, preserving
// legacy displays without allowing an enterprise DTO to derive a username or
// merge identity from an address.
import { eq, inArray, sql } from "drizzle-orm";
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

/** The complete local part (everything before the last `@`) of a login email, in lowercase. */
function loginLocalPart(loginEmail: string): string {
  const lowerEmail = loginEmail.toLowerCase();
  const at = lowerEmail.lastIndexOf("@");
  return at === -1 ? lowerEmail : lowerEmail.slice(0, at);
}

/**
 * FSL-153: a Feishu user's display name is `user.name` as stored unless, compared
 * in lowercase, it contains `@` or the complete local part of the login email;
 * then it is the user ID. Fragments of the local part and the domain are not
 * compared.
 */
function feishuDisplayName(name: string, localPart: string, id: string): string {
  return revealsLogin(name, localPart) ? id : name;
}

const DEFAULT_AVATAR_COLOR = "#64748b";
// The two colors share no character other than `#`, so a non-empty local part without
// `#` (the login email syntax allows neither `#` nor `@` there) is never in both.
const FEISHU_AVATAR_COLORS = [DEFAULT_AVATAR_COLOR, "#525252"] as const;

/** Whether a public value contains `@` or the complete local part, compared in lowercase. */
function revealsLogin(value: string, localPart: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes("@") || lower.includes(localPart);
}

/**
 * Initials of a kept name can spell a short local part that the name itself does
 * not contain (`AB` from `Alice Brown` for `ab@…`). They then shrink to the first
 * word's initial (upper case, then as written), and a name without words gives an
 * empty string instead of `U`. A single character still matching the local part means the name
 * contains it, which only happens when the display name is the user ID.
 */
function feishuInitials(displayName: string, localPart: string | undefined): string {
  const full = initials(displayName);
  if (localPart === undefined) return full;
  const first = displayName.split(/\s+/u).find(Boolean)?.[0];
  const candidates = [full, ...(first === undefined ? [""] : [first.toUpperCase(), first])];
  return candidates.find(value => !revealsLogin(value, localPart)) ?? full;
}

function feishuAvatarColor(localPart: string | undefined): string {
  if (localPart === undefined) return DEFAULT_AVATAR_COLOR;
  return FEISHU_AVATAR_COLORS.find(value => !revealsLogin(value, localPart)) ?? DEFAULT_AVATAR_COLOR;
}

function toFeishuProfile(id: string, displayName: string, localPart: string | undefined): PublicProfileRow {
  return {
    id,
    username: id,
    displayName,
    avatarInitials: feishuInitials(displayName, localPart),
    avatarColor: feishuAvatarColor(localPart),
  };
}

type PublicProfileSource = {
  id: string;
  name: string | null;
  image: string | null;
  loginName: string | null;
  profileDisplayName: string | null;
  feishuBound: boolean;
  legacyEmail?: string;
};

function toProfile(row: PublicProfileSource): PublicProfileRow {
  if (row.feishuBound) {
    // No email means the row vanished between the two reads; fail closed to the ID.
    if (row.legacyEmail === undefined) return toFeishuProfile(row.id, row.id, undefined);
    const localPart = loginLocalPart(row.legacyEmail);
    return toFeishuProfile(row.id, feishuDisplayName(row.name ?? "", localPart, row.id), localPart);
  }
  const username = row.loginName ?? (row.legacyEmail ? legacyUsername(row.legacyEmail, row.id) : row.id);
  const displayName = row.profileDisplayName?.trim() || row.name?.trim() || username;
  return {
    id: row.id,
    username,
    displayName,
    ...(row.image ? { avatarUrl: row.image } : {}),
    avatarInitials: initials(displayName),
    avatarColor: DEFAULT_AVATAR_COLOR,
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
      feishuBound: sql<boolean>`exists (select 1 from feishu_identities fi where fi.user_id = ${user.id})`,
    })
    .from(user)
    .leftJoin(enterpriseProfile, eq(enterpriseProfile.userId, user.id))
    .where(inArray(user.id, uniqueIds));

  const byId = new Map<string, PublicProfileSource>(profileRows.map(row => [row.id, row]));
  const legacyIds = profileRows
    .filter(row => row.loginName === null || row.feishuBound)
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
