// @vitest-environment happy-dom
// Composition test for megaui:apps/next-app/app/lang/workspace/workspace-shell-client.tsx@0ff3a9d's
// port (upstream's folder is the Next.js dynamic route segment `[lang]`):
// wires SessionGuard around WorkspaceShell + WorkspaceCommandPalette (UI-05 AC3 integration).
import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { en } from "@megaui/i18n"

import { MEGA_COMMAND_OPEN_EVENT } from "./nav-config"
import { workspaceSigninHref } from "./session-guard"
import { WorkspaceShellClient } from "./workspace-shell-client"
import type { WorkspaceCommandPaletteLabels } from "./command-palette"

afterEach(() => {
  cleanup()
})

const paletteLabels: WorkspaceCommandPaletteLabels = {
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

const sessionGuardLabels = { redirecting: en.auth.authErrors.SESSION_EXPIRED }

function baseProps() {
  return {
    children: <main data-testid="workspace-content">Content</main>,
    isAuthenticated: true,
    onNavigate: vi.fn(),
    onRedirect: vi.fn(),
    paletteLabels,
    rail: <aside data-testid="rail">Rail</aside>,
    sessionGuardLabels,
    signinHref: workspaceSigninHref("en"),
    useSearchResults: () => ({ state: "idle" as const }),
    workspaceBase: "/en/workspace",
  }
}

describe("WorkspaceShellClient (UI-05 AC3 composition)", () => {
  it("renders the rail + content behind the guard when authenticated, and never redirects", () => {
    const onRedirect = vi.fn()
    render(<WorkspaceShellClient {...baseProps()} onRedirect={onRedirect} />)

    expect(screen.getByTestId("rail")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-content")).toBeInTheDocument()
    expect(onRedirect).not.toHaveBeenCalled()
  })

  it("hides the rail/content and redirects to signinHref when unauthenticated", () => {
    const onRedirect = vi.fn()
    render(<WorkspaceShellClient {...baseProps()} isAuthenticated={false} onRedirect={onRedirect} />)

    expect(screen.queryByTestId("rail")).not.toBeInTheDocument()
    expect(screen.queryByTestId("workspace-content")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent(en.auth.authErrors.SESSION_EXPIRED)
    expect(onRedirect).toHaveBeenCalledWith("/en/signin")
  })

  it("mounts the command palette alongside the guarded shell, openable via the mega:command-open event", async () => {
    render(<WorkspaceShellClient {...baseProps()} />)

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    fireEvent(window, new Event(MEGA_COMMAND_OPEN_EVENT))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: paletteLabels.title })).toBeInTheDocument()
  })
})
