// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import * as matchers from "@testing-library/jest-dom/matchers"

import { Separator } from "./separator"

expect.extend(matchers)
afterEach(() => cleanup())

describe("Separator (UI-02, upstream:libs/react-shared/ui/separator.tsx)", () => {
  it("defaults to a decorative horizontal separator (role=none, smoke)", () => {
    render(<Separator data-testid="sep" />)
    const sep = screen.getByTestId("sep")
    expect(sep).toBeInTheDocument()
    expect(sep).toHaveAttribute("data-slot", "separator-root")
    expect(sep).toHaveAttribute("data-orientation", "horizontal")
    // Radix marks decorative separators role="none" so screen readers skip them.
    expect(sep).toHaveAttribute("role", "none")
  })

  it("exposes role=separator (a11y) when decorative=false", () => {
    render(<Separator data-testid="sep" decorative={false} />)
    const sep = screen.getByRole("separator")
    expect(sep).toBe(screen.getByTestId("sep"))
  })

  it("supports the vertical orientation variant API", () => {
    render(<Separator data-testid="sep" orientation="vertical" decorative={false} />)
    const sep = screen.getByTestId("sep")
    expect(sep).toHaveAttribute("data-orientation", "vertical")
    expect(sep.className).toContain("data-[orientation=vertical]:w-px")
  })

  it("merges a caller-provided className", () => {
    render(<Separator data-testid="sep" className="custom-sep" />)
    expect(screen.getByTestId("sep").className).toContain("custom-sep")
  })
})
