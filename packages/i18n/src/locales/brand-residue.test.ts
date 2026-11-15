import { describe, expect, it } from 'vitest'
import { en } from './en'
import { zhCN } from './zh-CN'

const BRAND_PATTERN = new RegExp(`tinyship|${['mono', 'ui'].join('')}`, 'i')

/**
 * Recursively collects every string leaf value (including array entries)
 * out of a locale dictionary, tagged with its dot-joined key path for
 * useful failure messages.
 */
function collectStringValues(value: unknown, prefix = ''): Array<{ path: string; value: string }> {
  if (typeof value === 'string') {
    return [{ path: prefix, value }]
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectStringValues(item, `${prefix}[${index}]`))
  }

  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      collectStringValues(child, prefix ? `${prefix}.${key}` : key),
    )
  }

  return []
}

describe('brand residue guard (PK-03 AC 2)', () => {
  // This only inspects the *runtime dictionary values* (what actually
  // reaches end users), not TypeScript source comments.
  it.each([
    ['en', en],
    ['zh-CN', zhCN],
  ])('%s has zero brand-word hits in translation values', (_name, dictionary) => {
    const hits = collectStringValues(dictionary).filter(({ value }) => BRAND_PATTERN.test(value))
    expect(hits).toEqual([])
  })
})
