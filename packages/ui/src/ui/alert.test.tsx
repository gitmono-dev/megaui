// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import * as matchers from "@testing-library/jest-dom/matchers"

import { Alert, AlertDescription, AlertTitle } from "./alert"

expect.extend(matchers)
afterEach(() => cleanup())

describe("Alert (UI-02, upstream:libs/react-shared/ui/alert.tsx)", () => {
  it("renders with role=alert and its title/description text (smoke + a11y role)", () => {
    render(
      <Alert>
        <AlertTitle>Heads up</AlertTitle>
        <AlertDescription>Something happened.</AlertDescription>
      </Alert>
    )

    const alert = screen.getByRole("alert")
    expect(alert).toBeInTheDocument()
    expect(alert).toHaveAttribute("data-slot", "alert")
    expect(screen.getByText("Heads up")).toHaveAttribute("data-slot", "alert-title")
    expect(screen.getByText("Something happened.")).toHaveAttribute(
      "data-slot",
      "alert-description"
    )
  })

  it("keeps the upstream variant API: default vs destructive classNames differ", () => {
    const { rerender } = render(<Alert data-testid="alert">Default</Alert>)
    expect(screen.getByTestId("alert").className).toContain("bg-card")
    expect(screen.getByTestId("alert").className).not.toContain("text-destructive")

    rerender(
      <Alert data-testid="alert" variant="destructive">
        Danger
      </Alert>
    )
    expect(screen.getByTestId("alert").className).toContain("text-destructive")
  })

  it("merges a caller-provided className with the variant classes", () => {
    render(
      <Alert className="custom-alert" data-testid="alert">
        x
      </Alert>
    )
    const alert = screen.getByTestId("alert")
    expect(alert.className).toContain("custom-alert")
    expect(alert.className).toContain("bg-card")
  })
})
