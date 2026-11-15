// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"

import { Popover, PopoverContent, PopoverTrigger } from "./popover"

afterEach(() => {
  cleanup()
})

describe("Popover", () => {
  it("renders the trigger and keeps the content closed until activated", () => {
    render(
      <Popover>
        <PopoverTrigger>Open popover</PopoverTrigger>
        <PopoverContent>Popover body</PopoverContent>
      </Popover>
    )
    expect(screen.getByText("Open popover")).toBeInTheDocument()
    expect(screen.queryByText("Popover body")).not.toBeInTheDocument()
  })

  it("shows the content once the trigger is clicked", async () => {
    const user = userEvent.setup()
    render(
      <Popover>
        <PopoverTrigger>Open popover</PopoverTrigger>
        <PopoverContent>Popover body</PopoverContent>
      </Popover>
    )
    await user.click(screen.getByText("Open popover"))
    expect(await screen.findByText("Popover body")).toBeInTheDocument()
  })
})
