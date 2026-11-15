/**
 * megaui:libs/mega/unread-math.ts@0ff3a9d
 *
 * Pure chat mention/unread-watermark helpers (client-safe — no DB imports):
 * `@`-mention extraction (segments or Lexical `mega-ref` JSON body),
 * unread-message slicing against a read watermark, and monotonic watermark
 * merge (ADR-CE-05).
 */

import type { ChatMessage, User } from './types'

/** Lowercase username/id keys extracted from @user segments or Lexical mega-ref user nodes. */
export function extractMentionKeys(message: Pick<ChatMessage, 'segments' | 'body'>): string[] {
  const keys = new Set<string>()
  for (const segment of message.segments ?? []) {
    if (segment.type === 'user-ref' && segment.username.trim()) {
      keys.add(segment.username.trim().toLowerCase())
    }
  }
  if (keys.size > 0) return [...keys]
  if (!message.body) return []
  try {
    const parsed = JSON.parse(message.body) as { root?: unknown }
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const record = node as Record<string, unknown>
      if (record.type === 'mega-ref' && record.ref && typeof record.ref === 'object') {
        const ref = record.ref as { kind?: string; targetId?: string; targetTitle?: string }
        if (ref.kind === 'user') {
          const title = (ref.targetTitle ?? '').replace(/^@/, '').trim()
          const id = (ref.targetId ?? '').trim()
          if (title) keys.add(title.toLowerCase())
          if (id) keys.add(id.toLowerCase())
        }
      }
      if (Array.isArray(record.children)) record.children.forEach(walk)
    }
    walk(parsed.root)
  } catch {
    // Ignore malformed Lexical JSON.
  }
  return [...keys]
}

/** True when message segments (or Lexical body) @-mention the actor. */
export function messageMentionsActor(
  message: Pick<ChatMessage, 'segments' | 'body'>,
  actor: Pick<User, 'id' | 'username'>,
): boolean {
  const usernames = new Set(
    [actor.username, actor.id].filter(Boolean).map((value) => value.toLowerCase()),
  )
  return extractMentionKeys(message).some((key) => usernames.has(key))
}

/**
 * Messages strictly after the watermark in chronological order.
 * No watermark → every message is unread.
 */
export function messagesAfterWatermark(
  messages: readonly ChatMessage[],
  lastReadMessageId: string | undefined,
): ChatMessage[] {
  const ordered = [...messages].sort((left, right) => {
    const byTime = left.createdAt.localeCompare(right.createdAt)
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id)
  })
  if (!lastReadMessageId) return ordered
  const index = ordered.findIndex((message) => message.id === lastReadMessageId)
  if (index < 0) return ordered
  return ordered.slice(index + 1)
}

/** Prefer the chronologically later message id (ADR-CE-05 monotonic watermark). */
export function maxMessageWatermark(
  messages: readonly ChatMessage[],
  currentId: string | undefined,
  candidateId: string | undefined,
): string | undefined {
  if (!candidateId) return currentId
  if (!currentId) return candidateId
  if (currentId === candidateId) return currentId
  const byId = new Map(messages.map((message) => [message.id, message]))
  const current = byId.get(currentId)
  const candidate = byId.get(candidateId)
  if (!current) return candidateId
  if (!candidate) return currentId
  const cmp = current.createdAt.localeCompare(candidate.createdAt)
  if (cmp < 0) return candidateId
  if (cmp > 0) return currentId
  return currentId.localeCompare(candidateId) >= 0 ? currentId : candidateId
}
