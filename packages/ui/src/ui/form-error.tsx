// megaui:libs/react-shared/ui/form-error.tsx@0ff3a9d
//
// GC-14 / @megaui/i18n error-key wiring: this package cannot depend on
// `@megaui/i18n` directly (no new `package.json` dependency for this
// card), so instead of upstream's `useSharedApp()` app-context coupling this
// component accepts the resolved `code -> message` map as a plain
// `Record<string, string>` prop. That is exactly the shape
// `getTranslation(locale).auth.authErrors` / `.upload.apiErrors` already
// have in `@megaui/i18n` (see `packages/i18n/src/locales/en.ts` and
// `packages/auth/src/create-auth.ts`'s `t.auth.authErrors[code]` lookup),
// so callers wire it with e.g. `errorMessages={t.auth.authErrors}`.
import { TriangleAlertIcon } from "lucide-react"

import { cn } from "../lib/cn"
import { Alert, AlertDescription } from "./alert"
import { Button } from "./button"

/** The one upstream error code this component gives special UI treatment. */
const EMAIL_NOT_VERIFIED_CODE = "EMAIL_NOT_VERIFIED"

export interface FormErrorProps {
  /** Already-resolved fallback message, used when `code` has no entry in `errorMessages`. */
  message?: string
  /** An i18n error key, e.g. an `@megaui/i18n` `auth.authErrors` / `upload.apiErrors` key. */
  code?: string
  /** The i18n error-key -> message dictionary slice to resolve `code` against. */
  errorMessages?: Record<string, string>
  /** Translated label for the resend button (caller-resolved, see module doc). */
  resendLabel?: string
  onResendClick?: () => void
  userEmail?: string
  className?: string
}

export function FormError({
  message,
  code,
  errorMessages,
  resendLabel = "Resend Verification Email",
  onResendClick,
  userEmail,
  className,
}: FormErrorProps) {
  const resolvedMessage = (code ? errorMessages?.[code] : undefined) ?? message

  if (!resolvedMessage) return null

  const showResendButton = code === EMAIL_NOT_VERIFIED_CODE && Boolean(userEmail) && Boolean(onResendClick)

  return (
    <Alert variant="destructive" className={cn("mb-6", className)}>
      <TriangleAlertIcon className="h-4 w-4" />
      <AlertDescription>
        <span>{resolvedMessage}</span>
        {showResendButton && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onResendClick}
            className="mx-auto mt-2"
          >
            {resendLabel}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}
