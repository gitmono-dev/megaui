/**
 * megaui:libs/react-shared/components/mega/shell/nav-config.ts@0ff3a9d
 *
 * Rail/palette nav registry and the pure route-matching helpers both
 * consume. `RAIL_CHANNEL_IDS`/`RAIL_DM_USERNAMES`/`selectRailChannels`/
 * `selectRailDirectMessages` moved to `./rail-channels.ts` (GC-03: dropped
 * upstream's fixture allow-list, see that file's header for the diff).
 */
import type { ShellIconName } from "./icons"

export const MEGA_NAV_IDS = [
  "home",
  "inbox",
  "docs",
  "code",
  "tags",
  "cls",
  "issues",
  "images",
] as const

export type MegaNavId = (typeof MEGA_NAV_IDS)[number]

/** Stable bridge used by the shell trigger and the command dialog owner. */
export const MEGA_COMMAND_OPEN_EVENT = "mega:command-open"

export interface MegaNavItemConfig {
  icon: ShellIconName
  id: MegaNavId
  path: string
}

export const MEGA_NAV_ITEMS: readonly MegaNavItemConfig[] = [
  { id: "home", icon: "home", path: "" },
  { id: "inbox", icon: "inbox", path: "inbox" },
  { id: "docs", icon: "book", path: "docs" },
  { id: "code", icon: "code", path: "code" },
  { id: "tags", icon: "tag", path: "tags" },
  { id: "cls", icon: "git-pull", path: "cls" },
  { id: "issues", icon: "bug", path: "issues" },
  { id: "images", icon: "folder", path: "images" },
]

function normalizePath(path: string): string {
  const withoutQuery = path.split(/[?#]/u, 1)[0] ?? ""
  const withLeadingSlash = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`
  const segments = withLeadingSlash.split("/").filter(Boolean)
  return segments.length > 0 ? `/${segments.join("/")}` : "/"
}

/** Joins a locale-aware workspace base with a route without duplicating slashes. */
export function workspaceHref(workspaceBase: string, path = ""): string {
  const base = normalizePath(workspaceBase)
  const suffix = path.split("/").filter(Boolean).join("/")
  return suffix ? `${base === "/" ? "" : base}/${suffix}` : base
}

/** Matches a route at a segment boundary, never by a partial segment prefix. */
export function isPathWithin(pathname: string, href: string): boolean {
  const current = normalizePath(pathname)
  const target = normalizePath(href)
  return current === target || current.startsWith(`${target}/`)
}

export function activeNavId(pathname: string, workspaceBase: string): MegaNavId | undefined {
  const current = normalizePath(pathname)
  const base = workspaceHref(workspaceBase)

  if (current === base) return "home"

  return MEGA_NAV_ITEMS
    .filter((item) => item.id !== "home")
    .find((item) => isPathWithin(current, workspaceHref(base, item.path)))
    ?.id
}

export function isExactRailRoute(pathname: string, href: string): boolean {
  return normalizePath(pathname) === normalizePath(href)
}

export function getInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/u).filter(Boolean)
  if (words.length === 0) return ""

  const letters = words.length === 1
    ? Array.from(words[0] ?? "").slice(0, 2)
    : [Array.from(words[0] ?? "")[0], Array.from(words.at(-1) ?? "")[0]]

  return letters.filter(Boolean).join("").toUpperCase()
}

export function formatRailCount(count: number, maximum = 99): string | undefined {
  if (!Number.isFinite(count) || count <= 0) return undefined
  const normalized = Math.floor(count)
  return normalized > maximum ? `${maximum}+` : String(normalized)
}
