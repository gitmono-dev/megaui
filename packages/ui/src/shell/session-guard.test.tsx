// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { en, zhCN } from "@megaui/i18n"

import { SessionGuard, workspaceSigninHref } from "./session-guard"

afterEach(() => {
  cleanup()
})

describe("SessionGuard (UI-05 AC3: unauthenticated -> redirect /{lang}/signin)", () => {
  it("computes the /{lang}/signin redirect target", () => {
    expect(workspaceSigninHref("en")).toBe("/en/signin")
    expect(workspaceSigninHref("zh-CN")).toBe("/zh-CN/signin")
  })

  it("renders the i18n hint and invokes onRedirect with /{lang}/signin when unauthenticated", () => {
    const onRedirect = vi.fn()
    render(
      <SessionGuard
        isAuthenticated={false}
        labels={{ redirecting: en.auth.authErrors.SESSION_EXPIRED }}
        onRedirect={onRedirect}
        signinHref={workspaceSigninHref("en")}
      >
        <main>Workspace content</main>
      </SessionGuard>,
    )

    expect(onRedirect).toHaveBeenCalledTimes(1)
    expect(onRedirect).toHaveBeenCalledWith("/en/signin")
    expect(screen.getByRole("status")).toHaveTextContent(en.auth.authErrors.SESSION_EXPIRED)
    expect(screen.queryByText("Workspace content")).not.toBeInTheDocument()
  })

  it("renders children and never redirects when authenticated", () => {
    const onRedirect = vi.fn()
    render(
      <SessionGuard
        isAuthenticated
        labels={{ redirecting: zhCN.auth.authErrors.SESSION_EXPIRED }}
        onRedirect={onRedirect}
        signinHref={workspaceSigninHref("zh-CN")}
      >
        <main>Workspace content</main>
      </SessionGuard>,
    )

    expect(onRedirect).not.toHaveBeenCalled()
    expect(screen.getByText("Workspace content")).toBeInTheDocument()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("redirects only once per unauthenticated mount (does not loop on re-render)", () => {
    const onRedirect = vi.fn()
    const { rerender } = render(
      <SessionGuard
        isAuthenticated={false}
        labels={{ redirecting: en.auth.authErrors.SESSION_EXPIRED }}
        onRedirect={onRedirect}
        signinHref="/en/signin"
      >
        <main>Workspace content</main>
      </SessionGuard>,
    )
    rerender(
      <SessionGuard
        isAuthenticated={false}
        labels={{ redirecting: en.auth.authErrors.SESSION_EXPIRED }}
        onRedirect={onRedirect}
        signinHref="/en/signin"
      >
        <main>Workspace content</main>
      </SessionGuard>,
    )

    expect(onRedirect).toHaveBeenCalledTimes(1)
  })

  it("keeps English and Chinese SESSION_EXPIRED copy non-empty (the guard's i18n hint key)", () => {
    expect(en.auth.authErrors.SESSION_EXPIRED.trim().length).toBeGreaterThan(0)
    expect(zhCN.auth.authErrors.SESSION_EXPIRED.trim().length).toBeGreaterThan(0)
  })
})
