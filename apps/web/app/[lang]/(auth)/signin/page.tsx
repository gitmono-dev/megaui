// megaui-only: sign-in page (server component).
//
// Rendering on the server lets the OAuth provider list come from request-time
// environment variables and keeps the full translation catalogue out of the
// client bundle. FSL-132: the old enterprise pairing form is gone; outside Feishu
// mode the page is the email and password form with the configured social buttons.
//
// FSL-131: in Feishu mode (`resolveWebSessionEntry() === "feishu"`, the same decision as the
// middleware and the Feishu page) this page renders nothing and answers 307 to
// `/[lang]/signin/feishu` with the same query parameters (keys and values, re-serialised),
// so the middleware's guest redirect to `/[lang]/signin` lands on the Feishu page as well.
// Every other mode renders the email and password form.
import { resolveSocialProvidersFromEnv } from "@megaui/auth";
import { getTranslation, isValidLocale } from "@megaui/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, type SocialProvider } from "@megaui/ui";
import { redirect } from "next/navigation";

import { LegalNotice, SocialSection } from "@/components/auth-card-parts";
import { LoginForm } from "@/components/login-form";
import { resolveWebSessionEntry } from "@/lib/enterprise-session";

/** Request-time: the mode comes from the runtime environment, never from the build. */
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

/** The Feishu sign-in path for `lang`, carrying every query parameter's key and values. */
function feishuSigninPath(lang: string, searchParams: SearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  const search = query.toString();
  return `/${lang}/signin/feishu${search ? `?${search}` : ""}`;
}

function enabledSocialProviders(): SocialProvider[] {
  const configured = resolveSocialProvidersFromEnv();
  const providers: SocialProvider[] = [];
  if (configured.google) providers.push("google");
  if (configured.github) providers.push("github");
  return providers;
}

export default async function SigninPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { lang } = await params;
  if (isValidLocale(lang) && resolveWebSessionEntry() === "feishu") {
    redirect(feishuSigninPath(lang, await searchParams));
  }
  const t = getTranslation(isValidLocale(lang) ? lang : "en");
  const copy = t.auth.signin;

  return (
    <Card data-testid="signin-card">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{copy.welcomeBack}</CardTitle>
        <CardDescription>{copy.socialLogin}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <SocialSection providers={enabledSocialProviders()} dividerLabel={copy.continueWith} />
        <LoginForm />
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
