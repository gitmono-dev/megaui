// megaui-only: locale registry and dictionary lookup.
import { en, zhCN } from "./locales";

/** Supported locales, in the order they are offered to users. */
export const locales = ["en", "zh-CN"] as const;

export type SupportedLocale = (typeof locales)[number];

export const defaultLocale = "en" satisfies SupportedLocale;

/**
 * Name of each locale written in that locale, for language switchers.
 * A locale missing from this table is shown by its code (see `getLocaleLabel`).
 */
export const localeLabels: Record<string, string> = {
  en: "English",
  "zh-CN": "中文",
};

export function getLocaleLabel(locale: string): string {
  return localeLabels[locale] || locale;
}

/**
 * `en` is the source of truth for the dictionary shape. Key parity for the
 * other locales is checked by `locales/parity.test.ts`, not by the compiler.
 */
export type Translations = typeof en;

export const translations = {
  en,
  "zh-CN": zhCN,
} as const;

export function isValidLocale(value: string): value is SupportedLocale {
  return Object.prototype.hasOwnProperty.call(translations, value);
}

export function getTranslation(locale: SupportedLocale): Translations {
  return translations[locale] as Translations;
}
