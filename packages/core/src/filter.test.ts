import { describe, expect, it } from 'vitest'
import { matchesCLFilter, matchesIssueFilter, parseQuery, serializeQuery } from './filter'
import type { CL, Issue, User } from './types'

const user = (id: string, username: string): User => ({
  id,
  username,
  displayName: username,
  avatarInitials: username.slice(0, 2).toUpperCase(),
})

const baseIssue: Issue = {
  id: 'issue-1',
  number: 1,
  title: 'Fix the thing',
  state: 'open',
  priority: 'P1',
  labels: [{ id: 'bug', name: 'bug', color: '#f00' }],
  linkedCLs: [],
  reactions: [],
  author: user('u1', 'alice'),
  assignees: [user('u2', 'bob')],
  packageId: 'pkg-a',
  commentCount: 0,
  watcherIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const baseCL: CL = {
  id: 'cl-1',
  publicId: 'Q7rE8kzpY_1A',
  number: 10,
  title: 'Add feature',
  state: 'ready',
  packageId: 'pkg-a',
  author: user('u1', 'alice'),
  reviewers: [{ user: user('u3', 'carol'), verdict: 'pending' }],
  additions: 1,
  deletions: 0,
  files: [],
  revisions: [],
  ci: 'passing',
  merge: 'needs-review',
  atomic: true,
  crossPackage: [],
  linkedIssues: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('parseQuery', () => {
  it('parses an empty/whitespace query into an empty filter', () => {
    expect(parseQuery('')).toEqual({})
    expect(parseQuery('   ')).toEqual({})
  })

  it('parses is:, priority range, pkg:*, label:, sort:, and actor terms', () => {
    expect(parseQuery('is:open,closed')).toEqual({ states: ['open', 'closed'] })
    expect(parseQuery('priority:P1..P3')).toEqual({ priority: { min: 'P1', max: 'P3' } })
    expect(parseQuery('pkg:*')).toEqual({ packageIds: 'all' })
    expect(parseQuery('label:bug,ui')).toEqual({ labels: ['bug', 'ui'] })
    expect(parseQuery('sort:updated-desc')).toEqual({ sort: 'updated-desc' })
    expect(parseQuery('assignee:@me')).toEqual({ assignee: '@me' })
    expect(parseQuery('author:alice')).toEqual({ author: 'alice' })
    expect(parseQuery('reviewer:carol')).toEqual({ reviewer: 'carol' })
  })

  it('rejects an inverted priority range and keeps it as searchable text', () => {
    expect(parseQuery('priority:P3..P1')).toEqual({ text: 'priority:P3..P1' })
  })

  it('rejects an unknown sort value and keeps it as text', () => {
    expect(parseQuery('sort:bogus')).toEqual({ text: 'sort:bogus' })
  })

  it('falls back unknown is: values to plain text', () => {
    expect(parseQuery('is:bogus-state')).toEqual({ text: 'is:bogus-state' })
  })

  it('mixes structured terms with free text', () => {
    expect(parseQuery('is:open memory leak')).toEqual({ states: ['open'], text: 'memory leak' })
  })

  it('treats a bare colon-less token, or a trailing-colon token, as text', () => {
    expect(parseQuery('hello')).toEqual({ text: 'hello' })
    expect(parseQuery('is:')).toEqual({ text: 'is:' })
  })
})

describe('serializeQuery', () => {
  it('round-trips a fully structured filter', () => {
    const filter = parseQuery('is:open priority:P1..P3 pkg:* label:bug assignee:@me sort:updated-desc hello world')
    expect(serializeQuery(filter)).toBe('is:open priority:P1..P3 pkg:* label:bug assignee:@me sort:updated-desc hello world')
  })

  it('serializes an empty filter to an empty string', () => {
    expect(serializeQuery({})).toBe('')
  })

  it('serializes priority values-list form', () => {
    expect(serializeQuery({ priority: { values: ['P0', 'P2'] } })).toBe('priority:P0,P2')
  })
})

describe('matchesIssueFilter', () => {
  it('matches an issue with no filter', () => {
    expect(matchesIssueFilter(baseIssue, {}, 'u1')).toBe(true)
  })

  it('filters by state, priority range, package, and label', () => {
    expect(matchesIssueFilter(baseIssue, { states: ['closed'] }, 'u1')).toBe(false)
    expect(matchesIssueFilter(baseIssue, { priority: { min: 'P2' } }, 'u1')).toBe(false)
    expect(matchesIssueFilter(baseIssue, { packageIds: ['pkg-b'] }, 'u1')).toBe(false)
    expect(matchesIssueFilter(baseIssue, { labels: ['missing'] }, 'u1')).toBe(false)
  })

  it('resolves @me against the current user id', () => {
    expect(matchesIssueFilter(baseIssue, { author: '@me' }, 'u1')).toBe(true)
    expect(matchesIssueFilter(baseIssue, { author: '@me' }, 'u2')).toBe(false)
  })

  it('matches free text case-insensitively against title and body', () => {
    expect(matchesIssueFilter(baseIssue, { text: 'THE THING' }, 'u1')).toBe(true)
    expect(matchesIssueFilter(baseIssue, { text: 'nope' }, 'u1')).toBe(false)
  })
})

describe('matchesCLFilter', () => {
  it('matches a CL with no filter', () => {
    expect(matchesCLFilter(baseCL, {}, 'u1')).toBe(true)
    expect(matchesCLFilter(baseCL, { text: `!${baseCL.publicId}` }, 'u1')).toBe(true)
  })

  it('matches cross-package ids via crossPackage', () => {
    const cl = { ...baseCL, crossPackage: ['pkg-b'] }
    expect(matchesCLFilter(cl, { packageIds: ['pkg-b'] }, 'u1')).toBe(true)
    expect(matchesCLFilter(cl, { packageIds: ['pkg-c'] }, 'u1')).toBe(false)
  })

  it('matches reviewer by username with @me resolution', () => {
    expect(matchesCLFilter(baseCL, { reviewer: 'carol' }, 'u1')).toBe(true)
    expect(matchesCLFilter(baseCL, { reviewer: '@me' }, 'u3')).toBe(true)
    expect(matchesCLFilter(baseCL, { reviewer: '@me' }, 'u1')).toBe(false)
  })
})
