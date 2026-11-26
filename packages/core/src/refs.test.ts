import { describe, expect, it } from 'vitest'
import { formatDiffStat, parseRefs, type RefToken } from './refs'

describe('parseRefs', () => {
  it('returns a single plain token for text with no references', () => {
    expect(parseRefs('just plain text')).toEqual([
      { kind: 'plain', raw: 'just plain text', text: 'just plain text', start: 0, end: 15 },
    ])
  })

  it('returns a single empty plain token for the empty string', () => {
    expect(parseRefs('')).toEqual([{ kind: 'plain', raw: '', text: '', start: 0, end: 0 }])
  })

  it('parses a CL reference', () => {
    const tokens = parseRefs('see !42 please')
    const clToken = tokens.find((t): t is Extract<RefToken, { kind: 'cl' }> => t.kind === 'cl')
    expect(clToken).toMatchObject({ kind: 'cl', number: 42, raw: '!42' })
  })

  it('parses an issue reference', () => {
    const tokens = parseRefs('fixes #7')
    expect(tokens.some((t) => t.kind === 'issue' && t.number === 7)).toBe(true)
  })

  it.each(['9ab_CD-345xy', '000123456789'])('preserves the public CL reference %s in prose', publicId => {
    const tokens = parseRefs(`见!${publicId}，!42`)
    expect(tokens.filter(token => token.kind === 'cl')).toEqual([
      { kind: 'cl', publicId, raw: `!${publicId}`, start: 1, end: 14 },
      { kind: 'cl', number: 42, raw: '!42', start: 15, end: 18 },
    ])
    expect(parseRefs(`!${publicId}x`).some(token => token.kind === 'cl')).toBe(false)
  })

  it('parses a user reference', () => {
    const tokens = parseRefs('cc @octocat')
    expect(tokens.some((t) => t.kind === 'user' && t.username === 'octocat')).toBe(true)
  })

  it('parses a thread reference', () => {
    const tokens = parseRefs('see thr_abc123')
    expect(tokens.some((t) => t.kind === 'thread' && t.threadId === 'thr_abc123')).toBe(true)
  })

  it('parses a plausible short sha (has both a letter and a digit)', () => {
    const tokens = parseRefs('fixed in a3f81c2')
    expect(tokens.some((t) => t.kind === 'sha' && t.sha === 'a3f81c2')).toBe(true)
  })

  it('rejects a short-sha-shaped token with no digits as illegal (falls back to plain)', () => {
    const tokens = parseRefs('deadbeef')
    expect(tokens.every((t) => t.kind === 'plain')).toBe(true)
  })

  it('does not treat an email local part as a reference (no identifier boundary)', () => {
    const tokens = parseRefs('rafael@example.com')
    expect(tokens).toEqual([
      { kind: 'plain', raw: 'rafael@example.com', text: 'rafael@example.com', start: 0, end: 18 },
    ])
  })

  it('allows CJK-adjacent references (no ASCII boundary required against CJK)', () => {
    const tokens = parseRefs('中文!1208')
    expect(tokens.some((t) => t.kind === 'cl' && t.number === 1208)).toBe(true)
  })

  it('preserves lossless plain-text spans around references', () => {
    const text = 'before !1 after'
    const tokens = parseRefs(text)
    const rebuilt = tokens.map((t) => t.raw).join('')
    expect(rebuilt).toBe(text)
  })

  it('does not match !0 or #0 (no leading zero / zero number)', () => {
    const tokens = parseRefs('!0 #0')
    expect(tokens.every((t) => t.kind === 'plain')).toBe(true)
  })

  it('rejects CL/issue numbers outside Number.isSafeInteger', () => {
    const tokens = parseRefs('see !9007199254740993 and #9007199254740993')
    expect(tokens.every((t) => t.kind === 'plain')).toBe(true)
  })

  it('accepts the full Number.MAX_SAFE_INTEGER range for CL/issue refs', () => {
    const max = Number.MAX_SAFE_INTEGER
    const tokens = parseRefs(`see !${max}`)
    expect(tokens.some((t) => t.kind === 'cl' && t.number === max)).toBe(true)
  })

  it('keeps emails whose local part ends in punctuation as plain text', () => {
    const tokens = parseRefs('a+@example.com')
    expect(tokens.every((t) => t.kind === 'plain')).toBe(true)
    expect(tokens.map((t) => t.raw).join('')).toBe('a+@example.com')
  })

  it('still parses dotted standalone mentions as users', () => {
    const tokens = parseRefs('cc @octocat.com')
    expect(tokens.some((t) => t.kind === 'user' && t.username === 'octocat')).toBe(true)
  })
})

describe('formatDiffStat', () => {
  it('formats a stat with the canonical minus sign', () => {
    expect(formatDiffStat(3, 5)).toBe('+3 \u22125')
  })

  it('formats a zero/zero stat', () => {
    expect(formatDiffStat(0, 0)).toBe('+0 \u22120')
  })

  it('throws a RangeError for a negative added count', () => {
    expect(() => formatDiffStat(-1, 0)).toThrow(RangeError)
  })

  it('throws a RangeError for a negative deleted count', () => {
    expect(() => formatDiffStat(0, -1)).toThrow(RangeError)
  })

  it('throws a RangeError for a non-safe-integer input', () => {
    expect(() => formatDiffStat(Number.MAX_SAFE_INTEGER + 1, 0)).toThrow(RangeError)
    expect(() => formatDiffStat(1.5, 0)).toThrow(RangeError)
    expect(() => formatDiffStat(Number.NaN, 0)).toThrow(RangeError)
  })
})
