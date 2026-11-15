// megaui:libs/react-shared/components/mega/shell/favorites.tsx@0ff3a9d
"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { SHELL_ICON_NAMES, type ShellIconName } from "./icons"
import { MEGA_NAV_ITEMS, type MegaNavId } from "./nav-config"

export const MEGA_FAVORITES_STORAGE_KEY = "mega-favorites"
export const MEGA_FAVORITES_LIMIT = 20

export interface FavoriteEntry {
  href: string
  icon: ShellIconName
  title: string
}

const ICON_NAME_SET: ReadonlySet<string> = new Set(SHELL_ICON_NAMES)

function isFavoriteEntry(value: unknown): value is FavoriteEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  return typeof entry.href === "string" && entry.href.startsWith("/")
    && typeof entry.title === "string" && entry.title.trim().length > 0
    && typeof entry.icon === "string" && ICON_NAME_SET.has(entry.icon)
}

/** GC-08: malformed storage degrades per entry, never throws, caps at the limit. */
export function parseFavorites(serialized: string | null | undefined): FavoriteEntry[] {
  if (!serialized) return []
  try {
    const value: unknown = JSON.parse(serialized)
    if (!Array.isArray(value)) return []
    const seen = new Set<string>()
    const entries: FavoriteEntry[] = []
    for (const candidate of value) {
      if (!isFavoriteEntry(candidate) || seen.has(candidate.href)) continue
      seen.add(candidate.href)
      entries.push({ href: candidate.href, icon: candidate.icon, title: candidate.title })
      if (entries.length >= MEGA_FAVORITES_LIMIT) break
    }
    return entries
  } catch {
    return []
  }
}

export function serializeFavorites(entries: readonly FavoriteEntry[]): string {
  return JSON.stringify(entries)
}

export function isFavorite(entries: readonly FavoriteEntry[], href: string): boolean {
  return entries.some((entry) => entry.href === href)
}

/** Dedupes by href; a full list rejects additions rather than evicting. */
export function toggleFavorite(entries: readonly FavoriteEntry[], entry: FavoriteEntry): FavoriteEntry[] {
  if (isFavorite(entries, entry.href)) return entries.filter((candidate) => candidate.href !== entry.href)
  if (entries.length >= MEGA_FAVORITES_LIMIT) return [...entries]
  return [...entries, entry]
}

/** Derives the favorite entry (icon + title) for the current workspace path. */
export function deriveFavorite(
  pathname: string,
  workspaceBase: string,
  navLabels: Record<MegaNavId, string>,
): FavoriteEntry | undefined {
  let baseEnd = workspaceBase.length
  while (baseEnd > 0 && workspaceBase.charCodeAt(baseEnd - 1) === 47) baseEnd -= 1
  const normalizedBase = workspaceBase.slice(0, baseEnd)
  if (pathname !== normalizedBase && !pathname.startsWith(`${normalizedBase}/`)) return undefined
  const segments = pathname.slice(normalizedBase.length).split("/").filter(Boolean).map((segment) => decodeURIComponent(segment))
  const href = pathname
  const [first, second] = segments

  if (!first) return { href, icon: "home", title: navLabels.home }
  if (second !== undefined) {
    switch (first) {
      case "cls":
        return { href, icon: "git-pull", title: `!${second}` }
      case "issues":
        return { href, icon: "bug", title: `#${second}` }
      case "channels":
        return { href, icon: "hash", title: `#${second}` }
      case "dm":
        return { href, icon: "chat", title: `@${second}` }
      case "docs":
        return { href, icon: "book", title: `${navLabels.docs} · ${second}` }
      case "sessions":
        return { href, icon: "terminal", title: second }
      case "agent":
        return { href, icon: "sparkle", title: `${navLabels.agent} · ${second}` }
      case "code":
        return { href, icon: "code", title: segments.at(-1) ?? first }
      default:
        break
    }
  }
  const navItem = MEGA_NAV_ITEMS.find((item) => item.path === first)
  if (navItem) return { href, icon: navItem.icon, title: navLabels[navItem.id] }
  return { href, icon: "star", title: segments.join("/") }
}

export function browserStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** Writes the list, reporting whether storage accepted it (private mode rejects). */
export function writeFavorites(
  storage: Pick<Storage, "setItem"> | undefined,
  entries: readonly FavoriteEntry[],
): boolean {
  try {
    storage?.setItem(MEGA_FAVORITES_STORAGE_KEY, serializeFavorites(entries))
    return true
  } catch {
    return false
  }
}

/** Z1-01: localStorage-persisted favorites with per-entry degradation. */
export function useFavorites(): {
  favorites: readonly FavoriteEntry[]
  remove(href: string): void
  toggle(entry: FavoriteEntry): void
} {
  // Starts empty so the server markup and the first client render agree; the
  // stored list arrives on mount.
  const [favorites, setFavorites] = useState<readonly FavoriteEntry[]>([])
  // The in-memory list is the source of truth for mutations, so a rejected
  // write (private mode) never silently discards what the user just starred.
  const entriesRef = useRef<readonly FavoriteEntry[]>([])

  const adopt = useCallback((next: readonly FavoriteEntry[]) => {
    entriesRef.current = next
    setFavorites(next)
  }, [])

  const readStored = useCallback(() => parseFavorites(browserStorage()?.getItem(MEGA_FAVORITES_STORAGE_KEY)), [])

  useEffect(() => {
    adopt(readStored())
  }, [adopt, readStored])

  // Another tab's changes land without waiting for a local mutation.
  useEffect(() => {
    if (typeof window === "undefined") return
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== MEGA_FAVORITES_STORAGE_KEY) return
      adopt(readStored())
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [adopt, readStored])

  const persist = useCallback((next: readonly FavoriteEntry[]) => {
    adopt(next)
    writeFavorites(browserStorage(), next)
  }, [adopt])

  const toggle = useCallback((entry: FavoriteEntry) => {
    persist(toggleFavorite(entriesRef.current, entry))
  }, [persist])

  const remove = useCallback((href: string) => {
    persist(entriesRef.current.filter((entry) => entry.href !== href))
  }, [persist])

  return { favorites, remove, toggle }
}
