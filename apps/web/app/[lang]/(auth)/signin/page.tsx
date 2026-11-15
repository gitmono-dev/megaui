// megaui-only: sign-in page (server component).
//
// Rendering on the server lets the OAuth provider list come from request-time
// environment variables and keeps the full translation catalogue out of the
// client bundle. In enterprise mode only the Feishu pairing form is offered,
// so social buttons are hidden there.
import { resolveSocialProvidersFromEnv } from "@megaui/auth";
import { getTranslation, isValidLocale } from "@megaui/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, type SocialProvider } from "@megaui/ui";

import { LegalNotice, SocialSection } from "@/components/auth-card-parts";
import { LoginForm } from "@/components/login-form";

function enabledSocialProviders(): SocialProvider[] {
  const configured = resolveSocialProvidersFromEnv();
  const providers: SocialProvider[] = [];
  if (configured.google) providers.push("google");
  if (configured.github) providers.push("github");
  return providers;
}

export default async function SigninPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const t = getTranslation(isValidLocale(lang) ? lang : "en");
  const copy = t.auth.signin;
  const enterprise = process.env.AUTH_MODE?.trim() === "enterprise";

  const heading = enterprise ? copy.enterprise.title : copy.welcomeBack;
  const subheading = enterprise ? copy.enterprise.description : copy.socialLogin;

  return (
    <Card data-testid="signin-card">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{heading}</CardTitle>
        <CardDescription>{subheading}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <SocialSection providers={enterprise ? [] : enabledSocialProviders()} dividerLabel={copy.continueWith} />
        <LoginForm enterprise={enterprise} />
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
