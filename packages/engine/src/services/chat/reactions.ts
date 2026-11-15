// megaui:libs/mega/types.ts@0ff3a9d
//
// megaui-only additions (registered on the EG-07 task card): upstream's
// `Reaction` wire shape (`{ emoji, count, reactedByMe }`) is a
// single-viewer snapshot computed against one process-wide `CURRENT_USER` —
// adequate for the mock store, but a real multi-actor service cannot
// recover "did *this* actor react" from a bare boolean once two different
// callers ask about the same message. Persisted rows here carry the
// reactor-id set (`ReactionRow.userIds`); `projectReactions` derives the
// `Reaction[]` wire shape for one viewing actor from that set, and
// `toggleReactionRow` is the actor-aware toggle (GC-07: explicit actor,
// no implicit "current user").
import type { Reaction } from "@megaui/core";
import { MegaBadRequestError } from "../../errors";
import { assertReactionCapacity } from "./limits";

export interface ReactionRow {
  emoji: string;
  userIds: string[];
}

export function parseReactionRows(raw: unknown): ReactionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      if (typeof row.emoji !== "string" || !row.emoji) return null;
      const userIds = Array.isArray(row.userIds)
        ? row.userIds.filter((id): id is string => typeof id === "string")
        : [];
      return { emoji: row.emoji, userIds };
    })
    .filter((row): row is ReactionRow => row !== null);
}

/** Wire projection for one viewing actor; emoji entries with zero reactors are dropped. */
export function projectReactions(
  rows: readonly ReactionRow[],
  actorUserId: string | null | undefined,
): Reaction[] {
  const viewer = actorUserId?.trim();
  return rows
    .filter((row) => row.userIds.length > 0)
    .map((row) => ({
      emoji: row.emoji,
      count: row.userIds.length,
      reactedByMe: viewer ? row.userIds.includes(viewer) : false,
    }));
}

/**
 * Toggles `actorUserId`'s reaction on `emoji`. Emoji entries whose reactor
 * set becomes empty are pruned (no zero-count rows persisted).
 */
export function toggleReactionRow(
  rows: readonly ReactionRow[],
  emoji: string,
  actorUserId: string,
): ReactionRow[] {
  const trimmedEmoji = emoji.trim();
  if (!trimmedEmoji) throw new MegaBadRequestError("Reaction emoji is required");
  assertReactionCapacity(
    rows.filter((row) => row.userIds.length > 0).map((row) => row.emoji),
    trimmedEmoji,
  );
  const next = rows.map((row) => ({ ...row, userIds: [...row.userIds] }));
  const existing = next.find((row) => row.emoji === trimmedEmoji);
  if (existing) {
    existing.userIds = existing.userIds.includes(actorUserId)
      ? existing.userIds.filter((id) => id !== actorUserId)
      : [...existing.userIds, actorUserId];
    return next.filter((row) => row.userIds.length > 0);
  }
  return [...next, { emoji: trimmedEmoji, userIds: [actorUserId] }];
}
