// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as matchers from "@testing-library/jest-dom/matchers"

import { FormError } from "./form-error"

expect.extend(matchers)
afterEach(() => cleanup())

// Mirrors the shape of `getTranslation(locale).auth.authErrors` in
// `@megaui/i18n` (GC-14 error-key convention) without depending on that
// package.
const AUTH_ERRORS: Record<string, string> = {
  EMAIL_NOT_VERIFIED: "Please verify your email address",
  USER_NOT_FOUND: "No account found with this email",
}

describe("FormError (UI-11, upstream:libs/react-shared/ui/form-error.tsx)", () => {
  it("renders nothing when there is no message and no matching error code", () => {
    const { container } = render(<FormError />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the plain message prop when no code/errorMessages are given (smoke + a11y role)", () => {
    render(<FormError message="Something went wrong" />)
    const alert = screen.getByRole("alert")
    expect(alert).toBeInTheDocument()
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
  })

  it("resolves the message from `code` via the i18n error-key map (GC-14)", () => {
    render(<FormError code="USER_NOT_FOUND" errorMessages={AUTH_ERRORS} />)
    expect(screen.getByText("No account found with this email")).toBeInTheDocument()
  })

  it("falls back to `message` when `code` has no entry in errorMessages", () => {
    render(
      <FormError
        code="SOME_UNMAPPED_CODE"
        message="Unmapped fallback message"
        errorMessages={AUTH_ERRORS}
      />
    )
    expect(screen.getByText("Unmapped fallback message")).toBeInTheDocument()
  })

  it("shows the resend-verification button only for EMAIL_NOT_VERIFIED with an email and handler", async () => {
    const user = userEvent.setup()
    const onResendClick = vi.fn()
    render(
      <FormError
        code="EMAIL_NOT_VERIFIED"
        errorMessages={AUTH_ERRORS}
        userEmail="user@example.com"
        onResendClick={onResendClick}
        resendLabel="Resend Verification Email"
      />
    )

    const button = screen.getByRole("button", { name: "Resend Verification Email" })
    expect(button).toBeInTheDocument()
    await user.click(button)
    expect(onResendClick).toHaveBeenCalledTimes(1)
  })

  it("hides the resend button when userEmail or onResendClick is missing", () => {
    render(<FormError code="EMAIL_NOT_VERIFIED" errorMessages={AUTH_ERRORS} />)
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("hides the resend button for other error codes even with an email and handler", () => {
    render(
      <FormError
        code="USER_NOT_FOUND"
        errorMessages={AUTH_ERRORS}
        userEmail="user@example.com"
        onResendClick={vi.fn()}
      />
    )
    expect(screen.queryByRole("button")).toBeNull()
  })
})
