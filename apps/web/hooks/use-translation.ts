// megaui:apps/next-app/hooks/use-translation.ts@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-02):
// - Simplified surface: only `{ t, locale }` — no `tWithParams`,
//   `changeLocale`, `locales`, `defaultLocale`, `isDefaultLocale`.
//   Those were pulled from `@config` and `@libs/validators` which do
//   not exist in megaui; callers that need them can import directly
//   from `@megaui/i18n`.
// - `getTranslation` used directly (no `translations[locale]` indexing)
//   which is the megaui-idiomatic call (GC-02).

"use client";

import { useParams } from "next/navigation";

import {
  defaultLocale,
  getTranslation,
  isValidLocale,
  type SupportedLocale,
  type Translations,
} from "@megaui/i18n";

export function useTranslation(): { t: Translations; locale: SupportedLocale } {
  const params = useParams();
  const lang = (params?.lang as string) ?? defaultLocale;
  const locale: SupportedLocale = isValidLocale(lang)
    ? lang
    : (defaultLocale as SupportedLocale);
  const t: Translations = getTranslation(locale);
  return { t, locale };
}
