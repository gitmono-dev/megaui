/**
 * FS-01：共享企业配置合同与模式解析。
 *
 * 纯基础解析器：调用方注入配置对象，本模块不读取环境、不持有运行态 secret，
 * 因此所有进程复用同一份语义。
 */

import { admitProvider, type ProviderAdmissionInput } from './provider-admission'

/** The three accepted authentication modes. */
export const AUTH_MODES = ['legacy', 'enterprise', 'maintenance'] as const
export type AuthMode = (typeof AUTH_MODES)[number]

/** The mode an old deployment without `AUTH_MODE` keeps using. */
export const DEFAULT_AUTH_MODE: AuthMode = 'legacy'

export type EnterpriseConfigErrorCode =
  | 'auth_mode_invalid'
  | 'enterprise_config_missing'
  | 'enterprise_activation_conflict'
  | 'directory_scope_invalid'

export class EnterpriseConfigError extends Error {
  readonly code: EnterpriseConfigErrorCode

  constructor(code: EnterpriseConfigErrorCode, message: string) {
    super(message)
    this.name = 'EnterpriseConfigError'
    this.code = code
  }
}

export interface EnterpriseConfigInput {
  /** The raw `AUTH_MODE` value, as the caller read it. */
  authMode?: string
  /** True when the deployment holds the persistent enterprise activation marker. */
  activated: boolean
  /**
   * The configuration values the current capability requires in enterprise
   * mode. Only the names are reported back, never the values.
   */
  required?: Readonly<Record<string, string | undefined>>
  /**
   * The provider admission inputs, when the current process enables the
   * provider capability. In enterprise mode the admission has to succeed.
   */
  provider?: ProviderAdmissionInput
}

/** FS-05: capability-scoped, pure department authority parsing; never reads env. */
export function parseDirectoryDepartmentIds(raw: string | undefined): readonly string[] {
  try {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 32 * 1024) throw new Error()
    const ids: unknown = JSON.parse(raw)
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 ||
      ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) ||
      new Set(ids).size !== ids.length) throw new Error()
    return Object.freeze([...ids] as string[])
  } catch {
    throw new EnterpriseConfigError('directory_scope_invalid', 'FEISHU_DIRECTORY_DEPARTMENT_IDS is invalid')
  }
}

export interface EnterpriseConfig {
  mode: AuthMode
  /** The names the current capability requires, sorted, for diagnostics. */
  requiredNames: readonly string[]
}

/**
 * Resolves the authentication mode.
 *
 * An absent `AUTH_MODE` keeps the legacy behaviour of older deployments, an
 * unknown value is refused, an activated deployment may not run legacy, and
 * enterprise mode refuses to start when a configuration the current
 * capability requires is missing.
 */
export function resolveEnterpriseConfig(input: EnterpriseConfigInput): EnterpriseConfig {
  const raw = input.authMode?.trim()
  const mode = (raw === undefined || raw === '' ? DEFAULT_AUTH_MODE : raw) as AuthMode
  if (!AUTH_MODES.includes(mode)) {
    throw new EnterpriseConfigError(
      'auth_mode_invalid',
      `AUTH_MODE must be one of ${AUTH_MODES.join(', ')}`,
    )
  }
  if (input.activated && mode === 'legacy') {
    throw new EnterpriseConfigError(
      'enterprise_activation_conflict',
      'legacy is refused while the enterprise activation marker is present',
    )
  }
  const required = input.required ?? {}
  const missing = Object.keys(required)
    .filter((name) => {
      const value = required[name]
      return value === undefined || value.trim() === ''
    })
    .sort()
  if (mode === 'enterprise' && input.provider !== undefined) {
    // The provider admission is the only place that may construct a target.
    admitProvider(input.provider)
  }
  if (mode === 'enterprise' && missing.length > 0) {
    throw new EnterpriseConfigError(
      'enterprise_config_missing',
      `enterprise mode requires ${missing.join(', ')}`,
    )
  }
  return { mode, requiredNames: Object.keys(required).sort() }
}
