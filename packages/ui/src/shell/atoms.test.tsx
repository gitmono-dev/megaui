// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { KbdChip, SectionLabel, ShellAvatar, SideNavItem, StatusDot } from "./atoms"

afterEach(() => {
  cleanup()
})

describe("ShellAvatar", () => {
  it("renders initials when no image is available", () => {
    render(<ShellAvatar initials="TY" />)
    expect(screen.getByLabelText("TY")).toBeInTheDocument()
  })

  it("renders an <img> when an image URL is provided, preferring it over initials", () => {
    const { container } = render(<ShellAvatar image="https://example.test/a.png" initials="TY" />)
    const img = container.querySelector("img")
    expect(img).toHaveAttribute("src", "https://example.test/a.png")
    expect(img).toHaveAttribute("aria-label", "TY")
  })

  it("reads label/image from a `user` prop when no direct props are given", () => {
    render(<ShellAvatar user={{ avatarInitials: "QM", avatarUrl: null }} />)
    expect(screen.getByLabelText("QM")).toBeInTheDocument()
  })
})

describe("StatusDot", () => {
  it("defaults its aria-label to the status name", () => {
    render(<StatusDot status="away" />)
    expect(screen.getByLabelText("away")).toBeInTheDocument()
  })

  it("accepts a custom aria-label", () => {
    render(<StatusDot ariaLabel="Away until Monday" status="away" />)
    expect(screen.getByLabelText("Away until Monday")).toBeInTheDocument()
  })
})

describe("KbdChip", () => {
  it("renders its children inside a <kbd>", () => {
    render(<KbdChip>⌘K</KbdChip>)
    const kbd = screen.getByText("⌘K")
    expect(kbd.tagName).toBe("KBD")
  })
})

describe("SectionLabel", () => {
  it("renders the label text and an optional action slot", () => {
    render(<SectionLabel action={<button type="button">Add</button>}>Channels</SectionLabel>)
    expect(screen.getByText("Channels")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument()
  })
})

describe("SideNavItem", () => {
  it("marks the active item with aria-current=page and data-active=true", () => {
    render(<SideNavItem active label="Home" />)
    const item = screen.getByRole("button", { name: "Home" })
    expect(item).toHaveAttribute("aria-current", "page")
    expect(item).toHaveAttribute("data-active", "true")
  })

  it("is keyboard-activatable and calls onSelect", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<SideNavItem label="Inbox" onSelect={onSelect} />)

    await user.tab()
    expect(screen.getByRole("button", { name: "Inbox" })).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("disabled items block onSelect and are excluded from the tab order when asChild", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <SideNavItem asChild disabled label={<a href="/x">Link</a>} onSelect={onSelect} />,
    )
    const link = screen.getByRole("link", { name: "Link" })
    expect(link).toHaveAttribute("aria-disabled", "true")
    expect(link).toHaveAttribute("tabindex", "-1")

    await user.click(link)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("asChild renders the provided element as the host, forwarding nav semantics", () => {
    render(<SideNavItem asChild label={<a href="/settings">Settings</a>} />)
    const link = screen.getByRole("link", { name: "Settings" })
    expect(link).toHaveAttribute("data-mega-control", "side-nav-item")
    expect(link).toHaveAttribute("href", "/settings")
  })
})
