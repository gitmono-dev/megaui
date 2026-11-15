import { defaultLocale, locales, type SupportedLocale } from "@megaui/i18n";

// megaui-only (WA-01): cookie key mirrors upstream `NEXT_LOCALE`
// (megaui:apps/next-app/middlewares/localeMiddleware.ts@0ff3a9d + config.app.i18n.cookieKey).
// Locale list/default come from `@megaui/i18n` (ADR-ARCH-07).

/** Cookie used for locale preference. */
export const localeCookieKey = "NEXT_LOCALE";

export const i18n = {
  defaultLocale,
  locales,
} as const;

export type { SupportedLocale };
