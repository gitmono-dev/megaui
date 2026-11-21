// megaui-only (FSL-129): the Feishu email-code sign-in page, `/[lang]/signin/feishu`.
//
// A server component: the page exists only in Feishu mode (AUTH_MODE=enterprise,
// AUTH_PROVIDER=feishu, the same `resolveWebSessionEntry` decision as the middleware) and
// is a 404 otherwise. Both steps (email, then code) run inside one client component tree,
// so the sign-in email lives only in component state; a reload starts at the email step.
import { getTranslation, isValidLocale } from "@megaui/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@megaui/ui";
import { notFound } from "next/navigation";

import { EmailForm } from "@/components/feishu-login/email-form";
import { resolveWebSessionEntry } from "@/lib/enterprise-session";

/** Request-time: the mode comes from the runtime environment, never from the build. */
export const dynamic = "force-dynamic";

export default async function FeishuSigninPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isValidLocale(lang) || resolveWebSessionEntry() !== "feishu") notFound();
  const copy = getTranslation(lang).auth.signin.feishu;

  return (
    <Card data-testid="feishu-login-card">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <EmailForm />
      </CardContent>
    </Card>
  );
}
