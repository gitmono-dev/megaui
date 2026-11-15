// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { SHELL_ICON_NAMES, ShellIcon } from "./icons"

describe("ShellIcon (megaui:libs/react-shared/components/mega/icons.tsx@0ff3a9d subset)", () => {
  it("renders every declared name to a single <svg>", () => {
    for (const name of SHELL_ICON_NAMES) {
      const { container, unmount } = render(<ShellIcon name={name} />)
      expect(container.querySelectorAll("svg")).toHaveLength(1)
      unmount()
    }
  })

  it("applies the requested size to both svg dimensions", () => {
    const { container } = render(<ShellIcon name="home" size={20} />)
    const svg = container.querySelector("svg")
    expect(svg).toHaveAttribute("width", "20")
    expect(svg).toHaveAttribute("height", "20")
  })

  it("forwards aria-hidden and a custom color", () => {
    const { container } = render(<ShellIcon aria-hidden="true" color="#123456" name="star" />)
    const svg = container.querySelector("svg")
    expect(svg).toHaveAttribute("aria-hidden", "true")
    expect(svg).toHaveAttribute("stroke", "#123456")
  })
})
