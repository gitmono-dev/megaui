import { getTranslation, isValidLocale } from "@megaui/i18n";
import { Button } from "@megaui/ui";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { resolveWebActor } from "@/lib/enterprise-session";
import { getSiteName } from "@/lib/site-name";

// megaui-only (WA-01 / ADR-ARCH-09): session-aware single CTA homepage.
// Not a port of upstream SaaS marketing `app/[lang]/(root)/page.tsx`.

/** Always request-time: session CTA must not be frozen into the Docker image. */
export const dynamic = "force-dynamic";

/**
 * ADR-ARCH-09 homepage: session-aware single CTA, no marketing content.
 */
export default async function HomePage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!isValidLocale(lang)) {
    notFound();
  }

  // Opt into dynamic rendering before auth/env may throw (Docker build has
  // no secrets; catching getAuth must not leave a static guest shell).
  const requestHeaders = await headers();

  const t = getTranslation(lang);
  let signedIn = false;
  try {
    signedIn = Boolean(await resolveWebActor(requestHeaders));
  } catch {
    // Fail closed to guest CTA if session lookup fails (e.g. DB down).
  }

  const href = signedIn ? `/${lang}/workspace` : `/${lang}/signin`;
  const label = signedIn ? t.home.enterWorkspace : t.home.login;

  return (
    <main data-mega-surface="landing" className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">{getSiteName()}</h1>
      <Button asChild size="lg" data-testid="home-cta">
        <Link href={href}>{label}</Link>
      </Button>
    </main>
  );
}
