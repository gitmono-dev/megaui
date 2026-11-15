// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import * as matchers from "@testing-library/jest-dom/matchers"

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./resizable"

expect.extend(matchers)
afterEach(() => cleanup())

describe("Resizable (UI-11, upstream:libs/react-shared/ui/resizable.tsx)", () => {
  it("renders a panel group with two panels and a handle between them (smoke)", () => {
    const { container } = render(
      <ResizablePanelGroup direction="horizontal" data-testid="group">
        <ResizablePanel defaultSize={50} data-testid="left">
          left
        </ResizablePanel>
        <ResizableHandle data-testid="handle" />
        <ResizablePanel defaultSize={50} data-testid="right">
          right
        </ResizablePanel>
      </ResizablePanelGroup>
    )

    const group = container.querySelector('[data-testid="group"]')
    expect(group).toBeInTheDocument()
    expect(group).toHaveAttribute("data-slot", "resizable-panel-group")
    expect(group?.className).toContain("flex")

    const left = container.querySelector('[data-testid="left"]')
    const right = container.querySelector('[data-testid="right"]')
    expect(left).toHaveAttribute("data-slot", "resizable-panel")
    expect(right).toHaveAttribute("data-slot", "resizable-panel")
    expect(left).toHaveTextContent("left")
    expect(right).toHaveTextContent("right")

    const handle = container.querySelector('[data-testid="handle"]')
    expect(handle).toBeInTheDocument()
    expect(handle).toHaveAttribute("data-slot", "resizable-handle")
    expect(handle).toHaveAttribute("role", "separator")
  })

  it("renders the grip affordance only when withHandle is set", () => {
    const { container: withoutGrip } = render(
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel defaultSize={50}>a</ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={50}>b</ResizablePanel>
      </ResizablePanelGroup>
    )
    expect(withoutGrip.querySelector("svg")).toBeNull()
    cleanup()

    const { container: withGrip } = render(
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel defaultSize={50}>a</ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={50}>b</ResizablePanel>
      </ResizablePanelGroup>
    )
    expect(withGrip.querySelector("svg")).not.toBeNull()
  })
})
