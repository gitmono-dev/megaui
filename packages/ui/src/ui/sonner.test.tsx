// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import * as matchers from "@testing-library/jest-dom/matchers"
import { toast } from "sonner"

import { Toaster } from "./sonner"

expect.extend(matchers)
afterEach(() => cleanup())

describe("Toaster (UI-11, upstream:libs/react-shared/ui/sonner.tsx)", () => {
  it("renders a labeled notifications region (smoke + a11y)", () => {
    render(<Toaster />)
    expect(screen.getByRole("region", { name: /Notifications/i })).toBeInTheDocument()
  })

  it("defaults to theme=system, letting Sonner resolve light/dark itself", async () => {
    render(<Toaster />)
    // Sonner's `<ol data-sonner-toaster>` only mounts once a toast exists,
    // so trigger one to inspect the resolved `data-sonner-theme`. With no
    // explicit `theme` prop, Sonner resolves "system" via `matchMedia`
    // into a concrete "light"/"dark" (happy-dom reports no dark
    // preference, so "light" here) rather than reflecting "system" as-is.
    act(() => {
      toast("theme probe")
    })
    await screen.findByText("theme probe")

    const toaster = document.querySelector("[data-sonner-toaster]")
    expect(toaster).not.toBeNull()
    expect(toaster).toHaveAttribute("data-sonner-theme", "light")
  })

  it("forwards an explicit theme prop instead of the system default", async () => {
    render(<Toaster theme="dark" />)
    act(() => {
      toast("dark theme probe")
    })
    await screen.findByText("dark theme probe")

    const toaster = document.querySelector("[data-sonner-toaster]")
    expect(toaster).toHaveAttribute("data-sonner-theme", "dark")
  })

  it("shows a toast's message once triggered via the `sonner` toast() function", async () => {
    render(<Toaster />)

    act(() => {
      toast("Saved successfully")
    })

    expect(await screen.findByText("Saved successfully")).toBeInTheDocument()
  })

  it("shows a toast's title and description together", async () => {
    render(<Toaster />)

    act(() => {
      toast("Upload failed", { description: "The file exceeded the size limit." })
    })

    expect(await screen.findByText("Upload failed")).toBeInTheDocument()
    expect(await screen.findByText("The file exceeded the size limit.")).toBeInTheDocument()
  })
})
