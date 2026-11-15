"use client"

// megaui:libs/react-shared/ui/social-button.tsx@0ff3a9d
//
// Diffs from upstream:
// - Provider set cut to `google | github | apple`. Upstream also had two
//   more providers for phone-number and QR-code chat-app sign-in, but
//   those login channels are a permanent non-goal (see plan "永久非目标")
//   and `@megaui/i18n`'s `auth.signin.socialProviders` already only
//   carries google/github/apple.
// - Icons come from this package's own `../icons` (ported in UI-01) instead
//   of upstream's raw `.svg` file imports.
// - The translated button label is a required prop instead of being read
//   from upstream's `useSharedApp()` app-context hook, which this package
//   does not own — callers resolve it via `@megaui/i18n` themselves
//   (GC-14), keeping this component self-contained.
import * as React from "react"
import { Loader2 } from "lucide-react"

import { cn } from "../lib/cn"
import { AppleIcon, GithubIcon, GoogleIcon } from "../icons"
import { Button } from "./button"

export type SocialProvider = "google" | "github" | "apple"

const PROVIDER_ICONS: Record<SocialProvider, React.ComponentType<{ className?: string }>> = {
  google: GoogleIcon,
  github: GithubIcon,
  apple: AppleIcon,
}

export interface SocialButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  provider: SocialProvider
  label: string
  loading?: boolean
}

export function SocialButton({
  provider,
  label,
  className,
  loading,
  disabled,
  ...props
}: SocialButtonProps) {
  const Icon = PROVIDER_ICONS[provider]

  return (
    <Button
      type="button"
      variant="outline"
      className={cn(
        "w-full bg-background hover:bg-accent hover:text-accent-foreground",
        className
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : (
        <Icon className="mr-2 h-4 w-4" />
      )}
      {label}
    </Button>
  )
}
