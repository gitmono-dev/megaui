// @vitest-environment happy-dom
// Ported from megaui:tests/unit/mega/favorites.test.ts@0ff3a9d (UI-05 AC4).
import "@testing-library/jest-dom/vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import {
  MEGA_FAVORITES_LIMIT,
  MEGA_FAVORITES_STORAGE_KEY,
  browserStorage,
  deriveFavorite,
  isFavorite,
  parseFavorites,
  serializeFavorites,
  toggleFavorite,
  useFavorites,
  writeFavorites,
  type FavoriteEntry,
} from "./favorites"
import type { MegaNavId } from "./nav-config"

afterEach(() => {
  cleanup()
})

const NAV_LABELS: Record<MegaNavId, string> = {
  home: "Home", inbox: "Inbox", docs: "Doc",
  code: "Code", tags: "Tag", cls: "Change List", issues: "Issue",
}

const entry = (href: string): FavoriteEntry => ({ href, icon: "star", title: href })

describe("favorites pure functions (UI-05 AC4)", () => {
  it("serialization round-trips and malformed storage degrades per entry", () => {
    const list: FavoriteEntry[] = [
      { href: "/en/workspace/cls/1208", icon: "git-pull", title: "!1208" },
      { href: "/en/workspace/docs", icon: "book", title: "Doc" },
    ]
    expect(parseFavorites(serializeFavorites(list))).toEqual(list)

    expect(parseFavorites(undefined)).toEqual([])
    expect(parseFavorites("not json {")).toEqual([])
    expect(parseFavorites('"a string"')).toEqual([])
    expect(parseFavorites(JSON.stringify({ href: "/x" }))).toEqual([])

    // Bad entries are dropped; good ones survive and de-dupe by href.
    const mixed = JSON.stringify([
      list[0],
      { href: "no-leading-slash", icon: "star", title: "x" },
      { href: "/en/x", icon: "not-an-icon", title: "x" },
      { href: "/en/y", icon: "star", title: "   " },
      { href: "/en/z", icon: "star" },
      list[1],
      list[0],
    ])
    expect(parseFavorites(mixed)).toEqual(list)
  })

  it("toggle dedupes by href and a full list rejects additions", () => {
    const list = [entry("/a"), entry("/b")]
    expect(toggleFavorite(list, entry("/c")).map((candidate) => candidate.href)).toEqual(["/a", "/b", "/c"])
    expect(toggleFavorite(list, entry("/a")).map((candidate) => candidate.href)).toEqual(["/b"])
    expect(isFavorite(list, "/a")).toBe(true)
    expect(isFavorite(list, "/c")).toBe(false)

    const full = Array.from({ length: MEGA_FAVORITES_LIMIT }, (_, index) => entry(`/full/${index}`))
    expect(toggleFavorite(full, entry("/one-more"))).toHaveLength(MEGA_FAVORITES_LIMIT)
    expect(isFavorite(toggleFavorite(full, entry("/one-more")), "/one-more")).toBe(false)
    // Removal still works at the cap.
    expect(toggleFavorite(full, full[0]!)).toHaveLength(MEGA_FAVORITES_LIMIT - 1)
    // parse also enforces the cap.
    expect(parseFavorites(serializeFavorites([...full, entry("/extra")]))).toHaveLength(MEGA_FAVORITES_LIMIT)
  })

  it("deriveFavorite maps workspace routes to icon + title", () => {
    const base = "/en/workspace"
    const derive = (path: string) => deriveFavorite(path, base, NAV_LABELS)
    expect(derive("/en/workspace")).toEqual({ href: "/en/workspace", icon: "home", title: "Home" })
    expect(derive("/en/workspace/cls/1208")).toEqual({ href: "/en/workspace/cls/1208", icon: "git-pull", title: "!1208" })
    expect(derive("/en/workspace/issues/482")).toEqual({ href: "/en/workspace/issues/482", icon: "bug", title: "#482" })
    expect(derive("/en/workspace/channels/git-internal")).toEqual({ href: "/en/workspace/channels/git-internal", icon: "hash", title: "#git-internal" })
    expect(derive("/en/workspace/dm/rafael")).toEqual({ href: "/en/workspace/dm/rafael", icon: "chat", title: "@rafael" })
    expect(derive("/en/workspace/docs/d6")).toEqual({ href: "/en/workspace/docs/d6", icon: "book", title: "Doc · d6" })
    expect(derive("/en/workspace/sessions/thr_a5ecd9")).toEqual({ href: "/en/workspace/sessions/thr_a5ecd9", icon: "terminal", title: "thr_a5ecd9" })
    expect(derive("/en/workspace/code/project/git-internal/src/pack.rs")).toEqual({ href: "/en/workspace/code/project/git-internal/src/pack.rs", icon: "code", title: "pack.rs" })
    expect(derive("/en/workspace/tags")).toEqual({ href: "/en/workspace/tags", icon: "tag", title: "Tag" })
    expect(derive("/en/workspace/settings")?.icon).toBe("star")
    expect(derive("/en/dashboard")).toBeUndefined()
  })
})

describe("favorites storage boundaries (UI-05 AC4)", () => {
  it("a rejected write is reported, never thrown (private mode)", () => {
    const written: string[] = []
    expect(writeFavorites({ setItem: (_key, value) => { written.push(value) } }, [entry("/a")])).toBe(true)
    expect(written).toEqual([serializeFavorites([entry("/a")])])

    const throwing = { setItem: () => { throw new DOMException("QuotaExceededError") } }
    expect(() => writeFavorites(throwing, [entry("/a")])).not.toThrow()
    expect(writeFavorites(throwing, [entry("/a")])).toBe(false)
    // No storage at all (SSR) is also a non-event.
    expect(writeFavorites(undefined, [entry("/a")])).toBe(true)
    expect(MEGA_FAVORITES_STORAGE_KEY).toBe("mega-favorites")
  })

  it("the hook is SSR-safe: no storage on the server, empty first render", () => {
    function Probe() {
      const { favorites } = useFavorites()
      return createElement("span", { "data-testid": "count" }, String(favorites.length))
    }
    // Hydration parity: server markup must not depend on stored favorites.
    expect(renderToStaticMarkup(createElement(Probe))).toContain(">0<")
  })
})

describe("useFavorites persistence (UI-05 AC4: add/remove + persistence)", () => {
  function Probe() {
    const { favorites, remove, toggle } = useFavorites()
    return (
      <div>
        <span data-testid="count">{favorites.length}</span>
        <ul>
          {favorites.map((favorite) => (
            <li key={favorite.href}>
              <span data-testid={`title-${favorite.href}`}>{favorite.title}</span>
              <button data-testid={`remove-${favorite.href}`} onClick={() => remove(favorite.href)} type="button">
                remove
              </button>
            </li>
          ))}
        </ul>
        <button data-testid="add-a" onClick={() => toggle(entry("/en/workspace/docs/d1"))} type="button">
          add
        </button>
      </div>
    )
  }

  it("reads persisted favorites from localStorage on mount", () => {
    window.localStorage.setItem(MEGA_FAVORITES_STORAGE_KEY, serializeFavorites([entry("/en/workspace/cls/1")]))
    render(<Probe />)
    expect(screen.getByTestId("count").textContent).toBe("1")
    window.localStorage.clear()
  })

  it("adding a favorite updates state and persists to localStorage", () => {
    window.localStorage.clear()
    render(<Probe />)
    expect(screen.getByTestId("count").textContent).toBe("0")

    fireEvent.click(screen.getByTestId("add-a"))

    expect(screen.getByTestId("count").textContent).toBe("1")
    expect(screen.getByTestId("title-/en/workspace/docs/d1").textContent).toBe("/en/workspace/docs/d1")
    expect(parseFavorites(window.localStorage.getItem(MEGA_FAVORITES_STORAGE_KEY))).toEqual([
      entry("/en/workspace/docs/d1"),
    ])
  })

  it("toggling the same favorite twice removes it (add then remove via the star)", () => {
    window.localStorage.clear()
    render(<Probe />)

    fireEvent.click(screen.getByTestId("add-a"))
    expect(screen.getByTestId("count").textContent).toBe("1")

    fireEvent.click(screen.getByTestId("add-a"))
    expect(screen.getByTestId("count").textContent).toBe("0")
    expect(parseFavorites(window.localStorage.getItem(MEGA_FAVORITES_STORAGE_KEY))).toEqual([])
  })

  it("removing a favorite by href updates state and persists", () => {
    window.localStorage.setItem(
      MEGA_FAVORITES_STORAGE_KEY,
      serializeFavorites([entry("/en/workspace/cls/1"), entry("/en/workspace/cls/2")]),
    )
    render(<Probe />)
    expect(screen.getByTestId("count").textContent).toBe("2")

    fireEvent.click(screen.getByTestId("remove-/en/workspace/cls/1"))

    expect(screen.getByTestId("count").textContent).toBe("1")
    expect(screen.queryByTestId("title-/en/workspace/cls/1")).not.toBeInTheDocument()
    expect(parseFavorites(window.localStorage.getItem(MEGA_FAVORITES_STORAGE_KEY))).toEqual([
      entry("/en/workspace/cls/2"),
    ])
    window.localStorage.clear()
  })

  it("picks up another tab's write via the storage event", () => {
    render(<Probe />)
    expect(screen.getByTestId("count").textContent).toBe("0")

    window.localStorage.setItem(MEGA_FAVORITES_STORAGE_KEY, serializeFavorites([entry("/en/workspace/cls/9")]))
    fireEvent(window, new StorageEvent("storage", { key: MEGA_FAVORITES_STORAGE_KEY }))

    expect(screen.getByTestId("count").textContent).toBe("1")
    window.localStorage.clear()
  })

  it("browserStorage() returns window.localStorage in this DOM environment", () => {
    expect(browserStorage()).toBe(window.localStorage)
  })
})
