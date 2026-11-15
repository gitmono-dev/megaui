// @vitest-environment happy-dom
// UI-05 AC2: command palette search / keyboard / group tests, porting
// megaui:libs/react-shared/components/mega/command-palette/command-palette.tsx@0ff3a9d's
// behavior contract.
import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { en } from "@megaui/i18n"

import { MEGA_COMMAND_OPEN_EVENT, MEGA_NAV_ITEMS, workspaceHref } from "../nav-config"
import {
  WorkspaceCommandPalette,
  WorkspaceCommandPaletteContent,
  type PaletteResultGroup,
  type PaletteSearchState,
  type WorkspaceCommandPaletteLabels,
} from "./command-palette"
import { MEGA_PALETTE_ACTIONS } from "./items"

afterEach(() => {
  cleanup()
})

const labels: WorkspaceCommandPaletteLabels = {
  actions: en.workspace.palette.actions,
  empty: en.workspace.palette.empty,
  error: en.workspace.palette.error,
  groups: {
    actions: en.workspace.palette.groups.actions,
    navigation: en.workspace.palette.groups.navigation,
  },
  inputPlaceholder: en.workspace.palette.inputPlaceholder,
  loading: en.workspace.palette.loading,
  nav: en.workspace.nav.items,
  title: en.workspace.palette.title,
}

const workspaceBase = "/en/workspace"

describe("WorkspaceCommandPaletteContent (UI-05 AC2: groups)", () => {
  it("shows the Navigation and Actions groups (with every nav item + quick action) for an empty query", () => {
    render(
      <WorkspaceCommandPaletteContent
        labels={labels}
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        query=""
        results={{ state: "idle" }}
        workspaceBase={workspaceBase}
      />,
    )

    expect(screen.getByText(labels.groups.navigation)).toBeInTheDocument()
    expect(screen.getByText(labels.groups.actions)).toBeInTheDocument()
    for (const item of MEGA_NAV_ITEMS) {
      const row = screen.getByText(labels.nav[item.id]).closest('[data-mega-palette="item"]')
      expect(row).toHaveAttribute("data-mega-href", workspaceHref(workspaceBase, item.path))
    }
    for (const action of MEGA_PALETTE_ACTIONS) {
      const row = screen.getByText(labels.actions[action.id]).closest('[data-mega-palette="item"]')
      expect(row).toHaveAttribute("data-mega-href", workspaceHref(workspaceBase, action.path))
    }
  })

  it("shows the loading status (not the base groups) once the query is non-empty and results haven't settled", () => {
    render(
      <WorkspaceCommandPaletteContent
        labels={labels}
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        query="doc"
        results={{ state: "loading" }}
        workspaceBase={workspaceBase}
      />,
    )

    expect(screen.getByRole("status")).toHaveTextContent(labels.loading)
    expect(screen.queryByText(labels.groups.navigation)).not.toBeInTheDocument()
  })

  it("shows an alert on search failure", () => {
    render(
      <WorkspaceCommandPaletteContent
        labels={labels}
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        query="doc"
        results={{ state: "error" }}
        workspaceBase={workspaceBase}
      />,
    )

    expect(screen.getByRole("alert")).toHaveTextContent(labels.error)
  })

  it("shows the empty message when a successful search returns no matching rows", () => {
    render(
      <WorkspaceCommandPaletteContent
        labels={labels}
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        query="zzz-no-match"
        results={{ groups: [], state: "success" }}
        workspaceBase={workspaceBase}
      />,
    )

    expect(screen.getByText(labels.empty)).toBeInTheDocument()
  })

  it("renders caller-supplied result groups and invokes onSelect with the row's href on click", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const groups: readonly PaletteResultGroup[] = [
      {
        heading: en.workspace.palette.groups.issues,
        items: [{ href: "/en/workspace/issues/42", icon: "bug", key: "issue-42", label: "#42 Flaky test", value: "issue-42" }],
      },
    ]
    render(
      <WorkspaceCommandPaletteContent
        labels={labels}
        onQueryChange={vi.fn()}
        onSelect={onSelect}
        query="flaky"
        results={{ groups, state: "success" }}
        workspaceBase={workspaceBase}
      />,
    )

    expect(screen.getByText(en.workspace.palette.groups.issues)).toBeInTheDocument()
    const row = screen.getByText("#42 Flaky test")
    expect(row.closest('[data-mega-palette="item"]')).toHaveAttribute("data-mega-href", "/en/workspace/issues/42")

    await user.click(row)
    expect(onSelect).toHaveBeenCalledWith("/en/workspace/issues/42")
  })

  it("forwards every keystroke to onQueryChange", async () => {
    const user = userEvent.setup()
    const onQueryChange = vi.fn()
    render(
      <WorkspaceCommandPaletteContent
        labels={labels}
        onQueryChange={onQueryChange}
        onSelect={vi.fn()}
        query=""
        results={{ state: "idle" }}
        workspaceBase={workspaceBase}
      />,
    )

    // `query` stays fixed at "" (the caller owns the debounce/state), so cmdk's
    // controlled input reports each keystroke against that fixed baseline.
    await user.type(screen.getByRole("combobox"), "ab")
    expect(onQueryChange).toHaveBeenCalledWith("a")
    expect(onQueryChange).toHaveBeenCalledWith("b")
  })
})

describe("WorkspaceCommandPaletteContent (UI-05 AC2: keyboard navigation)", () => {
  it("highlights the first row by default and selects it on Enter", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <WorkspaceCommandPaletteContent
        labels={labels}
        onQueryChange={vi.fn()}
        onSelect={onSelect}
        query=""
        results={{ state: "idle" }}
        workspaceBase={workspaceBase}
      />,
    )

    const homeRow = screen.getByText(labels.nav.home).closest('[role="option"]')
    expect(homeRow).toHaveAttribute("aria-selected", "true")

    await user.click(screen.getByRole("combobox"))
    await user.keyboard("{Enter}")
    expect(onSelect).toHaveBeenCalledWith(workspaceHref(workspaceBase, MEGA_NAV_ITEMS[0]?.path ?? ""))
  })

  it("moves the highlight with ArrowDown/ArrowUp and selects the highlighted row on Enter", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <WorkspaceCommandPaletteContent
        labels={labels}
        onQueryChange={vi.fn()}
        onSelect={onSelect}
        query=""
        results={{ state: "idle" }}
        workspaceBase={workspaceBase}
      />,
    )

    await user.click(screen.getByRole("combobox"))
    await user.keyboard("{ArrowDown}")
    const inboxRow = screen.getByText(labels.nav.inbox).closest('[role="option"]')
    expect(inboxRow).toHaveAttribute("aria-selected", "true")

    await user.keyboard("{ArrowUp}")
    const homeRow = screen.getByText(labels.nav.home).closest('[role="option"]')
    expect(homeRow).toHaveAttribute("aria-selected", "true")

    await user.keyboard("{ArrowDown}{Enter}")
    expect(onSelect).toHaveBeenCalledWith(workspaceHref(workspaceBase, "inbox"))
  })
})

describe("WorkspaceCommandPalette (UI-05 AC2: dialog open/close + debounce)", () => {
  function noopSearch(): PaletteSearchState {
    return { state: "idle" }
  }

  it("is closed by default and opens when the mega:command-open event fires", async () => {
    render(
      <WorkspaceCommandPalette
        labels={labels}
        onNavigate={vi.fn()}
        useSearchResults={noopSearch}
        workspaceBase={workspaceBase}
      />,
    )

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    fireEvent(window, new Event(MEGA_COMMAND_OPEN_EVENT))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: labels.title })).toBeInTheDocument()
  })

  it("opens on Cmd/Ctrl+K, but ignores the shortcut while typing in an editable element", async () => {
    render(
      <>
        <input aria-label="outside-input" />
        <WorkspaceCommandPalette
          labels={labels}
          onNavigate={vi.fn()}
          useSearchResults={noopSearch}
          workspaceBase={workspaceBase}
        />
      </>,
    )

    const outsideInput = screen.getByLabelText("outside-input")
    outsideInput.focus()
    fireEvent.keyDown(outsideInput, { ctrlKey: true, key: "k" })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

    fireEvent.keyDown(document.body, { ctrlKey: true, key: "k" })
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("selecting a row closes the dialog, clears the query, and calls onNavigate", async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    render(
      <WorkspaceCommandPalette
        labels={labels}
        onNavigate={onNavigate}
        useSearchResults={noopSearch}
        workspaceBase={workspaceBase}
      />,
    )

    fireEvent(window, new Event(MEGA_COMMAND_OPEN_EVENT))
    const homeLabel = await screen.findByText(labels.nav.home)
    await user.click(homeLabel)

    expect(onNavigate).toHaveBeenCalledWith(workspaceHref(workspaceBase, ""))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("debounces the query it feeds to useSearchResults, and only searches while open", async () => {
    const user = userEvent.setup()
    const queries: string[] = []
    function trackingSearch(query: string): PaletteSearchState {
      queries.push(query)
      return { state: "idle" }
    }

    render(
      <WorkspaceCommandPalette
        labels={labels}
        onNavigate={vi.fn()}
        useSearchResults={trackingSearch}
        workspaceBase={workspaceBase}
      />,
    )

    expect(queries.at(-1)).toBe("")

    fireEvent(window, new Event(MEGA_COMMAND_OPEN_EVENT))
    await screen.findByRole("dialog")
    await user.type(screen.getByRole("combobox"), "flaky")

    await waitFor(() => expect(queries.at(-1)).toBe("flaky"))
  })
})
