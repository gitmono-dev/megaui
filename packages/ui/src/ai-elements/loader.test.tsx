// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import * as matchers from "@testing-library/jest-dom/matchers"

import { Loader } from "./loader"

expect.extend(matchers)
afterEach(() => cleanup())

describe("Loader (UI-09, upstream:libs/react-shared/components/ai-elements/loader.tsx)", () => {
  it("renders a spinning placeholder (smoke, loading state)", () => {
    render(<Loader data-testid="loader" />)
    const loader = document.querySelector('[data-testid="loader"]')
    expect(loader).toBeInTheDocument()
    expect(loader).toHaveAttribute("data-slot", "loader")
    expect(loader?.querySelector("svg")).toHaveClass("animate-spin")
  })

  it("forwards a custom size to the inner icon", () => {
    render(<Loader data-testid="loader" size={32} />)
    const svg = document.querySelector('[data-testid="loader"] svg')
    expect(svg).toHaveAttribute("width", "32")
    expect(svg).toHaveAttribute("height", "32")
  })
})
