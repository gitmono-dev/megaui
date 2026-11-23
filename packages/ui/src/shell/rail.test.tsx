// @vitest-environment happy-dom
// UI-05 AC1: rail nav items / active state / path-collapse parity vs
// megaui:libs/react-shared/components/mega/shell/rail.tsx@0ff3a9d
// (behavior contract ported from upstream@0ff3a9d's tests/unit/mega/shell.test.ts).
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { en, zhCN } from "@megaui/i18n"

import { WorkspaceRail, type WorkspaceRailLabels, type WorkspaceRailProps } from "./rail"
import type { WorkspaceRailLinkProps } from "./rail-row"
import type { RailChannel } from "./rail-channels"

afterEach(() => {
  cleanup()
})

function renderLink({ children, href, ...props }: WorkspaceRailLinkProps) {
  return <a {...props} href={href}>{children}</a>
}

const englishLabels = en.workspace.nav satisfies WorkspaceRailLabels

const CHANNELS: readonly RailChannel[] = [
  { id: "general", kind: "channel", mentionCount: 0, name: "general", unreadCount: 0 },
  { id: "code-review", kind: "channel", mentionCount: 1, name: "code-review", unreadCount: 3 },
  { id: "ci-alerts", kind: "channel", mentionCount: 0, name: "ci-alerts", unreadCount: 12 },
  {
    id: "dm-eleanor", kind: "dm", mentionCount: 0, name: "Eleanor Vance", unreadCount: 0,
    participant: { displayName: "Eleanor Vance", status: "away", username: "eleanor" },
  },
  {
    id: "dm-naozumi", kind: "dm", mentionCount: 0, name: "Naozumi Fujiwara", unreadCount: 2,
    participant: { displayName: "Naozumi Fujiwara", username: "naozumi" },
  },
]

const baseProps = {
  channels: CHANNELS,
  channelsState: "success",
  countsState: "success",
  currentUser: { displayName: "Tianjing Ye" },
  inboxUnreadCount: 7,
  labels: englishLabels,
  openClCount: 3,
  pathname: "/en/workspace/code",
  renderLink,
  workspaceBase: "/en/workspace",
} satisfies WorkspaceRailProps

function renderRail(overrides: Partial<WorkspaceRailProps> = {}) {
  const props = { ...baseProps, ...overrides } as WorkspaceRailProps
  return render(<WorkspaceRail {...props} />)
}

describe("WorkspaceRail (UI-05 AC1)", () => {
  it("renders fixed rail geometry and one side-nav-item per row", () => {
    const { container } = renderRail({ pathname: "/en/workspace/dm/eleanor" })
    const rail = container.querySelector('[data-mega-shell="workspace-rail"]') as HTMLElement
    expect(rail).toHaveStyle({ width: "220px", minWidth: "220px" })

    const rows = container.querySelectorAll('[data-mega-control="side-nav-item"]')
    // 7 main nav rows + 3 channels + "new channel" + 2 DMs + "new chat" = 14
    // (the profile footer link is not a SideNavItem row).
    expect(rows.length).toBe(14)
    for (const row of Array.from(rows)) {
      expect(row.tagName).toBe("A")
    }
  })

  it("marks only the exact-match row active (segment-boundary semantics, not prefix)", () => {
    renderRail({ pathname: "/en/workspace/dm/eleanor" })
    const link = screen.getByRole("link", { name: /Eleanor Vance/ })
    expect(link).toHaveAttribute("aria-current", "page")
    expect(link).toHaveAttribute("href", "/en/workspace/dm/eleanor")
    expect(screen.queryByText("Naozumi Fujiwara")?.closest("a")).not.toHaveAttribute("aria-current")
  })

  it("tolerates a trailing slash on pathname (path-collapse parity, nav-config normalizePath)", () => {
    renderRail({ pathname: "/en/workspace/code/" })
    const link = screen.getByRole("link", { name: englishLabels.items.code })
    expect(link).toHaveAttribute("aria-current", "page")
  })

  it("shows mention-tone counts for mentions and default-tone counts otherwise", () => {
    const { container } = renderRail()
    const codeReview = screen.getByText("code-review").closest('[data-mega-shell="rail-row-wrap"]') as HTMLElement
    const ciAlerts = screen.getByText("ci-alerts").closest('[data-mega-shell="rail-row-wrap"]') as HTMLElement
    expect(codeReview.querySelector('[data-tone="mention"]')?.textContent).toBe("3")
    expect(ciAlerts.querySelector('[data-tone="default"]')?.textContent).toBe("12")
    void container
  })

  it("shows unread/open-CL counts with the correct aria-labels on the inbox/cls nav rows", () => {
    renderRail()
    expect(screen.getByLabelText(`7 ${englishLabels.unread}`)).toBeInTheDocument()
    expect(screen.getByLabelText(`3 ${englishLabels.openChangeLists}`)).toBeInTheDocument()
  })

  it("renders channel presence dots for DM participants that have a status", () => {
    const { container } = renderRail()
    expect(container.querySelectorAll('[data-mega-atom="status-dot"]')).toHaveLength(1)
    expect(screen.getByLabelText(englishLabels.presence.away)).toBeInTheDocument()
  })

  it("orders channels and DMs in the caller-supplied order", () => {
    const { container } = renderRail()
    const channelNames = Array.from(container.querySelectorAll('[data-mega-shell="rail-row-label"]')).map((node) => node.textContent)
    expect(channelNames.indexOf("general")).toBeLessThan(channelNames.indexOf("code-review"))
    expect(channelNames.indexOf("Eleanor Vance")).toBeLessThan(channelNames.indexOf("Naozumi Fujiwara"))
  })

  it("shows same-shape loading skeletons and an aria-busy nav", () => {
    const { container } = renderRail({ channels: undefined, channelsState: "loading", countsState: "loading", userLoading: true })
    expect(container.querySelector("nav")).toHaveAttribute("aria-busy", "true")
    expect(container.querySelectorAll('[data-mega-shell="rail-skeleton-row"]')).toHaveLength(9)
    expect(screen.getByText(englishLabels.loading)).toBeInTheDocument()
    expect(screen.getByText(englishLabels.userLoading)).toBeInTheDocument()
    expect(container.querySelectorAll('[data-mega-shell="rail-count"]')).toHaveLength(0)
  })

  it("surfaces an actionable, code-bearing error state for channels and for counts, with working retry", async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    renderRail({ channels: undefined, channelsState: "error", onRetry })
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.getByText(englishLabels.loadError)).toBeInTheDocument()
    expect(screen.getByText("MEGA-NAV-LOAD")).toBeInTheDocument()
    await user.click(screen.getByText(englishLabels.retry))
    expect(onRetry).toHaveBeenCalledTimes(1)

    cleanup()
    const onCountsRetry = vi.fn()
    renderRail({ channels: [], countsState: "error", onCountsRetry })
    expect(screen.getByText("MEGA-NAV-COUNTS")).toBeInTheDocument()
    expect(screen.getByText(englishLabels.countsError)).toBeInTheDocument()
  })

  it("shows explanatory empty states when there are no channels/DMs", () => {
    renderRail({ channels: [], channelsState: "success" })
    expect(screen.getByText(englishLabels.noChannels)).toBeInTheDocument()
    expect(screen.getByText(englishLabels.noChats)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: englishLabels.newChannel })).toHaveAttribute("href", "/en/workspace/channels/new")
    expect(screen.getByRole("link", { name: englishLabels.newChat })).toHaveAttribute("href", "/en/workspace/dm/new")
  })

  it("clicking the search trigger invokes onSearch and shows the ⌘K hint", async () => {
    const user = userEvent.setup()
    const onSearch = vi.fn()
    renderRail({ onSearch })
    const search = screen.getByLabelText(englishLabels.searchAriaLabel)
    expect(search).toHaveAttribute("aria-haspopup", "dialog")
    expect(screen.getByText("⌘K")).toBeInTheDocument()
    await user.click(search)
    expect(onSearch).toHaveBeenCalledTimes(1)
  })

  it("renders zh-CN labels (i18n parity: WorkspaceRailLabels matches @megaui/i18n's workspace.nav shape)", () => {
    const chineseLabels = zhCN.workspace.nav satisfies WorkspaceRailLabels
    renderRail({ labels: chineseLabels, pathname: "/en/workspace/dm/eleanor" })
    expect(screen.getByLabelText(chineseLabels.presence.away)).toBeInTheDocument()
  })
})

describe("WorkspaceRail favorites section (UI-05 AC1 + AC4 integration)", () => {
  it("shows the empty state and no remove buttons when there are no favorites", () => {
    const { container } = renderRail()
    expect(screen.getByText(englishLabels.favoritesEmpty)).toBeInTheDocument()
    expect(container.querySelectorAll('[data-mega-shell="favorite-remove"]')).toHaveLength(0)
  })

  it("renders starred rows with working remove buttons; the star toggle reflects favoriteActive", async () => {
    const user = userEvent.setup()
    const onToggleFavorite = vi.fn()
    const onRemoveFavorite = vi.fn()
    renderRail({
      favoriteActive: true,
      favorites: [
        { href: "/en/workspace/cls/1208", icon: "git-pull", title: "!1208" },
        { href: "/en/workspace/channels/git-internal", icon: "hash", title: "#git-internal" },
      ],
      onRemoveFavorite,
      onToggleFavorite,
    })

    const toggle = screen.getByLabelText(englishLabels.addFavorite)
    expect(toggle).toHaveAttribute("aria-pressed", "true")
    await user.click(toggle)
    expect(onToggleFavorite).toHaveBeenCalledTimes(1)

    expect(screen.getByRole("link", { name: "!1208" })).toHaveAttribute("href", "/en/workspace/cls/1208")
    expect(screen.queryByText(englishLabels.favoritesEmpty)).not.toBeInTheDocument()

    const removeButton = screen.getByLabelText(englishLabels.removeFavorite.replace("{title}", "!1208"))
    await user.click(removeButton)
    expect(onRemoveFavorite).toHaveBeenCalledWith("/en/workspace/cls/1208")
  })
})

describe("WorkspaceRail profile footer (UI-05 AC1)", () => {
  it("marks the profile link active on the settings route and renders the avatar image when provided", () => {
    const { container } = renderRail({
      currentUser: { displayName: "Quanyi Ma", imageUrl: "data:image/png;base64,abc", initials: "QM" },
      pathname: "/en/workspace/settings",
    })
    const profileLink = screen.getByLabelText(englishLabels.openProfile)
    expect(profileLink).toHaveAttribute("aria-current", "page")
    expect(profileLink).toHaveAttribute("data-mega-shell", "rail-profile-link")
    expect(container.querySelector('[data-mega-shell="rail-footer"] [data-mega-atom="shell-avatar"]')).toHaveAttribute("src", "data:image/png;base64,abc")
  })

  it("falls back to labels.currentUser + derived initials when no currentUser is given", () => {
    renderRail({ currentUser: undefined })
    expect(screen.getByText(englishLabels.currentUser)).toBeInTheDocument()
  })
})
