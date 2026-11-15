import { describe, expect, it } from 'vitest'
import { colorFromUserId } from './presence-color'

const HSL_PATTERN = /^hsl\(\d{1,3} 70% 45%\)$/

describe('colorFromUserId', () => {
  it('returns a well-formed hsl() string', () => {
    expect(colorFromUserId('user-1')).toMatch(HSL_PATTERN)
  })

  it('is deterministic for the same userId', () => {
    expect(colorFromUserId('user-1')).toBe(colorFromUserId('user-1'))
  })

  it('differs across distinct userIds (no trivial constant fallback)', () => {
    const colors = new Set(['a', 'b', 'c', 'd', 'e'].map((id) => colorFromUserId(id)))
    expect(colors.size).toBeGreaterThan(1)
  })

  it('falls back to a stable color for an empty/whitespace-only userId', () => {
    expect(colorFromUserId('')).toBe(colorFromUserId('anon'))
    expect(colorFromUserId('   ')).toBe(colorFromUserId('anon'))
  })

  it('produces a hue within [0, 360)', () => {
    for (const id of ['user-1', 'user-2', '', 'zzzzzzzzzz', '中文']) {
      const match = colorFromUserId(id).match(/^hsl\((\d+) 70% 45%\)$/)
      expect(match).not.toBeNull()
      const hue = Number(match?.[1])
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
  })
})
