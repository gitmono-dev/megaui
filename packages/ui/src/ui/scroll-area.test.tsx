// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { ScrollArea, ScrollBar } from "./scroll-area"

afterEach(() => {
  cleanup()
})

describe("ScrollArea", () => {
  it("renders its viewport content", () => {
    render(
      <ScrollArea className="h-40">
        <div>Scrollable body</div>
      </ScrollArea>
    )
    expect(screen.getByText("Scrollable body")).toBeInTheDocument()
  })

  it("renders a vertical scrollbar by default and a horizontal one when requested", () => {
    // `type="always"` bypasses Radix's overflow/hover-based auto-hide
    // logic, which never fires in happy-dom (no real layout/scrollHeight
    // computation, so the default `type="hover"` scrollbars stay unmounted).
    const { container } = render(
      <ScrollArea type="always">
        <div>content</div>
        <ScrollBar data-testid="v-bar" />
        <ScrollBar orientation="horizontal" data-testid="h-bar" />
      </ScrollArea>
    )
    expect(
      container.querySelector('[data-orientation="vertical"]')
    ).toBeInTheDocument()
    expect(screen.getByTestId("h-bar")).toHaveAttribute(
      "data-orientation",
      "horizontal"
    )
  })
})
