// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import * as matchers from "@testing-library/jest-dom/matchers"

import { Skeleton } from "./skeleton"

expect.extend(matchers)
afterEach(() => cleanup())

describe("Skeleton (UI-02, upstream:libs/react-shared/ui/skeleton.tsx)", () => {
  it("renders a pulsing placeholder <div> (smoke)", () => {
    render(<Skeleton data-testid="skel" />)
    const skel = screen.getByTestId("skel")
    expect(skel).toBeInTheDocument()
    expect(skel.tagName).toBe("DIV")
    expect(skel).toHaveAttribute("data-slot", "skeleton")
    expect(skel.className).toContain("animate-pulse")
    expect(skel.className).toContain("bg-accent")
  })

  it("merges a caller-provided className, e.g. explicit sizing", () => {
    render(<Skeleton data-testid="skel" className="h-4 w-32" />)
    const skel = screen.getByTestId("skel")
    expect(skel.className).toContain("h-4")
    expect(skel.className).toContain("w-32")
    expect(skel.className).toContain("animate-pulse")
  })

  it("forwards arbitrary div props (aria-hidden) for a11y control by consumers", () => {
    render(<Skeleton data-testid="skel" aria-hidden="true" />)
    expect(screen.getByTestId("skel")).toHaveAttribute("aria-hidden", "true")
  })
})
