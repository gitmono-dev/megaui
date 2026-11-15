/**
 * FS-87：provider 准入与不可变目标。
 *
 * 纯 core 模块：调用方注入对象，本模块不读 process.env、不请求 HTTP。准入结果
 * 只有一个冻结目标，没有备用 provider，也没有失败后切源的能力。
 */

/** The two accepted providers. */
export const FEISHU_PROVIDERS = ['feishu', 'simulator'] as const
export type FeishuProvider = (typeof FEISHU_PROVIDERS)[number]

/** The official provider origin; it is never configurable. */
export const OFFICIAL_FEISHU_ORIGIN = 'https://open.feishu.cn'

/** The deployment roles the mock source may run in. */
export const TRUSTED_DEPLOYMENT_ROLES = ['development', 'test'] as const

export type DeploymentRole = (typeof TRUSTED_DEPLOYMENT_ROLES)[number] | 'production' | 'canary'

export type ProviderErrorCode =
  | 'provider_not_selected'
  | 'provider_unknown'
  | 'provider_role_untrusted'
  | 'provider_env_untrusted'
  | 'provider_origin_invalid'

export class ProviderAdmissionError extends Error {
  readonly code: ProviderErrorCode

  constructor(code: ProviderErrorCode, message: string) {
    super(message)
    this.name = 'ProviderAdmissionError'
    this.code = code
  }
}

export interface ProviderAdmissionInput {
  /**
   * Whether the current process enables the provider capability. When it does
   * not, no target is constructed at all.
   */
  enabled: boolean
  /** The raw `FEISHU_PROVIDER` value. */
  provider?: string
  /** The deployment role of the current process. */
  role: DeploymentRole
  /** The `NODE_ENV` of the current process. */
  nodeEnv: 'development' | 'test' | 'production'
  /**
 * The origin of the standalone mock. It is only read for the simulator
 * provider and never overrides the official one.
   */
  simulatorOrigin?: string
}

/** The provider and origin a request may carry. Both are refused. */
export interface ProviderRequestInput {
  provider?: string
  origin?: string
}

/** The single immutable target the provider may be reached at. */
export interface ProviderTarget {
  readonly provider: FeishuProvider
  readonly origin: string
}

/**
 * Decides the provider target.
 *
 * The result is frozen and carries exactly one origin. Nothing in the input
 * can replace the provider or the official origin, and no fallback exists.
 */
export function admitProvider(input: ProviderAdmissionInput): ProviderTarget | undefined {
  if (!input.enabled) {
    return undefined
  }
  const raw = input.provider?.trim()
  if (raw === undefined || raw === '') {
    throw new ProviderAdmissionError(
      'provider_not_selected',
      'FEISHU_PROVIDER must be set when the provider capability is enabled',
    )
  }
  if (!FEISHU_PROVIDERS.includes(raw as FeishuProvider)) {
    throw new ProviderAdmissionError(
      'provider_unknown',
      `FEISHU_PROVIDER must be one of ${FEISHU_PROVIDERS.join(', ')}`,
    )
  }
  if (raw === 'simulator') {
    if (!TRUSTED_DEPLOYMENT_ROLES.includes(input.role as (typeof TRUSTED_DEPLOYMENT_ROLES)[number])) {
      throw new ProviderAdmissionError(
        'provider_role_untrusted',
        'the simulator provider only runs in a development or test deployment',
      )
    }
    if (input.nodeEnv !== 'development' && input.nodeEnv !== 'test') {
      throw new ProviderAdmissionError(
        'provider_env_untrusted',
        'the simulator provider only runs with NODE_ENV development or test',
      )
    }
    const origin = input.simulatorOrigin
    if (origin === undefined || !isExactLoopbackOrigin(origin)) {
      throw new ProviderAdmissionError(
        'provider_origin_invalid',
        'the simulator provider only accepts the exact loopback origin of the standalone mock',
      )
    }
    return Object.freeze({ provider: 'simulator', origin })
  }
  return Object.freeze({ provider: 'feishu', origin: OFFICIAL_FEISHU_ORIGIN })
}

/**
 * The target of one request.
 *
 * A request may not carry a provider nor an origin, so the request arguments
 * are deliberately not read: the frozen admission is the only target.
 */
export function resolveRequestTarget(
  admission: ProviderTarget | undefined,
  _request?: ProviderRequestInput,
): ProviderTarget | undefined {
  return admission
}

/**
 * The exact shape of the standalone mock origin: `http://127.0.0.1:<port>`.
 *
 * The raw string is matched instead of a parsed URL, the same way the frozen
 * mock contract validates its own target: URL parsing would drop port 80 and
 * rewrite non-literal hosts such as `127.1` or `2130706433` into `127.0.0.1`.
 */
const LOOPBACK_ORIGIN_PATTERN = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/

/**
 * True only for the exact loopback origin of the standalone mock.
 *
 * A name, a different loopback spelling, a missing port or any path, query,
 * fragment or credential makes the origin ambiguous and is refused.
 */
export function isExactLoopbackOrigin(origin: string): boolean {
  const match = LOOPBACK_ORIGIN_PATTERN.exec(origin)
  if (!match) return false
  const portText = match[1] ?? ''
  if (!/^(0|[1-9]\d*)$/.test(portText)) return false
  const port = Number(portText)
  return port >= 1 && port <= 65535
}
