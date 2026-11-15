// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { WorkspaceShell } from "./workspace-shell"

afterEach(() => {
  cleanup()
})

describe("WorkspaceShell (megaui:libs/react-shared/components/mega/shell/workspace-shell.tsx@0ff3a9d)", () => {
  it("renders the rail and the content side by side, filling the viewport", () => {
    render(
      <WorkspaceShell rail={<aside data-testid="rail">Rail</aside>}>
        <main data-testid="content">Content</main>
      </WorkspaceShell>,
    )

    expect(screen.getByTestId("rail")).toBeInTheDocument()
    expect(screen.getByTestId("content")).toBeInTheDocument()
    const shell = screen.getByTestId("content").closest('[data-mega-shell="workspace"]')
    expect(shell).toHaveStyle({ height: "100dvh" })
  })
})
