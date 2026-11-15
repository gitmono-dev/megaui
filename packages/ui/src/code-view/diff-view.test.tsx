// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { MegaDiffView } from "./diff-view"

afterEach(() => {
  cleanup()
})

const LABELS = { binaryFallback: "Binary file not shown.", renamed: "Renamed {from} to {to}" }

async function waitForDiffContent(container: HTMLElement) {
  await waitFor(() => {
    const host = container.querySelector("diffs-container")
    expect(host?.shadowRoot?.innerHTML.length ?? 0).toBeGreaterThan(0)
  })
}

describe("MegaDiffView", () => {
  it("renders an added file as type=new", async () => {
    const { container } = render(
      <MegaDiffView labels={LABELS} newFile={{ contents: "line 1\nline 2\n", name: "new.ts" }} oldFile={null} />
    )
    expect(container.querySelector('[data-mega-diff="root"]')).toHaveAttribute("data-mega-diff-type", "new")
    await waitForDiffContent(container)
  })

  it("renders a deleted file as type=deleted", async () => {
    const { container } = render(
      <MegaDiffView labels={LABELS} newFile={null} oldFile={{ contents: "line 1\nline 2\n", name: "old.ts" }} />
    )
    expect(container.querySelector('[data-mega-diff="root"]')).toHaveAttribute("data-mega-diff-type", "deleted")
    await waitForDiffContent(container)
  })

  it("renders a modified file as type=change", async () => {
    const { container } = render(
      <MegaDiffView
        labels={LABELS}
        newFile={{ contents: "a\nc\n", name: "f.ts" }}
        oldFile={{ contents: "a\nb\n", name: "f.ts" }}
      />
    )
    expect(container.querySelector('[data-mega-diff="root"]')).toHaveAttribute("data-mega-diff-type", "change")
    await waitForDiffContent(container)
  })

  it("renders a pure rename (identical content) with a rename banner", async () => {
    const { container } = render(
      <MegaDiffView
        labels={LABELS}
        newFile={{ contents: "a\nb\n", name: "new.ts" }}
        oldFile={{ contents: "a\nb\n", name: "old.ts" }}
      />
    )
    expect(container.querySelector('[data-mega-diff="root"]')).toHaveAttribute("data-mega-diff-type", "rename-pure")
    expect(screen.getByText("Renamed old.ts to new.ts")).toBeInTheDocument()
  })

  it("renders a rename with content changes as rename-changed, still showing the diff", async () => {
    const { container } = render(
      <MegaDiffView
        labels={LABELS}
        newFile={{ contents: "a\nc\n", name: "new.ts" }}
        oldFile={{ contents: "a\nb\n", name: "old.ts" }}
      />
    )
    expect(container.querySelector('[data-mega-diff="root"]')).toHaveAttribute("data-mega-diff-type", "rename-changed")
    expect(screen.getByText("Renamed old.ts to new.ts")).toBeInTheDocument()
    await waitForDiffContent(container)
  })

  it("falls back to a binary message instead of diffing/highlighting binary content", () => {
    const { container } = render(
      <MegaDiffView
        labels={LABELS}
        newFile={{ contents: "PNG\u0000\u0000IHDR", name: "logo.png" }}
        oldFile={{ contents: "PNG\u0000\u0000IHDA", name: "logo.png" }}
      />
    )
    expect(container.querySelector('[data-mega-diff="binary-fallback"]')).toBeInTheDocument()
    expect(screen.getByText("Binary file not shown.")).toBeInTheDocument()
    expect(container.querySelector("diffs-container")).not.toBeInTheDocument()
  })

  it("falls back to a binary message when only the new side is binary (e.g. a text file replaced by an image)", () => {
    const { container } = render(
      <MegaDiffView labels={LABELS} newFile={{ contents: "PNG\u0000\u0000IHDR", name: "asset" }} oldFile={{ contents: "hello\n", name: "asset" }} />
    )
    expect(container.querySelector('[data-mega-diff="binary-fallback"]')).toBeInTheDocument()
  })
})
