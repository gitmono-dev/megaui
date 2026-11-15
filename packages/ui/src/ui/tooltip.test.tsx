// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"

import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

afterEach(() => {
  cleanup()
})

describe("Tooltip", () => {
  it("renders the trigger and keeps the tooltip content closed until activated", () => {
    render(
      <Tooltip>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent>Helpful hint</TooltipContent>
      </Tooltip>
    )
    expect(screen.getByText("Hover me")).toBeInTheDocument()
    expect(screen.queryByText("Helpful hint")).not.toBeInTheDocument()
  })

  it("shows the tooltip content once the trigger is focused", async () => {
    const user = userEvent.setup()
    render(
      <Tooltip>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent>Helpful hint</TooltipContent>
      </Tooltip>
    )
    await user.tab()
    const tooltip = await screen.findByRole("tooltip")
    expect(tooltip).toHaveTextContent("Helpful hint")
  })
})
