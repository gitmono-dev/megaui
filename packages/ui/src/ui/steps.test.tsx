// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import * as matchers from "@testing-library/jest-dom/matchers"

import { Steps, type Step } from "./steps"

expect.extend(matchers)
afterEach(() => cleanup())

const STEPS: Step[] = [
  { title: "Account", description: "Create your account" },
  { title: "Profile", description: "Tell us about yourself" },
  { title: "Done", description: "You're all set" },
]

describe("Steps (UI-11, upstream:libs/react-shared/ui/steps.tsx)", () => {
  it("renders every step's title and description (smoke)", () => {
    render(<Steps steps={STEPS} currentStep={0} />)
    for (const step of STEPS) {
      expect(screen.getByText(step.title)).toBeInTheDocument()
      expect(screen.getByText(step.description)).toBeInTheDocument()
    }
  })

  it("marks steps at or before currentStep as active, and later ones as pending", () => {
    render(<Steps steps={STEPS} currentStep={1} />)

    expect(screen.getByText("Account").className).toContain("text-primary")
    expect(screen.getByText("Profile").className).toContain("text-primary")
    expect(screen.getByText("Done").className).toContain("text-muted-foreground")
  })

  it("merges a caller-provided className onto the root", () => {
    const { container } = render(
      <Steps steps={STEPS} currentStep={0} className="custom-steps" />
    )
    expect(container.firstElementChild).toHaveClass("custom-steps")
  })
})
