// megaui:libs/mega/unread-math.ts@0ff3a9d
//
// megaui-only (EG-09) — notifications have no direct upstream source file;
// this ports the watermark *semantics* of the file above (already vendored to
// `@megaui/core`'s `unread-math.ts`, PK-02) — not its code — to a
// different shape. That file is chat-message-watermark math (a
// `lastReadMessageId` pointer into an ordered message list); the
// `mega_notifications` table has no analogous ordered-list watermark, only
// a per-row nullable `read_at`. This module ports the watermark rules to
// that per-row shape (AC2):
//
//   - monotonic: a notification can move unread -> read, never back
//     (mirrors `maxMessageWatermark`'s "never move backwards" rule).
//   - idempotent: marking an already-read notification read again is a
//     no-op, not an error (mirrors `messagesAfterWatermark` treating a
//     stale/unknown watermark id as "nothing new" rather than throwing).
//
// Kept as pure functions (no DB import) so the read-semantics invariants
// have their own unit tests independent of the throwaway-PG suite, exactly
// like `unread-math.ts` itself.

export interface UnreadRow {
  readAt: Date | null;
}

/** A row is unread iff it has never been read (AC2). */
export function isUnread(row: UnreadRow): boolean {
  return row.readAt === null;
}

/** Total unread count across a set of rows — the pure half of the AC2 unread-aggregation assertion (the DB half is the `mega_notifications_user_unread_idx` partial-index count query in `notifications.ts`). */
export function countUnread(rows: readonly UnreadRow[]): number {
  let count = 0;
  for (const row of rows) {
    if (isUnread(row)) count += 1;
  }
  return count;
}

/**
 * Monotonic read-watermark merge: once a row has a `read_at`, later
 * mark-read attempts must not overwrite it with a different timestamp
 * (mirrors `maxMessageWatermark`'s "prefer the existing value" branch).
 * Returns the timestamp the row's `read_at` should end up holding.
 */
export function mergeReadAt(current: Date | null, markReadAt: Date): Date {
  return current ?? markReadAt;
}

/** True when applying `markRead` at `markReadAt` would actually change the row (i.e. it is a real transition, not an idempotent no-op). */
export function isReadTransition(current: Date | null): boolean {
  return current === null;
}
