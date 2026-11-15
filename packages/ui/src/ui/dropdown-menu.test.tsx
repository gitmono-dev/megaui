// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu"

afterEach(() => {
  cleanup()
})

function renderMenu(onSelectSecondItem: () => void) {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>First item</DropdownMenuItem>
        <DropdownMenuItem onSelect={onSelectSecondItem}>
          Second item
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

describe("DropdownMenu", () => {
  it("renders the trigger and keeps the menu closed until activated", () => {
    renderMenu(vi.fn())
    expect(screen.getByText("Open menu")).toBeInTheDocument()
    expect(screen.queryByText("First item")).not.toBeInTheDocument()
  })

  it("opens and navigates/selects items via the keyboard (keyboard nav smoke)", async () => {
    const user = userEvent.setup()
    const onSelectSecondItem = vi.fn()
    renderMenu(onSelectSecondItem)

    await user.tab()
    expect(screen.getByText("Open menu")).toHaveFocus()

    await user.keyboard("{Enter}")
    expect(await screen.findByText("First item")).toBeInTheDocument()

    await user.keyboard("{ArrowDown}")
    await user.keyboard("{Enter}")

    expect(onSelectSecondItem).toHaveBeenCalledTimes(1)
  })

  it("preserves the upstream `variant` API on DropdownMenuItem (destructive)", async () => {
    const user = userEvent.setup()
    renderMenu(vi.fn())
    await user.click(screen.getByText("Open menu"))
    const dangerItem = await screen.findByText("Delete")
    expect(dangerItem.closest('[data-slot="dropdown-menu-item"]')).toHaveAttribute(
      "data-variant",
      "destructive"
    )
  })
})
