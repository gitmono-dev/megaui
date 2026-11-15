import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateBlockId, isBlockId } from './block-id'

afterEach(() => vi.restoreAllMocks())

describe('block IDs', () => {
  it('uses all 12 cryptographically random bytes, including URL-safe symbols', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(value => {
      (value as Uint8Array).set([0, 25, 26, 51, 52, 61, 62, 63, 64, 127, 128, 255])
      return value
    })
    expect(generateBlockId()).toBe('AZaz09_-A-A-')
  })

  it.each(['zK7QQWAdv_12', 'AZaz09_-A-A-'])('accepts the 12-character identity %s', id => {
    expect(isBlockId(id)).toBe(true)
  })

  it.each([null, 123, '', 'zK7QQWAdv', 'abcdefghijklM', 'abcdef!hijkl', 'abcdefghijkl\n', '573ddfe6-ee19-4015-89dd-558f7a5e44db'])('rejects malformed or UUID identity %s', id => {
    expect(isBlockId(id)).toBe(false)
  })
})
