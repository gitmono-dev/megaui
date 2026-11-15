/**
 * FS-01/64：server-only 配置边界与持久认证策略 DTO。
 *
 * 本模块只描述可共享的纯合同，不读取环境、数据库或运行态 secret；密钥残留守卫
 * 由 FS-51 承接，provider 准入由 FS-87 承接。
 */

import { AUTH_MODES, type AuthMode } from './config'

export const ENTERPRISE_POLICY_SCHEMA_VERSION = 1 as const

/** The exact server-to-server projection consumed by collab. */
export interface EnterprisePolicyResponse {
  readonly schema_version: typeof ENTERPRISE_POLICY_SCHEMA_VERSION
  readonly effective_mode: AuthMode
  readonly policy_epoch: number
  readonly instance_id: string
  readonly artifact_sha: string
}

export interface EnterprisePolicyResponseInput {
  readonly effectiveMode: AuthMode
  readonly policyEpoch: number
  readonly instanceId: string
  readonly artifactSha: string
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 256 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0
      return code > 0x1f && code !== 0x7f
    })
}

/** Build the immutable policy projection without duplicating its DTO in an app. */
export function createEnterprisePolicyResponse(
  input: EnterprisePolicyResponseInput,
): EnterprisePolicyResponse {
  if (!(AUTH_MODES as readonly string[]).includes(input.effectiveMode) ||
    !Number.isSafeInteger(input.policyEpoch) || input.policyEpoch < 0 ||
    !validIdentifier(input.instanceId) || !/^[a-f0-9]{64}$/u.test(input.artifactSha)) {
    throw new Error('ENTERPRISE_POLICY_INVALID')
  }
  return Object.freeze({
    schema_version: ENTERPRISE_POLICY_SCHEMA_VERSION,
    effective_mode: input.effectiveMode,
    policy_epoch: input.policyEpoch,
    instance_id: input.instanceId,
    artifact_sha: input.artifactSha,
  })
}

/** Parse the wire DTO without allowing an app-specific policy shape. */
export function parseEnterprisePolicyResponse(value: unknown): EnterprisePolicyResponse | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.join(',') !== 'artifact_sha,effective_mode,instance_id,policy_epoch,schema_version') return null
  if (record.schema_version !== ENTERPRISE_POLICY_SCHEMA_VERSION ||
    typeof record.effective_mode !== 'string' ||
    typeof record.policy_epoch !== 'number' ||
    typeof record.instance_id !== 'string' ||
    typeof record.artifact_sha !== 'string') return null
  try {
    return createEnterprisePolicyResponse({
      effectiveMode: record.effective_mode as AuthMode,
      policyEpoch: record.policy_epoch,
      instanceId: record.instance_id,
      artifactSha: record.artifact_sha,
    })
  } catch {
    return null
  }
}

/**
 * The configuration that may reach the browser.
 *
 * Everything outside this allowlist is server-only: a new sensitive value has
 * to stay out of the client bundle, so the allowlist is explicit and the
 * default answer is "not client safe".
 */
export const CLIENT_SAFE_KEYS: readonly string[] = [
  'MEGAUI_APP_NAME',
  'APP_BASE_URL',
  'BETTER_AUTH_URL',
  'AUTH_MODE',
]

/** True only for a configuration the client bundle may contain. */
export function isClientSafeKey(name: string): boolean {
  return CLIENT_SAFE_KEYS.includes(name)
}

/**
 * Returns the names that must not reach the client.
 *
 * The caller passes the configuration it is about to expose and gets back the
 * names that would violate the boundary, sorted, so a build step can fail
 * closed without ever printing the values.
 */
export function findClientUnsafeKeys(names: readonly string[]): string[] {
  return names.filter((name) => !isClientSafeKey(name)).sort()
}
