// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as matchers from "@testing-library/jest-dom/matchers"

import { IssueCard, type IssueSummary } from "./issue-card"

expect.extend(matchers)
afterEach(() => cleanup())

const ISSUE: IssueSummary = {
  author: { id: "u1", username: "tianjing", displayName: "Tianjing", avatarInitials: "TJ" },
  labels: [{ id: "l1", name: "bug", color: "#ef4444" }],
  number: 7,
  priority: "P1",
  state: "open",
  title: "Search returns stale results",
}

describe("IssueCard (UI-09, megaui-only)", () => {
  it("renders the row variant with number, title, labels and state (smoke)", () => {
    render(<IssueCard href="/workspace/issues/7" issue={ISSUE} priorityLabel="P1" stateLabel="Open" variant="row" />)
    expect(screen.getByText("#7")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Search returns stale results" })).toHaveAttribute(
      "href",
      "/workspace/issues/7"
    )
    expect(screen.getByText("bug")).toBeInTheDocument()
    expect(screen.getByText("P1")).toBeInTheDocument()
    expect(screen.getByText("Open")).toBeInTheDocument()
  })

  it("renders the detail variant with the comment-count label and author byline", () => {
    render(
      <IssueCard
        commentCountLabel="3 comments"
        href="/workspace/issues/7"
        issue={ISSUE}
        stateLabel="Open"
        variant="detail"
      />
    )
    expect(screen.getByText("3 comments")).toBeInTheDocument()
    expect(screen.getByText("Tianjing")).toBeInTheDocument()
  })

  it("fires onSelect when the title link is clicked (interaction)", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<IssueCard href="/workspace/issues/7" issue={ISSUE} onSelect={onSelect} stateLabel="Open" />)
    await user.click(screen.getByRole("link", { name: "Search returns stale results" }))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("renders a skeleton placeholder instead of content when loading (loading state)", () => {
    render(<IssueCard href="/workspace/issues/7" issue={ISSUE} loading stateLabel="Open" />)
    expect(screen.queryByText("Search returns stale results")).not.toBeInTheDocument()
    expect(document.querySelector('[data-slot="issue-card-skeleton"]')).toBeInTheDocument()
  })
})
