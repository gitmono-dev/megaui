// Contract parity vs megaui:libs/react-shared/components/mega/shell/nav-config.ts@0ff3a9d
// (see tests/unit/mega/shell.test.ts "defines eight localized routes..." in upstream@0ff3a9d).
import { describe, expect, it } from "vitest"

import {
  MEGA_COMMAND_OPEN_EVENT,
  MEGA_NAV_ITEMS,
  activeNavId,
  formatRailCount,
  getInitials,
  isExactRailRoute,
  isPathWithin,
  workspaceHref,
} from "./nav-config"

describe("nav-config (UI-05 AC1: rail nav items / active state / path-collapse parity)", () => {
  it("defines the localized routes in the nav-approved order", () => {
    expect(MEGA_NAV_ITEMS.map((item) => item.id)).toEqual([
      "home", "inbox", "docs", "code", "tags", "cls", "issues", "images",
    ])
  })

  it("exposes the stable command-open event name", () => {
    expect(MEGA_COMMAND_OPEN_EVENT).toBe("mega:command-open")
  })

  it("workspaceHref collapses duplicate slashes and strips a trailing slash from either input", () => {
    expect(workspaceHref("/zh-CN/workspace/", "/issues/")).toBe("/zh-CN/workspace/issues")
    expect(workspaceHref("/en/workspace")).toBe("/en/workspace")
    expect(workspaceHref("/en/workspace//", "//cls//")).toBe("/en/workspace/cls")
  })

  it("activates only at a segment boundary, never by partial-segment prefix", () => {
    expect(activeNavId("/en/workspace", "/en/workspace")).toBe("home")
    expect(activeNavId("/en/workspace/code/project/mega", "/en/workspace")).toBe("code")
    // "codebook" is not a segment-boundary match for "code".
    expect(activeNavId("/en/workspace/codebook", "/en/workspace")).toBeUndefined()
    expect(activeNavId("/en/workspace/sessions/thread-1", "/en/workspace")).toBeUndefined()
  })

  it("isPathWithin matches at the boundary and rejects partial-segment prefixes", () => {
    expect(isPathWithin("/en/workspace/cls/12", "/en/workspace/cls")).toBe(true)
    expect(isPathWithin("/en/workspace/cls", "/en/workspace/cls")).toBe(true)
    expect(isPathWithin("/en/workspace/clsx", "/en/workspace/cls")).toBe(false)
  })

  it("isExactRailRoute normalizes trailing slashes before comparing", () => {
    expect(isExactRailRoute("/en/workspace/dm/eleanor/", "/en/workspace/dm/eleanor")).toBe(true)
    expect(isExactRailRoute("/en/workspace/dm/eleanor/thread", "/en/workspace/dm/eleanor")).toBe(false)
  })

  it("getInitials handles single/multi-word names and non-Latin scripts", () => {
    expect(getInitials("Tianjing Ye")).toBe("TY")
    expect(getInitials("马全一")).toBe("马全")
    expect(getInitials("  ")).toBe("")
    expect(getInitials("Solo")).toBe("SO")
  })

  it("formatRailCount hides zero, keeps small counts exact, and caps large counts", () => {
    expect(formatRailCount(0)).toBeUndefined()
    expect(formatRailCount(-3)).toBeUndefined()
    expect(formatRailCount(12)).toBe("12")
    expect(formatRailCount(120)).toBe("99+")
    expect(formatRailCount(99)).toBe("99")
    expect(formatRailCount(100)).toBe("99+")
  })
})
