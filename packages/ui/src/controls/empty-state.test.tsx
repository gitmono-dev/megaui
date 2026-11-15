// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import * as matchers from "@testing-library/jest-dom/matchers"

import { EmptyState } from "./empty-state"

expect.extend(matchers)
afterEach(() => cleanup())

describe("EmptyState (UI-09, upstream:libs/react-shared/components/ai-elements/conversation.tsx)", () => {
  it("renders the title, description, icon and action (smoke, empty state)", () => {
    render(
      <EmptyState
        action={<button type="button">Retry</button>}
        description="Try adjusting your filters."
        icon={<span data-testid="icon" />}
        title="No issues found"
      />
    )
    expect(screen.getByText("No issues found")).toBeInTheDocument()
    expect(screen.getByText("Try adjusting your filters.")).toBeInTheDocument()
    expect(screen.getByTestId("icon")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
  })

  it("defaults to the empty tone with no alert role", () => {
    render(<EmptyState title="No issues found" />)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(document.querySelector('[data-slot="empty-state"]')).toHaveAttribute("data-tone", "empty")
  })

  it("renders the error tone as an alert with destructive-styled text (error state)", () => {
    render(<EmptyState title="Failed to load issues" tone="error" />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveAttribute("data-tone", "error")
    expect(screen.getByText("Failed to load issues")).toHaveClass("text-destructive")
  })
})
