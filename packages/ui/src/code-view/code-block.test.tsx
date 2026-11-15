// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { MegaCodeBlock } from "./code-block"

afterEach(() => {
  cleanup()
})

describe("MegaCodeBlock", () => {
  it("renders highlighted content for a known language", async () => {
    const { container } = render(<MegaCodeBlock language="typescript" text="const x = 1\n" />)
    const host = container.querySelector('[data-mega-code-block="typescript"]')
    expect(host).toBeInTheDocument()
    await waitFor(() => {
      const diffsHost = host?.querySelector("diffs-container")
      expect(diffsHost?.shadowRoot?.innerHTML.length ?? 0).toBeGreaterThan(0)
    })
  })

  it("falls back to a plain extension when the language is unrecognized", () => {
    const { container } = render(<MegaCodeBlock language="klingon" text="qapla'\n" />)
    expect(container.querySelector('[data-mega-code-block="klingon"]')).toBeInTheDocument()
  })

  it("labels the block as plain when no language is given", () => {
    const { container } = render(<MegaCodeBlock text="hello\n" />)
    expect(container.querySelector('[data-mega-code-block="plain"]')).toBeInTheDocument()
  })

  it("hydrates from prerenderedHTML without requiring a worker pool", () => {
    const { container } = render(<MegaCodeBlock prerenderedHTML="<pre>cached</pre>" text="const x = 1\n" />)
    expect(container.querySelector("diffs-container")).toBeInTheDocument()
  })
})
