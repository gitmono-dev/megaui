// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible"

afterEach(() => {
  cleanup()
})

describe("Collapsible", () => {
  it("renders the trigger and starts collapsed (content unmounted, per Radix Presence)", () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
        <CollapsibleContent>Hidden body</CollapsibleContent>
      </Collapsible>
    )
    expect(screen.getByText("Toggle")).toBeInTheDocument()
    expect(screen.queryByText("Hidden body")).not.toBeInTheDocument()
  })

  it("reveals the content once the trigger is clicked", async () => {
    const user = userEvent.setup()
    render(
      <Collapsible>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
        <CollapsibleContent>Hidden body</CollapsibleContent>
      </Collapsible>
    )
    await user.click(screen.getByText("Toggle"))
    expect(await screen.findByText("Hidden body")).toBeVisible()
  })
})
