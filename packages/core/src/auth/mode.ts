// megaui-only (FSL-116): the single parser of AUTH_MODE and AUTH_PROVIDER.
/**
 * FSL-116：认证模式与提供方解析（ADR-FSL-12）。
 *
 * The single rule set for the authentication mode (GC-02). Web, collab and
 * engine adopt it in later cards (FSL-121, FSL-126, FSL-128); until then they
 * keep their existing parsing. It reads no environment by itself: the caller
 * passes the raw values. The provider is checked before the mode.
 *
 * - `AUTH_MODE` is `legacy` (the default when unset) or `enterprise`.
 * - `AUTH_PROVIDER` must be `feishu` in enterprise mode, and unset or `local`
 *   in legacy mode.
 * - Transition (FSL-116 to FSL-131): `enterprise` without `AUTH_PROVIDER`
 *   still selects the existing enterprise implementation and `maintenance`
 *   keeps its current behaviour. FSL-132 starts refusing both.
 *
 * Any other combination fails closed with `INVALID_AUTH_PROVIDER` (or
 * `INVALID_AUTH_MODE` for an unknown mode). Error messages name the keys,
 * never their values.
 */

export const AUTH_PROVIDERS = ['local', 'feishu'] as const
export type AuthProvider = (typeof AUTH_PROVIDERS)[number]

export type ResolvedAuthMode =
  | { readonly mode: 'legacy' }
  | { readonly mode: 'enterprise'; readonly provider: 'feishu' }
  /** Transition only: the existing enterprise implementation (refused from FSL-132). */
  | { readonly mode: 'enterprise'; readonly provider: undefined }
  /** Transition only: the existing maintenance mode (refused from FSL-132). */
  | { readonly mode: 'maintenance' }

export type AuthModeErrorCode = 'INVALID_AUTH_MODE' | 'INVALID_AUTH_PROVIDER'

export class AuthModeError extends Error {
  readonly code: AuthModeErrorCode

  constructor(code: AuthModeErrorCode, message: string) {
    super(message)
    this.name = 'AuthModeError'
    this.code = code
  }
}

export interface AuthModeSource {
  /** The raw `AUTH_MODE` value, as the caller read it. */
  readonly AUTH_MODE?: string | undefined
  /** The raw `AUTH_PROVIDER` value, as the caller read it. */
  readonly AUTH_PROVIDER?: string | undefined
}

/** An unset or blank value counts as not set. */
function normalize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function invalidProvider(): AuthModeError {
  return new AuthModeError(
    'INVALID_AUTH_PROVIDER',
    'AUTH_PROVIDER is not valid for the selected AUTH_MODE',
  )
}

/** Resolves the authentication mode and provider (ADR-FSL-12). */
export function resolveAuthMode(source: AuthModeSource): ResolvedAuthMode {
  const mode = normalize(source.AUTH_MODE) ?? 'legacy'
  const provider = normalize(source.AUTH_PROVIDER)

  if (provider !== undefined && !(AUTH_PROVIDERS as readonly string[]).includes(provider)) {
    throw invalidProvider()
  }

  switch (mode) {
    case 'legacy':
      if (provider === undefined || provider === 'local') return Object.freeze({ mode: 'legacy' })
      throw invalidProvider()
    case 'enterprise':
      if (provider === 'feishu') return Object.freeze({ mode: 'enterprise', provider: 'feishu' })
      if (provider === undefined) return Object.freeze({ mode: 'enterprise', provider: undefined })
      throw invalidProvider()
    case 'maintenance':
      if (provider === undefined) return Object.freeze({ mode: 'maintenance' })
      throw invalidProvider()
    default:
      throw new AuthModeError(
        'INVALID_AUTH_MODE',
        'AUTH_MODE must be legacy or enterprise (maintenance is accepted only during the transition)',
      )
  }
}
