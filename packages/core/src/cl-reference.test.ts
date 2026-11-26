import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateCLPublicId, isCLPublicId, isCLReference } from './cl-reference'

afterEach(() => vi.restoreAllMocks())

describe('CL public codes', () => {
  it('resamples both separator characters before returning a twelve-character code', () => {
    const random = vi.spyOn(crypto, 'getRandomValues')
    random.mockImplementationOnce(bytes => {
      (bytes as Uint8Array).fill(63)
      return bytes
    })
    random.mockImplementationOnce(bytes => {
      (bytes as Uint8Array).fill(62)
      return bytes
    })
    random.mockImplementationOnce(bytes => {
      (bytes as Uint8Array).set([0, 25, 26, 51, 52, 61, 0, 1, 2, 3, 4, 5])
      return bytes
    })
    expect(generateCLPublicId()).toBe('AZaz09ABCDEF')
    expect(random).toHaveBeenCalledTimes(3)
  })

  it('distinguishes canonical codes from supported legacy addresses', () => {
    for (const code of ['AZaz09ABCDEF', '000123456789']) {
      expect(isCLPublicId(code)).toBe(true)
      expect(isCLReference(code)).toBe(true)
    }
    for (const legacy of ['AZaz09_ABCDE', 'abc-efGhIj0k', 'abc-efGhIj_k', '1']) {
      expect(isCLPublicId(legacy)).toBe(false)
      expect(isCLReference(legacy)).toBe(true)
    }
    expect(isCLReference('bad-code')).toBe(false)
  })
})
