// megaui:libs/auth/auth.ts@0ff3a9d (getRefererInfo slice)
//
// Diff vs upstream (GC-03, registered on the PK-06 task card): extracted to
// its own module for unit testing; uses `@megaui/i18n` defaultLocale/locales
// instead of `@libs/i18n`.

import { defaultLocale, locales, type SupportedLocale } from "@megaui/i18n";

export interface RefererInfo {
  locale: SupportedLocale;
  lastSegment: string;
}

/**
 * Extract locale (first path segment if supported) and last path segment
 * from a request Referer URL. Falls back to `defaultLocale` when absent
 * or unparseable.
 */
export function getRefererInfo(request?: Request): RefererInfo {
  const referer = request?.headers?.get("referer");
  if (!referer) return { locale: defaultLocale, lastSegment: "" };

  try {
    const url = new URL(referer);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const localeCandidate = pathParts[0];
    const lastSegment = pathParts[pathParts.length - 1] || "";
    const locale =
      localeCandidate && (locales as readonly string[]).includes(localeCandidate)
        ? (localeCandidate as SupportedLocale)
        : defaultLocale;
    return { locale, lastSegment };
  } catch {
    return { locale: defaultLocale, lastSegment: "" };
  }
}
