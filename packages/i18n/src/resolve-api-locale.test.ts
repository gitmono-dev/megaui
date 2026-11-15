import { describe, expect, it } from 'vitest'
import { resolveApiLocale, resolveApiLocaleFromAcceptLanguage } from './resolve-api-locale'

describe('resolveApiLocaleFromAcceptLanguage', () => {
  it('defaults to "en" when the header is missing', () => {
    expect(resolveApiLocaleFromAcceptLanguage(undefined)).toBe('en')
    expect(resolveApiLocaleFromAcceptLanguage(null)).toBe('en')
    expect(resolveApiLocaleFromAcceptLanguage('')).toBe('en')
  })

  it('returns the exact supported locale when present', () => {
    expect(resolveApiLocaleFromAcceptLanguage('zh-CN')).toBe('zh-CN')
    expect(resolveApiLocaleFromAcceptLanguage('en')).toBe('en')
  })

  it('parses a full Accept-Language header with quality values', () => {
    expect(resolveApiLocaleFromAcceptLanguage('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh-CN')
  })

  it('maps unsupported zh-* variants to zh-CN', () => {
    expect(resolveApiLocaleFromAcceptLanguage('zh-TW')).toBe('zh-CN')
    expect(resolveApiLocaleFromAcceptLanguage('zh')).toBe('zh-CN')
  })

  it('falls back to the default locale for unsupported languages', () => {
    expect(resolveApiLocaleFromAcceptLanguage('fr-FR,fr;q=0.9')).toBe('en')
  })
})

describe('resolveApiLocale', () => {
  const makeRequest = (acceptLanguage: string | null): { headers: { get(name: string): string | null } } => ({
    headers: {
      get: (name: string) => (name.toLowerCase() === 'accept-language' ? acceptLanguage : null),
    },
  })

  it('reads the Accept-Language header off a fetch-like Request', () => {
    expect(resolveApiLocale(makeRequest('zh-CN,zh;q=0.9'))).toBe('zh-CN')
    expect(resolveApiLocale(makeRequest(null))).toBe('en')
  })

  it('is structurally compatible with the real fetch Request type', () => {
    // `ApiLocaleRequestLike` only requires `headers.get`, so any object
    // shaped like a fetch `Headers`/`Request` pair — without importing the
    // DOM lib into this package's tsconfig — satisfies it.
    const headers = new Map([['accept-language', 'zh-CN,zh;q=0.9,en;q=0.8']])
    const request = { headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null } }
    expect(resolveApiLocale(request)).toBe('zh-CN')
  })
})
