import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateCLPublicId, isCLPublicId, isCLReference } from './cl-reference'

afterEach(() => vi.restoreAllMocks())

describe('CL public codes', () => {
  it('resamples a hyphenated candidate and preserves underscores', () => {
    const random = vi.spyOn(crypto, 'getRandomValues')
    random.mockImplementationOnce(bytes => {
      (bytes as Uint8Array).fill(63)
      return bytes
    })
    random.mockImplementationOnce(bytes => {
      (bytes as Uint8Array).set([0, 25, 26, 51, 52, 61, 62, 0, 1, 2, 3, 4])
      return bytes
    })
    expect(generateCLPublicId()).toBe('AZaz09_ABCDE')
    expect(random).toHaveBeenCalledTimes(2)
  })

  it('distinguishes canonical codes from supported legacy addresses', () => {
    for (const code of ['AZaz09_ABCDE', '000123456789']) {
      expect(isCLPublicId(code)).toBe(true)
      expect(isCLReference(code)).toBe(true)
    }
    for (const legacy of ['abc-efGhIj_k', '1']) {
      expect(isCLPublicId(legacy)).toBe(false)
      expect(isCLReference(legacy)).toBe(true)
    }
    expect(isCLReference('bad-code')).toBe(false)
  })
})
