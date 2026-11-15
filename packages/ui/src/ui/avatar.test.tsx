// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import * as matchers from "@testing-library/jest-dom/matchers"

import { Avatar, AvatarFallback, AvatarImage } from "./avatar"

expect.extend(matchers)
afterEach(() => cleanup())

describe("Avatar (UI-02, upstream:libs/react-shared/ui/avatar.tsx)", () => {
  it("renders the fallback label when no image has loaded (smoke + a11y label)", () => {
    render(
      <Avatar data-testid="avatar-root">
        <AvatarImage src="https://example.invalid/avatar.png" alt="Jane Doe" />
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    )

    const root = screen.getByTestId("avatar-root")
    expect(root).toHaveAttribute("data-slot", "avatar")

    const fallback = screen.getByText("JD")
    expect(fallback).toBeInTheDocument()
    expect(fallback).toHaveAttribute("data-slot", "avatar-fallback")
  })

  it("Avatar root applies the upstream circular-clip classes", () => {
    render(
      <Avatar data-testid="avatar-root">
        <AvatarFallback>AB</AvatarFallback>
      </Avatar>
    )
    const root = screen.getByTestId("avatar-root")
    expect(root.className).toContain("rounded-full")
    expect(root.className).toContain("overflow-hidden")
  })

  it("merges a caller-provided className on the fallback", () => {
    render(
      <Avatar>
        <AvatarFallback className="custom-fallback">CD</AvatarFallback>
      </Avatar>
    )
    const fallback = screen.getByText("CD")
    expect(fallback.className).toContain("custom-fallback")
    expect(fallback.className).toContain("rounded-full")
  })
})
