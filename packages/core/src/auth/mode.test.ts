// megaui-only (FSL-116, FSL-132): tests for the single AUTH_MODE / AUTH_PROVIDER parser.
import { describe, expect, it } from 'vitest'

import * as core from '../index'
import { AuthModeError, resolveAuthMode } from './mode'

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof AuthModeError ? error.code : 'not-an-AuthModeError'
  }
  return undefined
}

describe('resolveAuthMode (FSL-116, ADR-FSL-12)', () => {
  it('AC1: with neither AUTH_MODE nor AUTH_PROVIDER set it is legacy', () => {
    expect(resolveAuthMode({})).toStrictEqual({ mode: 'legacy' })
    expect(resolveAuthMode({ AUTH_MODE: '', AUTH_PROVIDER: '  ' })).toStrictEqual({ mode: 'legacy' })
  })

  it('legacy accepts AUTH_PROVIDER=local', () => {
    expect(resolveAuthMode({ AUTH_MODE: 'legacy', AUTH_PROVIDER: 'local' })).toStrictEqual({
      mode: 'legacy',
    })
  })

  it('AC2: AUTH_MODE=enterprise with AUTH_PROVIDER=feishu selects the Feishu provider', () => {
    expect(resolveAuthMode({ AUTH_MODE: 'enterprise', AUTH_PROVIDER: 'feishu' })).toStrictEqual({
      mode: 'enterprise',
      provider: 'feishu',
    })
  })

  it.each([undefined, '', '  '])(
    'FSL-132: AUTH_MODE=enterprise without AUTH_PROVIDER (%j) is INVALID_AUTH_PROVIDER',
    (provider) => {
      expect(codeOf(() => resolveAuthMode({ AUTH_MODE: 'enterprise', AUTH_PROVIDER: provider }))).toBe(
        'INVALID_AUTH_PROVIDER',
      )
      expect(codeOf(() => resolveAuthMode({ AUTH_MODE: ' enterprise ', AUTH_PROVIDER: provider }))).toBe(
        'INVALID_AUTH_PROVIDER',
      )
    },
  )

  it.each([undefined, '', '  ', 'local', 'feishu'])(
    'FSL-132: AUTH_MODE=maintenance (AUTH_PROVIDER=%j) is INVALID_AUTH_PROVIDER',
    (provider) => {
      expect(codeOf(() => resolveAuthMode({ AUTH_MODE: 'maintenance', AUTH_PROVIDER: provider }))).toBe(
        'INVALID_AUTH_PROVIDER',
      )
    },
  )

  it('FSL-132: the refusal message names the keys, never a value', () => {
    let message = ''
    try {
      resolveAuthMode({ AUTH_MODE: 'maintenance' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('AUTH_PROVIDER')
    expect(message).not.toContain('maintenance')
  })

  it.each(['oidc', 'Feishu', 'lark'])(
    'AC4: AUTH_PROVIDER=%s (not local or feishu) is INVALID_AUTH_PROVIDER',
    (provider) => {
      expect(codeOf(() => resolveAuthMode({ AUTH_MODE: 'enterprise', AUTH_PROVIDER: provider }))).toBe(
        'INVALID_AUTH_PROVIDER',
      )
      expect(codeOf(() => resolveAuthMode({ AUTH_PROVIDER: provider }))).toBe('INVALID_AUTH_PROVIDER')
    },
  )

  it.each([undefined, 'legacy', 'maintenance'])(
    'AC5: AUTH_PROVIDER=feishu with AUTH_MODE=%s is INVALID_AUTH_PROVIDER',
    (mode) => {
      expect(codeOf(() => resolveAuthMode({ AUTH_MODE: mode, AUTH_PROVIDER: 'feishu' }))).toBe(
        'INVALID_AUTH_PROVIDER',
      )
    },
  )

  it('enterprise with AUTH_PROVIDER=local is INVALID_AUTH_PROVIDER', () => {
    expect(codeOf(() => resolveAuthMode({ AUTH_MODE: 'enterprise', AUTH_PROVIDER: 'local' }))).toBe(
      'INVALID_AUTH_PROVIDER',
    )
  })

  it('an unknown AUTH_MODE is INVALID_AUTH_MODE and the message names no value', () => {
    let message = ''
    expect(
      codeOf(() => {
        try {
          resolveAuthMode({ AUTH_MODE: 'secret-mode-value' })
        } catch (error) {
          message = (error as Error).message
          throw error
        }
      }),
    ).toBe('INVALID_AUTH_MODE')
    expect(message).not.toContain('secret-mode-value')
  })

  it('the provider is checked first: an unknown mode with an unknown provider is INVALID_AUTH_PROVIDER', () => {
    expect(codeOf(() => resolveAuthMode({ AUTH_MODE: 'unknown', AUTH_PROVIDER: 'oidc' }))).toBe(
      'INVALID_AUTH_PROVIDER',
    )
  })

  it('AC6: resolveAuthMode is exported from the @megaui/core entry', () => {
    expect(core.resolveAuthMode).toBe(resolveAuthMode)
  })
})
