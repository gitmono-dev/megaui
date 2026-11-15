// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as matchers from "@testing-library/jest-dom/matchers"

import { SocialButton } from "./social-button"

expect.extend(matchers)
afterEach(() => cleanup())

describe("SocialButton (UI-11, upstream:libs/react-shared/ui/social-button.tsx)", () => {
  it("renders the caller-supplied translated label and an icon (smoke)", () => {
    render(<SocialButton provider="github" label="GitHub" />)
    const button = screen.getByRole("button", { name: "GitHub" })
    expect(button).toBeInTheDocument()
    expect(button.querySelector("svg")).not.toBeNull()
  })

  it("supports the google/github/apple provider set", () => {
    render(
      <>
        <SocialButton provider="google" label="Google" />
        <SocialButton provider="github" label="GitHub" />
        <SocialButton provider="apple" label="Apple" />
      </>
    )
    expect(screen.getByRole("button", { name: "Google" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "GitHub" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Apple" })).toBeInTheDocument()
  })

  it("shows a spinner and disables the button while loading", () => {
    render(<SocialButton provider="google" label="Google" loading />)
    const button = screen.getByRole("button", { name: "Google" })
    expect(button).toBeDisabled()
    expect(button.querySelector(".animate-spin")).not.toBeNull()
  })

  it("fires onClick when clicked and not disabled", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<SocialButton provider="apple" label="Apple" onClick={onClick} />)
    await user.click(screen.getByRole("button", { name: "Apple" }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
