// megaui:apps/next-app/components/social-auth.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-02):
// - `providers` prop is required (no default); the parent RSC page resolves
//   `resolveSocialProvidersFromEnv()` and passes only the active provider
//   IDs, so this component is never rendered with stale env assumptions.
// - Providers are `"google" | "github"` only (apple/wechat/phone removed;
//   ADR-ARCH-04 + permanent non-goal).
// - `SocialButton` requires a `label` prop — resolved via `useTranslation()`
//   against `auth.signin.socialProviders` instead of upstream's
//   `useSharedApp()` context.
// - Error surfaced via local state (no `sonner` toast dependency added to
//   apps/web — avoids lockfile churn for WA-02).
// - `loadingProvider` type narrowed to `SocialProvider | null` (no
//   wechat/phone branches).

"use client";

import { useState } from "react";

import { SocialButton, type SocialProvider } from "@megaui/ui";

import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";
import { resolvePostAuthPath } from "@/lib/post-auth-redirect";

interface SocialAuthProps {
  /** Active OAuth providers resolved server-side via resolveSocialProvidersFromEnv(). */
  providers: SocialProvider[];
}

export function SocialAuth({ providers }: SocialAuthProps) {
  const { t, locale } = useTranslation();
  const [loadingProvider, setLoadingProvider] = useState<SocialProvider | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (providers.length === 0) return null;

  const handleClick = async (provider: SocialProvider) => {
    if (loadingProvider) return;
    setLoadingProvider(provider);
    setErrorMessage(null);

    try {
      const params = new URLSearchParams(window.location.search);
      const path = resolvePostAuthPath(params, locale);
      const callbackURL = `${window.location.origin}${path}`;

      const { error } = await authClient.signIn.social({ provider, callbackURL });
      if (error) {
        setErrorMessage(error.message ?? t.common.unexpectedError);
      }
    } catch {
      setErrorMessage(t.common.unexpectedError);
    } finally {
      setLoadingProvider(null);
    }
  };

  const labels: Record<SocialProvider, string> = {
    google: t.auth.signin.socialProviders.google,
    github: t.auth.signin.socialProviders.github,
    apple: t.auth.signin.socialProviders.apple,
  };

  return (
    <div className="flex flex-col gap-3">
      {errorMessage && (
        <p className="text-destructive text-xs text-center">{errorMessage}</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        {providers.map((provider) => (
          <SocialButton
            key={provider}
            provider={provider}
            label={labels[provider]}
            loading={loadingProvider === provider}
            disabled={
              loadingProvider !== null && loadingProvider !== provider
            }
            onClick={() => handleClick(provider)}
          />
        ))}
      </div>
    </div>
  );
}
