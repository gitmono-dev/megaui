// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs"

afterEach(() => {
  cleanup()
})

function renderTabs() {
  render(
    <Tabs defaultValue="one">
      <TabsList>
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
      </TabsList>
      <TabsContent value="one">Panel one</TabsContent>
      <TabsContent value="two">Panel two</TabsContent>
    </Tabs>
  )
}

describe("Tabs", () => {
  it("renders the default tab's panel and hides the other", () => {
    renderTabs()
    expect(screen.getByText("Panel one")).toBeInTheDocument()
    expect(screen.queryByText("Panel two")).not.toBeInTheDocument()
  })

  it("switches panels via arrow-key navigation (keyboard nav smoke)", async () => {
    const user = userEvent.setup()
    renderTabs()

    await user.tab()
    expect(screen.getByRole("tab", { name: "One" })).toHaveFocus()

    await user.keyboard("{ArrowRight}")
    expect(screen.getByRole("tab", { name: "Two" })).toHaveFocus()
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(await screen.findByText("Panel two")).toBeInTheDocument()
    expect(screen.queryByText("Panel one")).not.toBeInTheDocument()
  })
})
