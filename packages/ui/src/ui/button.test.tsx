// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as matchers from "@testing-library/jest-dom/matchers"

import { Button, buttonVariants } from "./button"

expect.extend(matchers)
afterEach(() => cleanup())

describe("Button (UI-02, upstream:libs/react-shared/ui/button.tsx)", () => {
  it("renders a native <button> with its label (smoke)", () => {
    render(<Button>Click me</Button>)
    const button = screen.getByRole("button", { name: "Click me" })
    expect(button).toBeInTheDocument()
    expect(button.tagName).toBe("BUTTON")
  })

  it("is keyboard-focusable and fires onClick (a11y baseline: focusable)", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Submit</Button>)
    const button = screen.getByRole("button", { name: "Submit" })

    await user.tab()
    expect(button).toHaveFocus()

    await user.keyboard("{Enter}")
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("disabled buttons are excluded from the tab order and not clickable", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Button onClick={onClick} disabled>Disabled</Button>)
    const button = screen.getByRole("button", { name: "Disabled" })

    expect(button).toBeDisabled()
    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it("keeps the upstream variant API: variant + size classNames differ per option", () => {
    expect(buttonVariants({ variant: "default" })).toContain("bg-primary")
    expect(buttonVariants({ variant: "destructive" })).toContain("bg-destructive")
    expect(buttonVariants({ variant: "outline" })).toContain("border-input")
    expect(buttonVariants({ variant: "secondary" })).toContain("bg-secondary")
    expect(buttonVariants({ variant: "ghost" })).toContain("hover:bg-accent")
    expect(buttonVariants({ variant: "link" })).toContain("underline-offset-4")

    expect(buttonVariants({ size: "sm" })).toContain("h-8")
    expect(buttonVariants({ size: "lg" })).toContain("h-10")
    expect(buttonVariants({ size: "icon" })).toContain("size-9")
  })

  it("defaults to variant=default size=default when unset", () => {
    render(<Button>Default</Button>)
    const button = screen.getByRole("button", { name: "Default" })
    expect(button.className).toContain("bg-primary")
    expect(button.className).toContain("h-9")
  })

  it("supports asChild (Slot) to render a different host element while keeping button styling", () => {
    render(
      <Button asChild>
        <a href="/somewhere">Link button</a>
      </Button>
    )
    const link = screen.getByRole("link", { name: "Link button" })
    expect(link.tagName).toBe("A")
    expect(link).toHaveAttribute("data-slot", "button")
    expect(link.className).toContain("bg-primary")
  })

  it("merges a caller-provided className with the variant classes", () => {
    render(<Button className="custom-class">Styled</Button>)
    const button = screen.getByRole("button", { name: "Styled" })
    expect(button.className).toContain("custom-class")
    expect(button.className).toContain("bg-primary")
  })
})
