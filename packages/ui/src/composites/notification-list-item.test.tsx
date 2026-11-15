// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as matchers from "@testing-library/jest-dom/matchers"

import { NotificationListItem } from "./notification-list-item"

expect.extend(matchers)
afterEach(() => cleanup())

describe("NotificationListItem (UI-09, upstream:libs/react-shared/components/mega/composites/dashboard.tsx)", () => {
  it("renders an anchor row with the title and timestamp when given href (smoke)", () => {
    render(<NotificationListItem href="/workspace/issues/7" id="n1" timestampLabel="2h ago" title="Ada mentioned you" />)
    const link = screen.getByRole("link", { name: /Ada mentioned you/ })
    expect(link).toHaveAttribute("href", "/workspace/issues/7")
    expect(screen.getByText("2h ago")).toBeInTheDocument()
  })

  it("renders an unread indicator by default and hides it once read", () => {
    const { rerender } = render(
      <NotificationListItem href="/workspace/issues/7" id="n1" timestampLabel="2h ago" title="Ada mentioned you" />
    )
    expect(document.querySelector('[data-notification-id="n1"]')).toHaveAttribute("data-read", "false")

    rerender(<NotificationListItem href="/workspace/issues/7" id="n1" read timestampLabel="2h ago" title="Ada mentioned you" />)
    expect(document.querySelector('[data-notification-id="n1"]')).toHaveAttribute("data-read", "true")
  })

  it("renders a button row and fires onSelect when given onSelect (interaction)", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<NotificationListItem id="n2" onSelect={onSelect} timestampLabel="1d ago" title="Your CL was merged" />)
    await user.click(screen.getByRole("button", { name: /Your CL was merged/ }))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("renders a skeleton placeholder instead of content when loading (loading state)", () => {
    render(<NotificationListItem href="/workspace/issues/7" id="n1" loading timestampLabel="2h ago" title="Ada mentioned you" />)
    expect(screen.queryByText("Ada mentioned you")).not.toBeInTheDocument()
    expect(document.querySelector('[data-slot="notification-list-item-skeleton"]')).toBeInTheDocument()
  })
})
