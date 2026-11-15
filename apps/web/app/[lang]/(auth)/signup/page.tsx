// megaui-only: sign-up page (server component).
//
// Mirrors the sign-in page: the OAuth provider list is resolved per request on
// the server and only the card chrome is translated here; the form itself is a
// client component.
import { resolveSocialProvidersFromEnv } from "@megaui/auth";
import { getTranslation, isValidLocale } from "@megaui/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, type SocialProvider } from "@megaui/ui";

import { LegalNotice, SocialSection } from "@/components/auth-card-parts";
import { SignupForm } from "@/components/signup-form";

function enabledSocialProviders(): SocialProvider[] {
  const configured = resolveSocialProvidersFromEnv();
  const providers: SocialProvider[] = [];
  if (configured.google) providers.push("google");
  if (configured.github) providers.push("github");
  return providers;
}

export default async function SignupPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const t = getTranslation(isValidLocale(lang) ? lang : "en");
  const copy = t.auth.signup;

  return (
    <Card data-testid="signup-card">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{copy.createAccount}</CardTitle>
        <CardDescription>{copy.socialSignup}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <SocialSection providers={enabledSocialProviders()} dividerLabel={copy.continueWith} />
        <SignupForm />
        <LegalNotice
          lead={copy.termsNotice}
          and={t.common.and}
          termsLabel={copy.termsOfService}
          privacyLabel={copy.privacyPolicy}
        />
      </CardContent>
    </Card>
  );
}
