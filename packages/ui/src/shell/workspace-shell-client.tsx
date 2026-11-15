/**
 * megaui:apps/next-app/app/lang/workspace/workspace-shell-client.tsx@0ff3a9d
 * (upstream's actual folder is the Next.js dynamic route segment `[lang]`,
 * elided above to keep this line in the repo's plain provenance form)
 *
 * Diff vs upstream (GC-03): upstream's `WorkspaceShellClient` reaches into
 * `next/navigation`, `@tanstack/react-query`, and
 * `@libs/auth/authClient` directly. None of `next`/`@megaui/auth` are
 * reachable from `packages/ui` (not a dependency; `ui-restricted-deps`
 * forbids `auth` outright — see `.dependency-cruiser.cjs`), so this port
 * takes the fully-built `rail` element and every session/navigation
 * concern as props — the composition only wires `SessionGuard` around
 * `WorkspaceShell` + `WorkspaceCommandPalette`. Data-fetching
 * (notifications/channels/CL counts/search) is the consuming app's job
 * (`WA-03`/`WA-07`), built on `../query` (`UI-04`).
 */
"use client"

import type { ReactElement, ReactNode } from "react"

import type { WorkspaceCommandPaletteLabels, PaletteSearchState } from "./command-palette"
import { WorkspaceCommandPalette } from "./command-palette"
import { SessionGuard, type SessionGuardLabels } from "./session-guard"
import { WorkspaceShell } from "./workspace-shell"

export interface WorkspaceShellClientProps {
  children: ReactNode
  isAuthenticated: boolean
  onNavigate(href: string): void
  onRedirect(href: string): void
  paletteLabels: WorkspaceCommandPaletteLabels
  /** Fully-built `<WorkspaceRail .../>` — the caller owns its data wiring. */
  rail: ReactElement
  sessionGuardLabels: SessionGuardLabels
  signinHref: string
  useSearchResults(query: string): PaletteSearchState
  workspaceBase: string
}

export function WorkspaceShellClient({
  children,
  isAuthenticated,
  onNavigate,
  onRedirect,
  paletteLabels,
  rail,
  sessionGuardLabels,
  signinHref,
  useSearchResults,
  workspaceBase,
}: WorkspaceShellClientProps) {
  return (
    <SessionGuard
      isAuthenticated={isAuthenticated}
      labels={sessionGuardLabels}
      onRedirect={onRedirect}
      signinHref={signinHref}
    >
      <WorkspaceShell rail={rail}>{children}</WorkspaceShell>
      <WorkspaceCommandPalette
        labels={paletteLabels}
        onNavigate={onNavigate}
        useSearchResults={useSearchResults}
        workspaceBase={workspaceBase}
      />
    </SessionGuard>
  )
}
