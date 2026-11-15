/**
 * megaui:libs/react-shared/components/mega/content/plugins/caret.tsx@0ff3a9d
 * megaui:libs/mega/collab/presence-color.ts@0ff3a9d (colorFromUserId only)
 * megaui:libs/mega/collab/collection.ts@0ff3a9d (AWARENESS_USER_KEY constant only)
 *
 * Ported verbatim. Upstream imports `colorFromUserId` / `AWARENESS_USER_KEY` from two
 * `libs/mega/collab/*` engine-core modules outside this card's copy paths
 * (`content/{editor*,plugins/**,preset*,commands*}` + `collab/**` under `react-shared`);
 * both are a handful of pure lines, inlined here rather than pulling in an unrelated
 * package dependency for two constants.
 */
"use client";

const GOLDEN_RATIO = 0.618_033_988_75;
/** Mirrors `libs/mega/collab/collection.ts`'s `AWARENESS_USER_KEY` (shared awareness field name). */
const AWARENESS_USER_KEY = "user" as const;

function hashUserId(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Stable caret / presence color derived from a user id (deterministic HSL so the same
 * peer always gets the same hue).
 * @returns CSS color string, e.g. `hsl(210 70% 45%)`
 */
export function colorFromUserId(userId: string): string {
  const hash = hashUserId(userId.trim() || "anon");
  const hue = Math.floor(((hash * GOLDEN_RATIO) % 1) * 360);
  return `hsl(${hue} 70% 45%)`;
}

export interface CollabAwarenessUser {
  id: string;
  name: string;
  color: string;
}

/** Build the awareness `user` field Lexical + presence stack both consume. */
export function buildCollabAwarenessUser(input: { userId: string; username: string; cursorColor?: string }): CollabAwarenessUser {
  const color = input.cursorColor ?? colorFromUserId(input.userId);
  return {
    id: input.userId,
    name: input.username,
    color,
  };
}

/** Apply local caret identity onto a Yjs awareness instance. */
export function publishLocalCaretAwareness(
  awareness: { setLocalStateField: (field: string, value: unknown) => void },
  user: CollabAwarenessUser,
): void {
  awareness.setLocalStateField(AWARENESS_USER_KEY, user);
  // Lexical CollaborationPlugin also reads top-level name/color on awareness.
  awareness.setLocalStateField("name", user.name);
  awareness.setLocalStateField("color", user.color);
}

export interface DocPresencePeer {
  clientId: number;
  userId: string;
  name: string;
  color: string;
}

/** List remote peers currently connected to an A-type doc room (excludes local). */
export function listDocPresencePeers(awareness: {
  clientID: number;
  getStates: () => Map<number, Record<string, unknown>>;
}): DocPresencePeer[] {
  const peers: DocPresencePeer[] = [];
  const localId = awareness.clientID;
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === localId || !state || typeof state !== "object") return;
    const userField = state[AWARENESS_USER_KEY];
    let userId: string | undefined;
    let name: string | undefined;
    let color: string | undefined;
    if (userField && typeof userField === "object") {
      const record = userField as { id?: unknown; name?: unknown; color?: unknown };
      if (typeof record.id === "string") userId = record.id;
      if (typeof record.name === "string") name = record.name;
      if (typeof record.color === "string") color = record.color;
    }
    if (!userId && typeof state.name === "string") {
      // Fallback: Lexical-only awareness without our user payload.
      name = state.name;
      userId = `client:${clientId}`;
    }
    if (!userId) return;
    peers.push({
      clientId,
      userId,
      name: name ?? userId,
      color: color ?? (typeof state.color === "string" ? state.color : colorFromUserId(userId)),
    });
  });
  return peers;
}
