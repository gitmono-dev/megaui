/**
 * megaui:libs/mega/refs.ts@0ff3a9d
 *
 * Prose entity-reference tokenizer + diff-stat formatter.
 *
 * Intentional hardening vs upstream (documented for GC-03 review):
 * - CL/issue numbers must be Number.isSafeInteger (reject rounded / Infinity).
 * - `@user` matches that continue into an email domain (e.g. `a+@example.com`)
 *   stay plain text.
 */

export type RefKind = 'cl' | 'issue' | 'user' | 'thread' | 'sha' | 'plain'

interface RefTokenBase {
  raw: string
  start: number
  end: number
}

export interface CLRefToken extends RefTokenBase {
  kind: 'cl'
  number: number
}

export interface IssueRefToken extends RefTokenBase {
  kind: 'issue'
  number: number
}

export interface UserRefToken extends RefTokenBase {
  kind: 'user'
  username: string
}

export interface ThreadRefToken extends RefTokenBase {
  kind: 'thread'
  threadId: string
}

export interface ShaRefToken extends RefTokenBase {
  kind: 'sha'
  sha: string
}

export interface PlainRefToken extends RefTokenBase {
  kind: 'plain'
  text: string
}

export type RefToken = CLRefToken | IssueRefToken | UserRefToken | ThreadRefToken | ShaRefToken | PlainRefToken

const candidatePattern = /!([1-9]\d*)|#([1-9]\d*)|@([A-Za-z][A-Za-z0-9_-]*)|(thr_[A-Za-z0-9][A-Za-z0-9_-]*)|([a-f0-9]{7,40})/gi
const asciiIdentifierCharacter = /[A-Za-z0-9_-]/

function hasIdentifierBoundary(text: string, start: number, end: number): boolean {
  return !asciiIdentifierCharacter.test(text[start - 1] ?? '') && !asciiIdentifierCharacter.test(text[end] ?? '')
}

function isPlausibleShortSha(value: string): boolean {
  return /[a-f]/i.test(value) && /\d/.test(value)
}

function parseSafeRefNumber(digits: string): number | undefined {
  const value = Number(digits)
  if (!Number.isSafeInteger(value) || value < 1) return undefined
  return value
}

function createReference(
  match: RegExpExecArray,
  text: string,
): Exclude<RefToken, PlainRefToken> | undefined {
  const raw = match[0]
  const start = match.index
  const end = start + raw.length

  if (match[1]) {
    const number = parseSafeRefNumber(match[1])
    if (number === undefined) return undefined
    return { kind: 'cl', raw, start, end, number }
  }

  if (match[2]) {
    const number = parseSafeRefNumber(match[2])
    if (number === undefined) return undefined
    return { kind: 'issue', raw, start, end, number }
  }

  if (match[3]) {
    // Keep emails as plain text only when there is a local-part character
    // immediately before `@` (e.g. `a+@example.com`). Standalone mentions
    // like `@octocat.com` remain user references.
    const prev = text[start - 1] ?? ''
    if (
      prev !== '' &&
      /[A-Za-z0-9_+.-]/.test(prev) &&
      /^\.[A-Za-z0-9][A-Za-z0-9.-]*/.test(text.slice(end))
    ) {
      return undefined
    }
    return { kind: 'user', raw, start, end, username: match[3] }
  }

  if (match[4]) {
    return { kind: 'thread', raw, start, end, threadId: match[4] }
  }

  if (match[5]) {
    if (!isPlausibleShortSha(match[5])) {
      return undefined
    }

    return { kind: 'sha', raw, start, end, sha: match[5].toLowerCase() }
  }

  return undefined
}

/**
 * Splits prose into typed entity references and lossless plain-text spans.
 * ASCII-word boundaries avoid treating emails and identifiers as references,
 * while allowing punctuation- and CJK-adjacent references such as `中文!1208`.
 */
export function parseRefs(text: string): RefToken[] {
  const tokens: RefToken[] = []
  let plainStart = 0

  candidatePattern.lastIndex = 0
  for (let match = candidatePattern.exec(text); match; match = candidatePattern.exec(text)) {
    const start = match.index
    const end = start + match[0].length
    const reference = createReference(match, text)

    if (!reference || !hasIdentifierBoundary(text, start, end)) {
      continue
    }

    if (plainStart < start) {
      tokens.push({ kind: 'plain', raw: text.slice(plainStart, start), text: text.slice(plainStart, start), start: plainStart, end: start })
    }

    tokens.push(reference)
    plainStart = end
  }

  if (plainStart < text.length || tokens.length === 0) {
    tokens.push({ kind: 'plain', raw: text.slice(plainStart), text: text.slice(plainStart), start: plainStart, end: text.length })
  }

  return tokens
}

/** Formats a diff stat with the canonical U+2212 minus sign. */
export function formatDiffStat(added: number, deleted: number): string {
  if (!Number.isSafeInteger(added) || !Number.isSafeInteger(deleted) || added < 0 || deleted < 0) {
    throw new RangeError('Diff stat values must be non-negative safe integers')
  }

  return `+${added} −${deleted}`
}
