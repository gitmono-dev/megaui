// megaui:libs/i18n/resolve-api-locale.ts@0ff3a9d
//
// Ported behavior-verbatim, split into a pure `Accept-Language`-string
// parser (`resolveApiLocaleFromAcceptLanguage`, easy to unit test) and a
// thin `Request`-shaped wrapper. The wrapper is typed structurally
// (`ApiLocaleRequestLike`) instead of the DOM `Request` type so this
// package stays usable from any runtime (Node, edge, workers) without
// requiring the `DOM` lib in `tsconfig`.
import { defaultLocale, isValidLocale, type SupportedLocale } from './get-translation'

export interface ApiLocaleRequestLike {
  headers: {
    get(name: string): string | null
  }
}

/**
 * Resolve locale for API error messages from a raw `Accept-Language` header value.
 */
export function resolveApiLocaleFromAcceptLanguage(
  acceptLanguage: string | null | undefined,
): SupportedLocale {
  if (!acceptLanguage) {
    return defaultLocale
  }

  const primary = acceptLanguage.split(',')[0]?.trim().split(';')[0]?.trim()
  if (!primary) {
    return defaultLocale
  }

  if (isValidLocale(primary)) {
    return primary
  }

  if (primary.startsWith('zh')) {
    return 'zh-CN'
  }

  return defaultLocale
}

/**
 * Resolve locale for API error messages from a fetch-like `Request` object
 * (or any object exposing `headers.get('accept-language')`).
 */
export function resolveApiLocale(request: ApiLocaleRequestLike): SupportedLocale {
  return resolveApiLocaleFromAcceptLanguage(request.headers.get('accept-language'))
}
