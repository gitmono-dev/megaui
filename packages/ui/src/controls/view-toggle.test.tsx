// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as matchers from "@testing-library/jest-dom/matchers"

import { ViewToggle } from "./view-toggle"

expect.extend(matchers)
afterEach(() => cleanup())

const OPTIONS = [
  { label: "List", value: "list" as const },
  { label: "Board", value: "board" as const },
  { disabled: true, label: "Timeline", value: "timeline" as const },
]

describe("ViewToggle (UI-09, upstream:libs/react-shared/components/mega/controls/tabs.tsx)", () => {
  it("renders every option with the selected one pressed (smoke)", () => {
    render(<ViewToggle ariaLabel="Issue view" onValueChange={vi.fn()} options={OPTIONS} value="list" />)
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "false")
  })

  it("fires onValueChange with the clicked option's value (interaction)", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<ViewToggle ariaLabel="Issue view" onValueChange={onValueChange} options={OPTIONS} value="list" />)
    await user.click(screen.getByRole("button", { name: "Board" }))
    expect(onValueChange).toHaveBeenCalledWith("board")
  })

  it("disables options flagged disabled and never fires onValueChange for them", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<ViewToggle ariaLabel="Issue view" onValueChange={onValueChange} options={OPTIONS} value="list" />)
    const timeline = screen.getByRole("button", { name: "Timeline" })
    expect(timeline).toBeDisabled()
    await user.click(timeline)
    expect(onValueChange).not.toHaveBeenCalled()
  })
})
