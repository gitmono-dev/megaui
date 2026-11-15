import { describe, expect, it } from 'vitest'

import {
  FEISHU_PROVIDERS,
  OFFICIAL_FEISHU_ORIGIN,
  ProviderAdmissionError,
  admitProvider,
  isExactLoopbackOrigin,
  resolveRequestTarget,
  type DeploymentRole,
  type ProviderAdmissionInput,
} from './provider-admission'

const LOOPBACK_ORIGIN = 'http://127.0.0.1:19400'

function input(overrides: Partial<ProviderAdmissionInput> = {}): ProviderAdmissionInput {
  return {
    enabled: true,
    provider: 'feishu',
    role: 'production',
    nodeEnv: 'production',
    ...overrides,
  }
}

describe('provider admission (FS-87)', () => {
  it('constructs no target when the provider capability is disabled', () => {
    expect(admitProvider(input({ enabled: false }))).toBeUndefined()
    // A disabled capability ignores the provider value completely.
    expect(admitProvider(input({ enabled: false, provider: 'simulator' }))).toBeUndefined()
    expect(
      admitProvider(
        input({ enabled: false, provider: 'anything', simulatorOrigin: 'http://example.com' }),
      ),
    ).toBeUndefined()
  })

  it('requires an explicit provider once the capability is enabled', () => {
    for (const missing of [undefined, '', '   ']) {
      expect(() => admitProvider(input({ provider: missing }))).toThrow(ProviderAdmissionError)
      try {
        admitProvider(input({ provider: missing }))
        expect.unreachable()
      } catch (error) {
        expect((error as ProviderAdmissionError).code).toBe('provider_not_selected')
      }
    }
    for (const unknown of ['sim', 'feishu-cn', 'FEISHU', 'feishu simulator', 'http://open.feishu.cn']) {
      try {
        admitProvider(input({ provider: unknown }))
        expect.unreachable()
      } catch (error) {
        expect((error as ProviderAdmissionError).code).toBe('provider_unknown')
      }
    }
    expect(FEISHU_PROVIDERS).toEqual(['feishu', 'simulator'])
  })

  it('fixes the official source for the feishu provider', () => {
    const target = admitProvider(input({ provider: 'feishu' }))
    expect(target).toEqual({ provider: 'feishu', origin: 'https://open.feishu.cn' })
    expect(target?.origin).toBe(OFFICIAL_FEISHU_ORIGIN)
    // The official provider runs in every role and environment.
    for (const role of ['production', 'canary', 'development', 'test'] as DeploymentRole[]) {
      expect(
        admitProvider(input({ provider: 'feishu', role, nodeEnv: 'production' }))?.origin,
      ).toBe(OFFICIAL_FEISHU_ORIGIN)
    }
  })

  it('admits the simulator only in a trusted role and environment', () => {
    const admitted = admitProvider(
      input({
        provider: 'simulator',
        role: 'development',
        nodeEnv: 'development',
        simulatorOrigin: LOOPBACK_ORIGIN,
      }),
    )
    expect(admitted).toEqual({ provider: 'simulator', origin: LOOPBACK_ORIGIN })

    for (const role of ['production', 'canary'] as DeploymentRole[]) {
      try {
        admitProvider(
          input({
            provider: 'simulator',
            role,
            nodeEnv: 'test',
            simulatorOrigin: LOOPBACK_ORIGIN,
          }),
        )
        expect.unreachable()
      } catch (error) {
        expect((error as ProviderAdmissionError).code).toBe('provider_role_untrusted')
      }
    }
    for (const role of ['staging', 'unknown', ''] as unknown as DeploymentRole[]) {
      expect(() =>
        admitProvider(
          input({
            provider: 'simulator',
            role,
            nodeEnv: 'test',
            simulatorOrigin: LOOPBACK_ORIGIN,
          }),
        ),
      ).toThrow(ProviderAdmissionError)
    }

    try {
      admitProvider(
        input({
          provider: 'simulator',
          role: 'test',
          nodeEnv: 'production',
          simulatorOrigin: LOOPBACK_ORIGIN,
        }),
      )
      expect.unreachable()
    } catch (error) {
      expect((error as ProviderAdmissionError).code).toBe('provider_env_untrusted')
    }
  })

  it('accepts only the exact loopback origin of the standalone mock', () => {
    const accepted = [
      'http://127.0.0.1:19400',
      'http://127.0.0.1:1',
      'http://127.0.0.1:65535',
    ]
    for (const origin of accepted) {
      expect(isExactLoopbackOrigin(origin)).toBe(true)
      expect(
        admitProvider(
          input({
            provider: 'simulator',
            role: 'development',
            nodeEnv: 'development',
            simulatorOrigin: origin,
          }),
        )?.origin,
      ).toBe(origin)
    }

    const refused = [
      'http://localhost:19400',
      'http://LOCALHOST:19400',
      'http://[::1]:19400',
      'http://127.0.0.2:19400',
      'http://127.1:19400',
      'http://2130706433:19400',
      'https://127.0.0.1:19400',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:19400/',
      'http://127.0.0.1:19400/api',
      'http://127.0.0.1:19400?x=1',
      'http://127.0.0.1:19400#frag',
      'http://user:pw@127.0.0.1:19400',
      'http://mock.example.com:19400',
      'http://127.0.0.1.evil.example:19400',
      '127.0.0.1:19400',
      'http://127.0.0.1:19400 ',
      'not a url',
      '',
    ]
    for (const origin of refused) {
      expect(isExactLoopbackOrigin(origin)).toBe(false)
      try {
        admitProvider(
          input({
            provider: 'simulator',
            role: 'development',
            nodeEnv: 'development',
            simulatorOrigin: origin,
          }),
        )
        expect.unreachable()
      } catch (error) {
        expect((error as ProviderAdmissionError).code).toBe('provider_origin_invalid')
      }
    }

    try {
      admitProvider(
        input({
          provider: 'simulator',
          role: 'development',
          nodeEnv: 'development',
          simulatorOrigin: undefined,
        }),
      )
      expect.unreachable()
    } catch (error) {
      expect((error as ProviderAdmissionError).code).toBe('provider_origin_invalid')
    }
  })

  it('never lets a request replace the provider or the origin', () => {
    const admission = admitProvider(input({ provider: 'feishu' }))
    expect(admission).toBeDefined()
    // A request that carries its own provider or origin is ignored.
    const resolved = resolveRequestTarget(admission, {
      provider: 'simulator',
      origin: 'http://evil.example',
    })
    expect(resolved).toEqual({ provider: 'feishu', origin: OFFICIAL_FEISHU_ORIGIN })
    expect(resolved?.origin).toBe(OFFICIAL_FEISHU_ORIGIN)
    expect(resolveRequestTarget(admission)).toEqual(admission)
    expect(resolveRequestTarget(undefined, { provider: 'feishu' })).toBeUndefined()

    // Unknown fields of the admission input cannot move the target either.
    const polluted = admitProvider({
      ...input({ provider: 'feishu' }),
      origin: 'http://evil.example',
      providerOrigin: 'http://evil.example',
      requestOrigin: 'http://evil.example',
    } as unknown as ProviderAdmissionInput)
    expect(polluted?.origin).toBe(OFFICIAL_FEISHU_ORIGIN)
  })

  it('produces one frozen target without any fallback', () => {
    const target = admitProvider(input({ provider: 'feishu' }))
    expect(Object.isFrozen(target)).toBe(true)
    expect(Object.keys(target ?? {}).sort()).toEqual(['origin', 'provider'])
    for (const forbidden of ['fallback', 'fallbacks', 'backupOrigin', 'alternateProvider']) {
      expect(Object.keys(target ?? {})).not.toContain(forbidden)
      expect((target as unknown as Record<string, unknown>)[forbidden]).toBeUndefined()
    }
    expect(() => {
      ;(target as unknown as Record<string, unknown>).origin = 'http://evil.example'
    }).toThrow(TypeError)
    expect(target?.origin).toBe(OFFICIAL_FEISHU_ORIGIN)

    // A refused simulator never falls back to the official source.
    expect(() =>
      admitProvider(
        input({
          provider: 'simulator',
          role: 'production',
          nodeEnv: 'production',
          simulatorOrigin: 'http://evil.example',
        }),
      ),
    ).toThrow(ProviderAdmissionError)
  })
})
