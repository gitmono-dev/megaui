// @vitest-environment happy-dom
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as matchers from "@testing-library/jest-dom/matchers"

import { FilterBar, type FilterBarFilter, type FilterBarProps } from "./filter-bar"

function ControlledFilterBar(props: Omit<FilterBarProps, "onValueChange" | "value"> & { onValueChange: (value: string) => void }) {
  const [value, setValue] = useState("")
  return (
    <FilterBar
      {...props}
      onValueChange={(next) => {
        setValue(next)
        props.onValueChange(next)
      }}
      value={value}
    />
  )
}

expect.extend(matchers)
afterEach(() => cleanup())

const STATE_FILTER: FilterBarFilter = {
  key: "state",
  label: "State",
  onSelect: vi.fn(),
  options: [
    { label: "Open", selected: true, value: "open" },
    { label: "Closed", selected: false, value: "closed" },
  ],
}

describe("FilterBar (UI-09, upstream:libs/react-shared/components/mega/controls/{filter-query-bar,dropdown}.tsx)", () => {
  it("renders a labeled search input (smoke)", () => {
    render(<FilterBar ariaLabel="Search issues" onValueChange={vi.fn()} value="" />)
    expect(screen.getByRole("textbox", { name: "Search issues" })).toBeInTheDocument()
  })

  it("fires onValueChange as the caller types (interaction)", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<ControlledFilterBar ariaLabel="Search issues" onValueChange={onValueChange} />)
    await user.type(screen.getByRole("textbox", { name: "Search issues" }), "bug")
    expect(onValueChange).toHaveBeenLastCalledWith("bug")
  })

  it("opens a filter dropdown and fires onSelect with the picked option's value (interaction)", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <FilterBar
        ariaLabel="Search issues"
        filters={[{ ...STATE_FILTER, onSelect }]}
        onValueChange={vi.fn()}
        value=""
      />
    )
    await user.click(screen.getByRole("button", { name: "State" }))
    await user.click(await screen.findByText("Closed"))
    expect(onSelect).toHaveBeenCalledWith("closed")
  })
})
