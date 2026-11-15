import { defaultLocale, translations, type SupportedLocale } from "@megaui/i18n";

/** Own-property locale check — avoids prototype keys like `toString`/`constructor`. */
export function resolveLocale(locale: string | undefined): SupportedLocale {
  if (
    locale !== undefined &&
    Object.prototype.hasOwnProperty.call(translations, locale)
  ) {
    return locale as SupportedLocale;
  }
  return defaultLocale;
}
