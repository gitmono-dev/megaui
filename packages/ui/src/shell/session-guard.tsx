/**
 * Workspace session guard (UI-05 AC3).
 *
 * New to megaui (no upstream source file to port): upstream's route protection is a
 * server-side Next middleware (`REF-01`'s fail-closed protection table is
 * `apps/web`'s `WA-01` card, not a shell component). `packages/ui` may
 * only depend on `core`/`content`/`i18n` (`.dependency-cruiser.cjs`
 * `ui-restricted-deps`) and must not import `@megaui/auth`, so this
 * component takes the session outcome as plain props — the consuming app
 * decides *how* it learns `isAuthenticated` (server session lookup,
 * `@megaui/auth`'s client hook, etc.) and *how* it redirects
 * (`next/navigation`'s `router.replace`, a `<meta refresh>`, ...); this
 * component only renders the gated state and invokes `onRedirect` once.
 */
"use client"

import { useEffect, useRef, type ReactNode } from "react"

export interface SessionGuardLabels {
  /**
   * Rendered (and announced via `role="status"`) while an unauthenticated
   * visitor is being redirected to sign in. Callers pass an i18n string —
   * e.g. `@megaui/i18n`'s `auth.authErrors.SESSION_EXPIRED`.
   */
  redirecting: string
}

export interface SessionGuardProps {
  children: ReactNode
  isAuthenticated: boolean
  labels: SessionGuardLabels
  /** Invoked with `signinHref` exactly once per unauthenticated mount/transition. */
  onRedirect(href: string): void
  signinHref: string
}

/** `/{lang}/signin` — the redirect target shape used across the workspace. */
export function workspaceSigninHref(locale: string): string {
  return `/${locale}/signin`
}

export function SessionGuard({ children, isAuthenticated, labels, onRedirect, signinHref }: SessionGuardProps) {
  const lastRedirected = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (isAuthenticated) {
      lastRedirected.current = undefined
      return
    }
    if (lastRedirected.current === signinHref) return
    lastRedirected.current = signinHref
    onRedirect(signinHref)
  }, [isAuthenticated, onRedirect, signinHref])

  if (!isAuthenticated) {
    return (
      <p aria-live="polite" data-mega-shell="session-guard-redirect" role="status">
        {labels.redirecting}
      </p>
    )
  }

  return <>{children}</>
}
