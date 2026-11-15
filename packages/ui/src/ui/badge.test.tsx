// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import * as matchers from "@testing-library/jest-dom/matchers"

import { Badge, badgeVariants } from "./badge"

expect.extend(matchers)
afterEach(() => cleanup())

describe("Badge (UI-02, upstream:libs/react-shared/ui/badge.tsx)", () => {
  it("renders a <span> with its label (smoke)", () => {
    render(<Badge>New</Badge>)
    const badge = screen.getByText("New")
    expect(badge).toBeInTheDocument()
    expect(badge.tagName).toBe("SPAN")
    expect(badge).toHaveAttribute("data-slot", "badge")
  })

  it("keeps the upstream variant API: variant classNames differ per option", () => {
    expect(badgeVariants({ variant: "default" })).toContain("bg-primary")
    expect(badgeVariants({ variant: "secondary" })).toContain("bg-secondary")
    expect(badgeVariants({ variant: "destructive" })).toContain("bg-destructive")
    expect(badgeVariants({ variant: "outline" })).toContain("text-foreground")
  })

  it("defaults to variant=default when unset", () => {
    render(<Badge>Default</Badge>)
    const badge = screen.getByText("Default")
    expect(badge.className).toContain("bg-primary")
  })

  it("supports asChild (Slot) to render a different host element, e.g. an anchor label", () => {
    render(
      <Badge asChild>
        <a href="/tag">Tag</a>
      </Badge>
    )
    const link = screen.getByRole("link", { name: "Tag" })
    expect(link.tagName).toBe("A")
    expect(link).toHaveAttribute("data-slot", "badge")
  })

  it("merges a caller-provided className with the variant classes", () => {
    render(<Badge className="custom-badge">Styled</Badge>)
    const badge = screen.getByText("Styled")
    expect(badge.className).toContain("custom-badge")
    expect(badge.className).toContain("bg-primary")
  })
})
