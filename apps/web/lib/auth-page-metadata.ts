// megaui-only: builds the `generateMetadata` export for the auth route layouts.
import { getTranslation, isValidLocale, type Translations } from "@megaui/i18n";
import type { Metadata } from "next";

type AuthPage = keyof Translations["auth"]["metadata"];

type LayoutParams = { params: Promise<{ lang: string }> };

/**
 * Returns a `generateMetadata` function that reads title, description and
 * keywords for `page` from the visitor's locale (falling back to English for
 * an unknown locale segment).
 */
export function authPageMetadata(page: AuthPage) {
  return async function generateMetadata({ params }: LayoutParams): Promise<Metadata> {
    const { lang } = await params;
    const { title, description, keywords } = getTranslation(isValidLocale(lang) ? lang : "en").auth.metadata[page];
    return { title, description, keywords };
  };
}
