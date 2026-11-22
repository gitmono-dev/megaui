// megaui-only (FS-22, FSL-153, FSL-136): content-safe user projection.
//
// Users bound in `feishu_identities` (FSL-153) are projected from their opaque
// user ID and a filtered `user.name`; their login email is read only to filter
// the name and never becomes part of the row. Every other user follows the
// legacy rule (email prefix username, trimmed `user.name`). Since FSL-136 the
// projection no longer reads enterprise profiles: a former enterprise user is a
// legacy row whose username is the opaque prefix of its compatibility email.
import { inArray, sql } from "drizzle-orm";
import { user, type Database } from "@megaui/database";
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

/** The local `user` row fields a Feishu user's display name is computed from. */
export interface FeishuDisplayNameSource {
  readonly id: string;
  readonly name: string;
  /** The login email; `null` only for a defensive caller (the `user.email` column is NOT NULL). */
  readonly email: string | null;
}

/**
 * FSL-153: a Feishu user's display name is `user.name` as stored unless, compared
 * in lowercase, it contains `@` or the complete local part of the login email;
 * then it is the user ID. Fragments of the local part and the domain are not
 * compared. Without a login email it is the user ID. FSL-181: the single source
 * of this rule, shared by the public profile and the Web session projection.
 */
export function feishuUserDisplayName(source: FeishuDisplayNameSource): string {
  if (source.email === null) return source.id;
  return revealsLogin(source.name, loginLocalPart(source.email)) ? source.id : source.name;
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
function feishuInitials(displayName: string, localPart: string): string {
  const full = initials(displayName);
  const first = displayName.split(/\s+/u).find(Boolean)?.[0];
  const candidates = [full, ...(first === undefined ? [""] : [first.toUpperCase(), first])];
  return candidates.find(value => !revealsLogin(value, localPart)) ?? full;
}

function feishuAvatarColor(localPart: string): string {
  return FEISHU_AVATAR_COLORS.find(value => !revealsLogin(value, localPart)) ?? DEFAULT_AVATAR_COLOR;
}

function toFeishuProfile(id: string, displayName: string, localPart: string): PublicProfileRow {
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
  name: string;
  email: string;
  image: string | null;
  feishuBound: boolean;
};

function toProfile(row: PublicProfileSource): PublicProfileRow {
  if (row.feishuBound) {
    return toFeishuProfile(row.id, feishuUserDisplayName(row), loginLocalPart(row.email));
  }
  const username = legacyUsername(row.email, row.id);
  const displayName = row.name.trim() || username;
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

/** Resolves profiles in input order; ids without a `user` row are omitted. */
export async function resolvePublicProfiles(
  database: Database,
  ids: readonly string[],
): Promise<Map<string, User>> {
  const uniqueIds = Array.from(new Set(ids.filter(id => typeof id === "string" && id.length > 0)));
  if (uniqueIds.length === 0) return new Map();

  const rows = await database
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      feishuBound: sql<boolean>`exists (select 1 from feishu_identities fi where fi.user_id = ${user.id})`,
    })
    .from(user)
    .where(inArray(user.id, uniqueIds));

  const byId = new Map<string, PublicProfileSource>(rows.map(row => [row.id, row]));
  return new Map(uniqueIds.flatMap(id => {
    const row = byId.get(id);
    return row ? [[id, toPublicUser(toProfile(row))] as const] : [];
  }));
}
