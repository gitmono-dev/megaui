import { describe, expect, it } from 'vitest'

import {
  isActiveLocalBan,
  isAuthenticationEligible,
  resolveEffectiveAuthMode,
  type AuthenticationEligibilityFacts,
} from './eligibility'

describe('enterprise eligibility core rules (FS-10)', () => {
  it.each([
    ['maintenance', 'legacy', 'maintenance'],
    ['maintenance', 'maintenance', 'maintenance'],
    ['maintenance', 'enterprise', 'maintenance'],
    ['legacy', 'legacy', 'legacy'],
    ['legacy', 'maintenance', 'reject'],
    ['legacy', 'enterprise', 'reject'],
    ['enterprise', 'legacy', 'maintenance'],
    ['enterprise', 'maintenance', 'maintenance'],
    ['enterprise', 'enterprise', 'enterprise'],
  ] as const)(
    'resolves AUTH_MODE=%s with policy=%s to %s',
    (authMode, policy, expected) => {
      expect(resolveEffectiveAuthMode(authMode, policy)).toBe(expected)
    },
  )

  it('rejects a missing, unknown, or unparsed mode combination', () => {
    expect(resolveEffectiveAuthMode('enterprise', undefined)).toBe('reject')
    expect(resolveEffectiveAuthMode('enterprise', 'unknown')).toBe('reject')
    expect(resolveEffectiveAuthMode('legacy', null)).toBe('reject')
    expect(resolveEffectiveAuthMode('unknown' as never, 'legacy')).toBe('reject')
  })

  it('uses the exact active-ban expiry boundary', () => {
    const now = new Date('2026-11-09T20:00:00.000Z')
    expect(isActiveLocalBan({ banned: true, banExpires: null, now })).toBe(true)
    expect(
      isActiveLocalBan({
        banned: true,
        banExpires: new Date('2026-11-09T20:00:00.001Z'),
        now,
      }),
    ).toBe(true)
    expect(isActiveLocalBan({ banned: true, banExpires: new Date(now), now })).toBe(false)
    expect(
      isActiveLocalBan({
        banned: true,
        banExpires: new Date('2026-11-09T19:59:59.999Z'),
        now,
      }),
    ).toBe(false)
  })

  it('does not infer a ban from a legacy expiry when banned is not true', () => {
    const now = new Date('2026-11-09T20:00:00.000Z')
    const future = new Date('2026-11-10T20:00:00.000Z')
    expect(isActiveLocalBan({ banned: false, banExpires: future, now })).toBe(false)
    expect(isActiveLocalBan({ banned: null, banExpires: future, now })).toBe(false)
    expect(
      isActiveLocalBan({ banned: false, banExpires: Number.POSITIVE_INFINITY, now }),
    ).toBe(false)
  })

  it('handles PostgreSQL infinite expiry values at the active-ban boundary', () => {
    const now = new Date('2026-11-09T20:00:00.000Z')
    expect(
      isActiveLocalBan({ banned: true, banExpires: Number.POSITIVE_INFINITY, now }),
    ).toBe(true)
    expect(
      isActiveLocalBan({ banned: true, banExpires: Number.NEGATIVE_INFINITY, now }),
    ).toBe(false)
  })

  it('fails closed for an invalid expiry on an explicit ban', () => {
    expect(
      isActiveLocalBan({
        banned: true,
        banExpires: new Date(Number.NaN),
        now: new Date('2026-11-09T20:00:00.000Z'),
      }),
    ).toBe(true)
  })

  it('approves only the complete positive predicate set', () => {
    const eligible: AuthenticationEligibilityFacts = {
      authorityMatches: true,
      identityActive: true,
      directoryCurrent: true,
      activeLocalBan: false,
      epochMatches: true,
      effectiveMode: 'enterprise',
    }
    expect(isAuthenticationEligible(eligible)).toBe(true)

    for (const field of [
      'authorityMatches',
      'identityActive',
      'directoryCurrent',
      'epochMatches',
    ] as const) {
      expect(isAuthenticationEligible({ ...eligible, [field]: false })).toBe(false)
    }
    expect(isAuthenticationEligible({ ...eligible, activeLocalBan: true })).toBe(false)
    for (const effectiveMode of ['legacy', 'maintenance', 'reject'] as const) {
      expect(isAuthenticationEligible({ ...eligible, effectiveMode })).toBe(false)
    }
  })
})
