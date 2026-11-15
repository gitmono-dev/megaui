/**
 * Rail channel/DM selection.
 *
 * Diff vs megaui:libs/react-shared/components/mega/shell/nav-config.ts@0ff3a9d
 * (GC-03): upstream curated a fixed allow-list of its own dogfooding
 * channel ids / DM usernames (`RAIL_CHANNEL_IDS` / `RAIL_DM_USERNAMES`) to
 * order a fixture-backed rail against `@libs/mega/types`. megaui has no
 * channel/DM backend or fixture contract yet (that wiring is `WA-*`
 * territory) and `packages/ui`'s write set for this card is
 * `packages/ui/src/shell/**` only — it may not add a `@megaui/core`
 * dependency to reach the real domain types. This module instead
 * structurally types the minimal shape the rail renders and selects by
 * `kind`, preserving the caller-supplied order; callers own
 * curation/sorting.
 */

export type RailPresenceStatus = "online" | "away" | "offline" | "busy"

export interface RailUser {
  avatarInitials?: string
  avatarUrl?: string | null
  displayName: string
  status?: RailPresenceStatus
  username: string
}

interface RailChannelBase {
  id: string
  mentionCount: number
  name: string
  unreadCount: number
}

export interface RailWorkspaceChannel extends RailChannelBase {
  kind: "channel"
}

export interface RailDirectMessageChannel extends RailChannelBase {
  kind: "dm"
  participant: RailUser
}

export type RailChannel = RailWorkspaceChannel | RailDirectMessageChannel

export function selectRailChannels(channels: readonly RailChannel[]): readonly RailWorkspaceChannel[] {
  return channels.filter((channel): channel is RailWorkspaceChannel => channel.kind === "channel")
}

export function selectRailDirectMessages(channels: readonly RailChannel[]): readonly RailDirectMessageChannel[] {
  return channels.filter((channel): channel is RailDirectMessageChannel => channel.kind === "dm")
}
