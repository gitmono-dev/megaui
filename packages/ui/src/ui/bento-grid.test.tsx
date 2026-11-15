// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { BentoCard, BentoGrid } from "./bento-grid"

afterEach(() => {
  cleanup()
})

function DummyIcon(props: React.ComponentProps<"svg">) {
  return (
    <svg data-testid="dummy-icon" {...props}>
      <title>icon</title>
    </svg>
  )
}

describe("BentoGrid / BentoCard", () => {
  it("renders the grid container with its children", () => {
    render(
      <BentoGrid className="custom-grid">
        <div>child</div>
      </BentoGrid>
    )
    expect(screen.getByText("child")).toBeInTheDocument()
  })

  it("renders a BentoCard's name, description, icon and CTA link", () => {
    render(
      <BentoGrid>
        <BentoCard
          name="Feature name"
          className="col-span-1"
          background={<div>bg</div>}
          Icon={DummyIcon}
          description="Feature description"
          href="/features/one"
          cta="Learn more"
        />
      </BentoGrid>
    )

    expect(screen.getByText("Feature name")).toBeInTheDocument()
    expect(screen.getByText("Feature description")).toBeInTheDocument()
    expect(screen.getByTestId("dummy-icon")).toBeInTheDocument()

    const cta = screen.getByRole("link", { name: /learn more/i })
    expect(cta).toHaveAttribute("href", "/features/one")
  })
})
