// megaui-only (FSL-181): the one way the interface reads the signed-in user's own name.
// A Feishu `get-session` projection carries `user.displayName` (the FSL-153 rule, see
// `apps/web/lib/mega2-session.ts`) next to the Mega2 principal `user.name` (`fs_<user ID>`);
// a legacy projection has no `displayName`, so its `user.name` is used as before.

/** The session `user` fields this helper reads; other fields are ignored. */
export interface SelfDisplayNameSource {
  readonly name: string;
  readonly displayName?: unknown;
}

/**
 * `displayName` when it is a string (returned as is, even when blank), otherwise `name`;
 * `undefined` without a user.
 */
export function selfDisplayName(sessionUser: SelfDisplayNameSource | null | undefined): string | undefined {
  if (!sessionUser) return undefined;
  return typeof sessionUser.displayName === "string" ? sessionUser.displayName : sessionUser.name;
}
