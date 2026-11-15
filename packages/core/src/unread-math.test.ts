import { describe, expect, it } from 'vitest'
import {
  extractMentionKeys,
  maxMessageWatermark,
  messageMentionsActor,
  messagesAfterWatermark,
} from './unread-math'
import type { ChatMessage, User } from './types'

const author: User = { id: 'u1', username: 'alice', displayName: 'Alice', avatarInitials: 'AL' }

function message(id: string, createdAt: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    author,
    segments: [],
    reactions: [],
    createdAt,
    ...overrides,
  }
}

describe('extractMentionKeys', () => {
  it('returns an empty array for a message with no segments/body (空树)', () => {
    expect(extractMentionKeys(message('m1', '2026-01-01T00:00:00.000Z'))).toEqual([])
  })

  it('extracts lowercase usernames from user-ref segments', () => {
    const msg = message('m1', '2026-01-01T00:00:00.000Z', {
      segments: [{ type: 'user-ref', username: 'Octocat' }],
    })
    expect(extractMentionKeys(msg)).toEqual(['octocat'])
  })

  it('ignores blank-username user-ref segments', () => {
    const msg = message('m1', '2026-01-01T00:00:00.000Z', {
      segments: [{ type: 'user-ref', username: '   ' }],
    })
    expect(extractMentionKeys(msg)).toEqual([])
  })

  it('falls back to walking a Lexical mega-ref user node in body JSON', () => {
    const body = JSON.stringify({
      root: {
        type: 'root',
        children: [
          { type: 'mega-ref', ref: { kind: 'user', targetTitle: '@bob', targetId: 'u2' } },
        ],
      },
    })
    const msg = message('m1', '2026-01-01T00:00:00.000Z', { body })
    expect(extractMentionKeys(msg).sort()).toEqual(['bob', 'u2'])
  })

  it('ignores malformed Lexical JSON bodies', () => {
    const msg = message('m1', '2026-01-01T00:00:00.000Z', { body: 'not json' })
    expect(extractMentionKeys(msg)).toEqual([])
  })

  it('prefers structured segments over the Lexical body walk', () => {
    const body = JSON.stringify({ root: { type: 'root', children: [{ type: 'mega-ref', ref: { kind: 'user', targetId: 'someone-else' } }] } })
    const msg = message('m1', '2026-01-01T00:00:00.000Z', {
      segments: [{ type: 'user-ref', username: 'octocat' }],
      body,
    })
    expect(extractMentionKeys(msg)).toEqual(['octocat'])
  })
})

describe('messageMentionsActor', () => {
  it('matches by username or id, case-insensitively', () => {
    const msg = message('m1', '2026-01-01T00:00:00.000Z', {
      segments: [{ type: 'user-ref', username: 'Octocat' }],
    })
    expect(messageMentionsActor(msg, { id: 'other-id', username: 'octocat' })).toBe(true)
    expect(messageMentionsActor(msg, { id: 'octocat', username: 'different' })).toBe(true)
    expect(messageMentionsActor(msg, { id: 'nope', username: 'nope' })).toBe(false)
  })
})

describe('messagesAfterWatermark', () => {
  const messages = [
    message('m1', '2026-01-01T00:00:00.000Z'),
    message('m2', '2026-01-02T00:00:00.000Z'),
    message('m3', '2026-01-03T00:00:00.000Z'),
  ]

  it('returns everything for an empty message list (空树)', () => {
    expect(messagesAfterWatermark([], undefined)).toEqual([])
    expect(messagesAfterWatermark([], 'missing')).toEqual([])
  })

  it('returns every message (chronologically ordered) when there is no watermark', () => {
    const shuffled = [messages[2]!, messages[0]!, messages[1]!]
    expect(messagesAfterWatermark(shuffled, undefined)).toEqual(messages)
  })

  it('returns messages strictly after the watermark', () => {
    expect(messagesAfterWatermark(messages, 'm1')).toEqual([messages[1], messages[2]])
  })

  it('returns everything when the watermark id is not found (非规则/stale watermark)', () => {
    expect(messagesAfterWatermark(messages, 'unknown-id')).toEqual(messages)
  })

  it('returns an empty array when the watermark is the last message', () => {
    expect(messagesAfterWatermark(messages, 'm3')).toEqual([])
  })

  it('breaks createdAt ties by id for determinism', () => {
    const tied = [
      message('b', '2026-01-01T00:00:00.000Z'),
      message('a', '2026-01-01T00:00:00.000Z'),
    ]
    expect(messagesAfterWatermark(tied, undefined).map((m) => m.id)).toEqual(['a', 'b'])
  })
})

describe('maxMessageWatermark', () => {
  const messages = [
    message('m1', '2026-01-01T00:00:00.000Z'),
    message('m2', '2026-01-02T00:00:00.000Z'),
  ]

  it('returns the candidate when there is no current watermark', () => {
    expect(maxMessageWatermark(messages, undefined, 'm1')).toBe('m1')
  })

  it('returns the current watermark when there is no candidate', () => {
    expect(maxMessageWatermark(messages, 'm1', undefined)).toBe('m1')
  })

  it('returns the chronologically later of the two ids', () => {
    expect(maxMessageWatermark(messages, 'm1', 'm2')).toBe('m2')
    expect(maxMessageWatermark(messages, 'm2', 'm1')).toBe('m2')
  })

  it('returns the candidate id if the current id is unknown (非规则 input)', () => {
    expect(maxMessageWatermark(messages, 'unknown', 'm1')).toBe('m1')
  })

  it('returns the current id if the candidate id is unknown', () => {
    expect(maxMessageWatermark(messages, 'm1', 'unknown')).toBe('m1')
  })

  it('is idempotent when current equals candidate', () => {
    expect(maxMessageWatermark(messages, 'm1', 'm1')).toBe('m1')
  })
})
