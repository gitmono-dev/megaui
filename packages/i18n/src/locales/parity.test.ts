import { describe, expect, it } from 'vitest'
import { en } from './en'
import { zhCN } from './zh-CN'

/**
 * Collects every leaf key path (dot-joined) in a nested plain-object
 * dictionary. Arrays are treated as leaves (their contents are not
 * required to have parity across locales), matching how the locale
 * dictionaries use them (e.g. `groups.*` lists of enum-like string keys).
 */
function collectKeyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value) || value === null || typeof value !== 'object') {
    return [prefix]
  }

  const paths: string[] = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key
    paths.push(...collectKeyPaths(child, nextPrefix))
  }
  return paths
}

describe('en / zh-CN key-set parity (PK-03 AC 1)', () => {
  const enKeys = collectKeyPaths(en).sort()
  const zhKeys = collectKeyPaths(zhCN).sort()

  it('has at least one namespace', () => {
    expect(enKeys.length).toBeGreaterThan(0)
  })

  it('zh-CN has no keys missing from en', () => {
    const missingFromEn = zhKeys.filter((key) => !enKeys.includes(key))
    expect(missingFromEn).toEqual([])
  })

  it('en has no keys missing from zh-CN', () => {
    const missingFromZh = enKeys.filter((key) => !zhKeys.includes(key))
    expect(missingFromZh).toEqual([])
  })

  it('key sets are byte-for-byte identical', () => {
    expect(zhKeys).toEqual(enKeys)
  })
})
