// megaui-only: root layout for every `/{lang}/...` route.
//
// Rejects unknown locale segments with a 404, renders the `<html lang>` shell,
// and installs the blocking theme script. Metadata comes from the dictionary's
// `home.metadata` entry.
import { getTranslation, isValidLocale } from "@megaui/i18n";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ThemeScript } from "@/components/theme-script";
import { i18n } from "@/lib/i18n-config";
import { applySiteName, getSiteName } from "@/lib/site-name";

type LangParams = { params: Promise<{ lang: string }> };

export function generateStaticParams() {
  return i18n.locales.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: LangParams): Promise<Metadata> {
  const { lang } = await params;
  if (!isValidLocale(lang)) return { title: getSiteName() };

  const { title, description } = getTranslation(lang).home.metadata;
  return { title: applySiteName(title), description: applySiteName(description) };
}

export default async function LangLayout({ children, params }: LangParams & { children: ReactNode }) {
  const { lang } = await params;
  if (!isValidLocale(lang)) notFound();

  return (
    <html lang={lang} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className={`${GeistSans.className} antialiased`}>{children}</body>
    </html>
  );
}
