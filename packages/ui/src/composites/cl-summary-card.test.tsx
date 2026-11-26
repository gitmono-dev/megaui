// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as matchers from "@testing-library/jest-dom/matchers"

import { CLSummaryCard, type CLSummary } from "./cl-summary-card"

expect.extend(matchers)
afterEach(() => cleanup())

const CL: CLSummary = {
  additions: 12,
  author: { id: "u1", username: "tianjing", displayName: "Tianjing", avatarInitials: "TJ" },
  deletions: 4,
  description: "Fixes the flaky retry loop.",
  publicId: "cl_42-testID",
  packageId: "apps/web",
  state: "ready",
  title: "Fix retry loop",
}

describe("CLSummaryCard (UI-09, upstream:libs/react-shared/components/mega/composites/cl-summary-card.tsx)", () => {
  it("renders the row variant with public ID, title and state label (smoke)", () => {
    render(<CLSummaryCard cl={CL} href="/workspace/cls/cl_42-testID" stateLabel="Ready" variant="row" />)
    expect(screen.getByText("cl_42-testID")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Fix retry loop" })).toHaveAttribute("href", "/workspace/cls/cl_42-testID")
    expect(screen.getByText("Ready")).toBeInTheDocument()
  })

  it("renders the unfurl variant with diff/file-count labels and description", () => {
    render(
      <CLSummaryCard
        cl={CL}
        diffLabel="+12 -4"
        fileCountLabel="3 files"
        href="/workspace/cls/cl_42-testID"
        packageLabel="apps/web"
        stateLabel="Ready"
        variant="unfurl"
      />
    )
    expect(screen.getByText("+12 -4")).toBeInTheDocument()
    expect(screen.getByText("Fixes the flaky retry loop.")).toBeInTheDocument()
  })

  it("renders the detail variant with the package label and author byline", () => {
    render(<CLSummaryCard cl={CL} href="/workspace/cls/cl_42-testID" packageLabel="apps/web" stateLabel="Ready" variant="detail" />)
    expect(screen.getByText("apps/web")).toBeInTheDocument()
    expect(screen.getByText("Tianjing")).toBeInTheDocument()
  })

  it("fires onSelect when the title link is clicked (interaction)", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<CLSummaryCard cl={CL} href="/workspace/cls/cl_42-testID" onSelect={onSelect} stateLabel="Ready" />)
    await user.click(screen.getByRole("link", { name: "Fix retry loop" }))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("renders a skeleton placeholder instead of content when loading (loading state)", () => {
    render(<CLSummaryCard cl={CL} href="/workspace/cls/cl_42-testID" loading stateLabel="Ready" />)
    expect(screen.queryByText("Fix retry loop")).not.toBeInTheDocument()
    expect(document.querySelector('[data-slot="cl-summary-card-skeleton"]')).toBeInTheDocument()
  })
})
