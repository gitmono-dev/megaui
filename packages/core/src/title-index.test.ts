import { describe, expect, it } from 'vitest'
import { buildTitleIndex, searchTitleIndex, type TitleIndexEntry } from './title-index'

describe('buildTitleIndex', () => {
  it('returns an empty index for an empty source (空树)', () => {
    expect(buildTitleIndex({})).toEqual([])
  })

  it('builds doc/issue/cl/user rows with the expected shape and detail', () => {
    const index = buildTitleIndex({
      docs: [{ id: 'doc-1', title: 'Runbook' }],
      issues: [{ number: 7, title: 'Bug' }],
      cls: [{ publicId: 'CLtx_AbCd_12', title: 'Feature' }],
      users: [{ username: 'octocat', displayName: 'Octo Cat' }],
    })
    expect(index).toEqual([
      { kind: 'doc', targetTitle: 'Runbook', targetId: 'doc-1', detail: 'doc' },
      { kind: 'issue', targetTitle: 'Bug', targetId: '7', detail: '#7' },
      { kind: 'cl', targetTitle: 'Feature', targetId: 'CLtx_AbCd_12', detail: 'CLtx_AbCd_12' },
      { kind: 'user', targetTitle: 'Octo Cat', targetId: 'octocat', detail: '@octocat' },
    ])
  })

  it('handles a super-long title (超长标题) without truncation', () => {
    const longTitle = 'A'.repeat(5000)
    const index = buildTitleIndex({ docs: [{ id: 'doc-long', title: longTitle }] })
    expect(index[0]?.targetTitle).toHaveLength(5000)
    expect(index[0]?.targetTitle).toBe(longTitle)
  })

  it('preserves a non-规则 (irregular) doc id / username as targetId verbatim', () => {
    const index = buildTitleIndex({
      docs: [{ id: 'doc/weird id with spaces!@#', title: 'Weird' }],
      users: [{ username: '中文用户名', displayName: '中文用户名' }],
    })
    expect(index[0]?.targetId).toBe('doc/weird id with spaces!@#')
    expect(index[1]?.targetId).toBe('中文用户名')
  })
})

describe('searchTitleIndex', () => {
  const entries: TitleIndexEntry[] = [
    { kind: 'doc', targetTitle: 'Runbook', targetId: 'doc-1', detail: 'doc' },
    { kind: 'issue', targetTitle: 'Bug fix', targetId: '7', detail: '#7' },
    { kind: 'cl', targetTitle: 'Feature work', targetId: 'CLtx_AbCd_12', detail: 'CLtx_AbCd_12' },
    { kind: 'user', targetTitle: 'Octo Cat', targetId: 'octocat', detail: '@octocat' },
  ]

  it('returns everything (up to the limit) for an empty query', () => {
    expect(searchTitleIndex(entries, '')).toEqual(entries)
    expect(searchTitleIndex([], '')).toEqual([])
  })

  it('matches case-insensitively against title, id, or detail', () => {
    expect(searchTitleIndex(entries, 'RUN')).toEqual([entries[0]])
    expect(searchTitleIndex(entries, '#7')).toEqual([entries[1]])
    expect(searchTitleIndex(entries, 'cltx_abcd_12')).toEqual([entries[2]])
    expect(searchTitleIndex(entries, 'octocat')).toEqual([entries[3]])
  })

  it('returns an empty array when nothing matches', () => {
    expect(searchTitleIndex(entries, 'zzz-no-match')).toEqual([])
  })

  it('respects the limit parameter', () => {
    expect(searchTitleIndex(entries, '', 2)).toHaveLength(2)
  })

  it('trims whitespace-only queries down to "match everything"', () => {
    expect(searchTitleIndex(entries, '   ')).toEqual(entries)
  })
})
