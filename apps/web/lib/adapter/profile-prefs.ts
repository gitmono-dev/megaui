// megaui:libs/mega/services/profile-prefs.ts@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-05):
// - In-memory store scoped to the authenticated user (no mock `store.ts`).
// - `MEGA_USERNAME_PATTERN` from `@megaui/core`.

import { MEGA_USERNAME_PATTERN } from "@megaui/core";

export interface ProfilePrefs {
  username: string;
  bio: string;
  clDefaultReviewersRequired?: boolean;
  clAutoSubscribe?: boolean;
  clDraftByDefault?: boolean;
}

/** The settings projection of the authenticated user's local prefs (FSL-132: no directory-managed facts). */
export type ProfilePrefsView = ProfilePrefs;

export interface ProfilePrefsUser {
  id: string;
  email?: string | null;
}

const DEFAULT_CL_PREFS = {
  clDefaultReviewersRequired: true,
  clAutoSubscribe: true,
  clDraftByDefault: false,
} as const;

interface ProfilePrefsStore {
  profilePrefsByUserId: Record<string, ProfilePrefs>;
  profileUsernameLockedByUserId: Record<string, boolean>;
}

const store: ProfilePrefsStore = {
  profilePrefsByUserId: {},
  profileUsernameLockedByUserId: {},
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function usernameFromEmail(email: string): string {
  const local = email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9-]/g, "-") ?? "user1";
  if (MEGA_USERNAME_PATTERN.test(local)) return local;
  const trimmed = local.replace(/^-+|-+$/g, "");
  if (trimmed.length >= 2 && MEGA_USERNAME_PATTERN.test(trimmed)) return trimmed;
  return "user1";
}

function createDefaultProfilePrefs(user: ProfilePrefsUser): ProfilePrefs {
  const username = user.email ? usernameFromEmail(user.email) : "user1";
  return {
    username,
    bio: "",
    ...DEFAULT_CL_PREFS,
  };
}

function ensureProfilePrefs(user: ProfilePrefsUser): ProfilePrefs {
  const existing = store.profilePrefsByUserId[user.id];
  if (existing) return existing;

  const created = createDefaultProfilePrefs(user);
  store.profilePrefsByUserId[user.id] = created;
  return created;
}

/** Profile display prefs scoped to the authenticated Better Auth user. */
export function getProfilePrefs(user: ProfilePrefsUser): ProfilePrefs {
  return clone(ensureProfilePrefs(user));
}

export function projectProfilePrefs(user: ProfilePrefsUser): ProfilePrefsView {
  return getProfilePrefs(user);
}

export function updateProfilePrefs(
  user: ProfilePrefsUser,
  input: Partial<ProfilePrefs>,
): ProfilePrefs {
  const current = ensureProfilePrefs(user);
  const usernameLocked = store.profileUsernameLockedByUserId[user.id] ?? false;

  if (input.username !== undefined) {
    if (!MEGA_USERNAME_PATTERN.test(input.username)) {
      throw new TypeError("Username must be lowercase letters, digits, or hyphens");
    }
    if (usernameLocked && input.username !== current.username) {
      throw new TypeError("Username cannot be changed after registration");
    }
    if (!usernameLocked) {
      store.profilePrefsByUserId[user.id] = {
        ...current,
        username: input.username,
      };
      store.profileUsernameLockedByUserId[user.id] = true;
    }
  }

  const latest = store.profilePrefsByUserId[user.id] ?? current;
  store.profilePrefsByUserId[user.id] = {
    username: latest.username,
    bio: input.bio !== undefined ? input.bio : latest.bio,
    clDefaultReviewersRequired:
      input.clDefaultReviewersRequired ?? latest.clDefaultReviewersRequired,
    clAutoSubscribe: input.clAutoSubscribe ?? latest.clAutoSubscribe,
    clDraftByDefault: input.clDraftByDefault ?? latest.clDraftByDefault,
  };

  return clone(store.profilePrefsByUserId[user.id] ?? latest);
}

/** Test-only reset — clears in-memory profile prefs between contract cases. */
export function resetProfilePrefsForTests(): void {
  store.profilePrefsByUserId = {};
  store.profileUsernameLockedByUserId = {};
}
