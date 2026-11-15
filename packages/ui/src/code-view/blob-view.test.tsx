// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { MegaBlobView } from "./blob-view"

afterEach(() => {
  cleanup()
})

const LABELS = { binaryFallback: "Binary file not shown.", copied: "Copied!", copy: "Copy" }

describe("MegaBlobView", () => {
  it("renders highlighted content via Shiki for ordinary text", async () => {
    const { container } = render(<MegaBlobView file={{ contents: "const x = 1\n", name: "a.ts" }} labels={LABELS} />)
    await waitFor(() => {
      const host = container.querySelector("diffs-container")
      expect(host?.shadowRoot?.innerHTML.length ?? 0).toBeGreaterThan(0)
    })
  })

  it("reflects a controlled line-anchor selection in the rendered output", async () => {
    const { container } = render(
      <MegaBlobView file={{ contents: "a\nb\nc\n", name: "a.ts" }} labels={LABELS} selectedLines={{ end: 2, start: 2 }} />
    )
    await waitFor(() => {
      const host = container.querySelector("diffs-container")
      expect(host?.shadowRoot?.innerHTML ?? "").toContain("data-selected-line")
    })
  })

  it("falls back to a binary message and skips Shiki for binary content", () => {
    const { container } = render(<MegaBlobView file={{ contents: "PNG\u0000\u0000IHDR", name: "logo.png" }} labels={LABELS} />)
    expect(screen.getByText("Binary file not shown.")).toBeInTheDocument()
    expect(container.querySelector("diffs-container")).not.toBeInTheDocument()
  })

  it("renders a plaintext fallback that still supports line anchors, when forced", () => {
    const onSelectedLinesChange = vi.fn()
    render(
      <MegaBlobView
        file={{ contents: "a\nb\nc\n", name: "a.ts" }}
        forcePlainText
        labels={LABELS}
        onSelectedLinesChange={onSelectedLinesChange}
        selectedLines={{ end: 2, start: 2 }}
      />
    )
    const selectedLine = document.querySelector('[data-line-number="2"]')
    expect(selectedLine).toHaveAttribute("data-selected", "true")
    const otherLine = document.querySelector('[data-line-number="1"]')
    expect(otherLine).toHaveAttribute("data-selected", "false")

    if (!otherLine) throw new Error("expected line 1 to render")
    fireEvent.click(otherLine)
    expect(onSelectedLinesChange).toHaveBeenCalledWith({ end: 1, start: 1 })
  })

  it("copies the file contents to the clipboard and shows a confirmation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })

    render(<MegaBlobView file={{ contents: "const x = 1\n", name: "a.ts" }} labels={LABELS} />)
    fireEvent.click(screen.getByText("Copy"))

    expect(writeText).toHaveBeenCalledWith("const x = 1\n")
    await waitFor(() => expect(screen.getByText("Copied!")).toBeInTheDocument())
  })
})
