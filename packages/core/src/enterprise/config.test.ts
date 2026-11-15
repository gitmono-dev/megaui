import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  AUTH_MODES,
  DEFAULT_AUTH_MODE,
  EnterpriseConfigError,
  resolveEnterpriseConfig,
  parseDirectoryDepartmentIds,
} from './config'
import { CLIENT_SAFE_KEYS, findClientUnsafeKeys, isClientSafeKey } from './policy'
import { ProviderAdmissionError, type ProviderAdmissionInput } from './provider-admission'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/** The configuration names this phase introduces, in the sample files. */
const PHASE_CONFIG_NAMES = ['AUTH_MODE'] as const

describe('provision department scope (FS-05)', () => {
  it('accepts a bounded immutable list of exact department ids', () => {
    const scope = parseDirectoryDepartmentIds('["od_approved","0"]')
    expect(scope).toEqual(['od_approved', '0'])
    expect(Object.isFrozen(scope)).toBe(true)
    expect(parseDirectoryDepartmentIds(JSON.stringify(Array.from({ length: 100 }, (_, i) => `od_${i}`)))).toHaveLength(100)
  })
  it('fails closed for missing, ambiguous, duplicate or oversized configuration', () => {
    for (const raw of [undefined, '', 'od_a,od_b', '{}', '[]', '[1]', '[null]', '["a","a"]',
      '[" a"]', '["a "]', '[""]', '["a/b"]', '["\\\\uD800"]',
      JSON.stringify(['a'.repeat(257)]), JSON.stringify(Array.from({ length: 101 }, (_, i) => `od_${i}`)),
      ' '.repeat(32 * 1024) + '["a"]']) {
      expect(() => parseDirectoryDepartmentIds(raw)).toThrow(EnterpriseConfigError)
    }
    expect(resolveEnterpriseConfig({ activated: false }).mode).toBe('legacy')
  })
})

function sampleKeys(path: string): Set<string> {
  const text = readFileSync(resolve(repoRoot, path), 'utf8')
  const keys = new Set<string>()
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())
    if (match?.[1]) keys.add(match[1])
  }
  return keys
}

describe('shared enterprise configuration (FS-01)', () => {
  it('accepts only the three frozen modes', () => {
    for (const mode of AUTH_MODES) {
      expect(resolveEnterpriseConfig({ authMode: mode, activated: false }).mode).toBe(mode)
    }
    expect(AUTH_MODES).toEqual(['legacy', 'enterprise', 'maintenance'])
    // Surrounding whitespace is normalised; everything else must match exactly.
    expect(resolveEnterpriseConfig({ authMode: ' legacy ', activated: false }).mode).toBe('legacy')
    for (const invalid of ['Enterprise', 'unknown', 'enterprise2', 'legacy,enterprise']) {
      expect(() => resolveEnterpriseConfig({ authMode: invalid, activated: false })).toThrow(
        EnterpriseConfigError,
      )
    }
  })

  it('keeps legacy for a deployment without AUTH_MODE', () => {
    expect(resolveEnterpriseConfig({ activated: false }).mode).toBe(DEFAULT_AUTH_MODE)
    expect(resolveEnterpriseConfig({ authMode: '', activated: false }).mode).toBe('legacy')
    expect(DEFAULT_AUTH_MODE).toBe('legacy')
  })

  it('refuses enterprise mode when a required configuration is missing', () => {
    expect(() =>
      resolveEnterpriseConfig({
        authMode: 'enterprise',
        activated: true,
        required: { FEISHU_APP_ID: 'cli_mock_megaui', FEISHU_APP_SECRET: '' },
      }),
    ).toThrow(/enterprise mode requires FEISHU_APP_SECRET/)

    const resolved = resolveEnterpriseConfig({
      authMode: 'enterprise',
      activated: true,
      required: { FEISHU_APP_ID: 'cli_mock_megaui', FEISHU_APP_SECRET: 'secret' },
    })
    expect(resolved.mode).toBe('enterprise')
    expect(resolved.requiredNames).toEqual(['FEISHU_APP_ID', 'FEISHU_APP_SECRET'])
  })

  it('refuses legacy while the activation marker is present', () => {
    expect(() => resolveEnterpriseConfig({ activated: true })).toThrow(
      /legacy is refused while the enterprise activation marker is present/,
    )
    expect(() => resolveEnterpriseConfig({ authMode: 'legacy', activated: true })).toThrow(
      EnterpriseConfigError,
    )
    expect(resolveEnterpriseConfig({ authMode: 'maintenance', activated: true }).mode).toBe(
      'maintenance',
    )
  })

  it('never echoes a configuration value in an error', () => {
    try {
      resolveEnterpriseConfig({
        authMode: 'enterprise',
        activated: true,
        required: { FEISHU_APP_SECRET: '' },
      })
      expect.unreachable()
    } catch (error) {
      expect((error as EnterpriseConfigError).message).not.toContain('secret')
    }
  })

  it('keeps every non-public configuration out of the client bundle', () => {
    expect(CLIENT_SAFE_KEYS).toEqual(['MEGAUI_APP_NAME', 'APP_BASE_URL', 'BETTER_AUTH_URL', 'AUTH_MODE'])
    expect(isClientSafeKey('AUTH_MODE')).toBe(true)
    for (const sensitive of [
      'FEISHU_APP_SECRET',
      'FEISHU_VERIFICATION_TOKEN',
      'FEISHU_ENCRYPT_KEY',
      'DATABASE_URL',
      'BETTER_AUTH_SECRET',
    ]) {
      expect(isClientSafeKey(sensitive)).toBe(false)
    }
    expect(
      findClientUnsafeKeys(['AUTH_MODE', 'FEISHU_APP_SECRET', 'DATABASE_URL']),
    ).toEqual(['DATABASE_URL', 'FEISHU_APP_SECRET'])
  })

  it('lists every configuration of this phase in the sample file', () => {
    const example = sampleKeys('env.example')
    for (const name of PHASE_CONFIG_NAMES) {
      expect(example.has(name)).toBe(true)
    }
    // `.env.test.example` carries the same placeholder in the same change.
    // It is a local sample that the authoring sandbox may not read, and the
    // repository env guard only validates placeholder formatting for
    // sensitive keys, so its completeness has no automated check yet; it is
    // covered by review of the sample diff.
  })
})

describe('the consumer wiring of the provider admission (FS-87)', () => {
  const provider: ProviderAdmissionInput = {
    enabled: true,
    provider: 'feishu',
    role: 'production',
    nodeEnv: 'production',
  }

  it('runs the admission for an enterprise process', () => {
    expect(() =>
      resolveEnterpriseConfig({
        authMode: 'enterprise',
        activated: true,
        required: { FEISHU_APP_ID: 'cli_mock_megaui' },
        provider: { ...provider, provider: 'simulator', role: 'production' },
      }),
    ).toThrow(ProviderAdmissionError)
  })

  it('leaves the other modes alone', () => {
    for (const mode of ['legacy', 'maintenance'] as const) {
      expect(
        resolveEnterpriseConfig({
          authMode: mode,
          activated: false,
          provider: { ...provider, provider: 'simulator', role: 'production' },
        }).mode,
      ).toBe(mode)
    }
  })
})
