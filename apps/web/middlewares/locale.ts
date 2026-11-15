// megaui-only: redirects locale-less page URLs to `/{locale}/...`.
//
// The locale is chosen in this order: saved `NEXT_LOCALE` cookie, then the
// browser's Accept-Language header, then the project default. API routes are
// never rewritten (they are locale-free and go straight to the auth step).
import { match as matchLocale } from "@formatjs/intl-localematcher";
import Negotiator from "negotiator";
import { NextResponse, type NextRequest } from "next/server";

import { i18n, localeCookieKey } from "../lib/i18n-config";

const SUPPORTED: readonly string[] = i18n.locales;

function isSupported(value: string | undefined): value is string {
  return value !== undefined && SUPPORTED.includes(value);
}

/** True when the first path segment is already one of the supported locales. */
function hasLocalePrefix(pathname: string): boolean {
  return SUPPORTED.some((locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`));
}

function fromAcceptLanguage(header: string | null): string {
  if (!header) return i18n.defaultLocale;
  const requested = new Negotiator({ headers: { "accept-language": header } }).languages();
  try {
    return matchLocale(requested, [...SUPPORTED], i18n.defaultLocale);
  } catch {
    // `matchLocale` throws on malformed language tags.
    return i18n.defaultLocale;
  }
}

function chooseLocale(request: NextRequest): string {
  const saved = request.cookies.get(localeCookieKey)?.value;
  if (isSupported(saved)) return saved;
  return fromAcceptLanguage(request.headers.get("accept-language"));
}

export function localeMiddleware(request: NextRequest): NextResponse | undefined {
  const { pathname, search } = request.nextUrl;

  if (pathname.toLowerCase().startsWith("/api/")) return undefined;
  if (hasLocalePrefix(pathname)) return undefined;

  const prefixed = `/${chooseLocale(request)}${pathname.startsWith("/") ? "" : "/"}${pathname}${search}`;
  return NextResponse.redirect(new URL(prefixed, request.url), 302);
}
