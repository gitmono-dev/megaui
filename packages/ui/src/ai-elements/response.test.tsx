// @vitest-environment happy-dom
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import * as matchers from "@testing-library/jest-dom/matchers"

// `streamdown` side-effect-imports `katex/dist/katex.min.css` at its module
// root; Vitest externalizes third-party ESM deps by default (no Vite CSS
// transform), so that raw `.css` import fails to load under Node. Editing
// the root `vitest.config.ts` to inline/transform it is out of this card's
// write set, so this test mocks the package boundary instead — `Response`
// is a thin pass-through wrapper, so what's under test is that it forwards
// `children`/`className`, not `streamdown`'s own markdown rendering.
vi.mock("streamdown", () => ({
  Streamdown: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div className={className} data-slot="streamdown-mock">
      {children}
    </div>
  ),
}))

const { Response } = await import("./response")

expect.extend(matchers)
afterEach(() => cleanup())

describe("Response (UI-09, upstream:libs/react-shared/components/ai-elements/response.tsx)", () => {
  it("forwards its markdown children through to Streamdown (smoke)", () => {
    render(<Response>{"Deployed to production."}</Response>)
    expect(screen.getByText("Deployed to production.")).toBeInTheDocument()
  })

  it("merges a caller-provided className", () => {
    render(<Response className="custom-response">Hello</Response>)
    expect(document.querySelector('[data-slot="streamdown-mock"]')).toHaveClass("custom-response")
  })
})
