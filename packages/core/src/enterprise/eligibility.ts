/**
 * FS-10：统一企业资格判定的纯规则。
 *
 * 本模块不读取环境、数据库或 provider。调用方先取得当前权威事实，再在这里
 * 组合部署 AUTH_MODE、持久策略、ban 边界与认证资格；未知输入一律拒绝。
 */

import { AUTH_MODES, type AuthMode } from './config'

/** A fail-closed result is distinct from every usable authentication mode. */
export type EffectiveAuthMode = AuthMode | 'reject'

/**
 * Combines the parsed deployment mode with the current persistent policy.
 *
 * The policy must always be present and known. Maintenance closes business
 * authentication, legacy remains legacy only before activation, and an
 * enterprise deployment treats a legacy policy as pre-activation maintenance.
 */
export function resolveEffectiveAuthMode(
  authMode: AuthMode,
  activationState: unknown,
): EffectiveAuthMode {
  if (
    !(AUTH_MODES as readonly unknown[]).includes(authMode) ||
    typeof activationState !== 'string' ||
    !(AUTH_MODES as readonly string[]).includes(activationState)
  ) {
    return 'reject'
  }

  const policyMode = activationState as AuthMode
  if (authMode === 'maintenance') return 'maintenance'
  if (authMode === 'legacy') {
    return policyMode === 'legacy' ? 'legacy' : 'reject'
  }
  if (policyMode === 'legacy') return 'maintenance'
  return policyMode
}

export interface ActiveLocalBanInput {
  banned: boolean | null
  /** node-postgres decodes timestamptz +/-infinity as numeric infinities. */
  banExpires: Date | number | null
  now: Date
}

/**
 * True only for an explicit, unexpired ban.
 *
 * A null expiry is permanent, a future expiry is active, and an expiry equal
 * to or before now is expired. An invalid timestamp fails closed when the ban
 * flag is set. A legacy expiry alone never bans an unflagged user.
 */
export function isActiveLocalBan(input: ActiveLocalBanInput): boolean {
  if (input.banned !== true) return false
  if (input.banExpires === null) return true
  const now = input.now.getTime()
  if (!Number.isFinite(now)) return true
  if (typeof input.banExpires === 'number') {
    if (input.banExpires === Number.POSITIVE_INFINITY) return true
    if (input.banExpires === Number.NEGATIVE_INFINITY) return false
    return true
  }
  const expiresAt = input.banExpires.getTime()
  if (!Number.isFinite(expiresAt)) return true
  return expiresAt > now
}

export interface AuthenticationEligibilityFacts {
  authorityMatches: boolean
  identityActive: boolean
  directoryCurrent: boolean
  activeLocalBan: boolean
  epochMatches: boolean
  effectiveMode: EffectiveAuthMode
}

/** Grants authentication only when every frozen authority predicate holds. */
export function isAuthenticationEligible(facts: AuthenticationEligibilityFacts): boolean {
  return (
    facts.authorityMatches &&
    facts.identityActive &&
    facts.directoryCurrent &&
    !facts.activeLocalBan &&
    facts.epochMatches &&
    facts.effectiveMode === 'enterprise'
  )
}
