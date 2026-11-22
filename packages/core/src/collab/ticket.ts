/**
 * megaui:libs/mega/collab/ticket.ts@0ff3a9d
 *
 * Short-lived collab WS tickets.
 * Browser JS gets an HMAC ticket instead of the HttpOnly session token.
 *
 * v1 (docs): mega-collab.v1.<userId>.<expMs>.<base64url-hmac>
 *   HMAC covers `userId.expMs`
 * v2 (channel rooms, megaui-only / ADR-RT-03):
 *   mega-collab.v2.<userId>.<expMs>.<roomName>.<base64url-hmac>
 *   HMAC covers `userId.expMs.roomName`
 *
 * FSL-134: the former enterprise v3 format is gone. Tickets carry no
 * enterprise metadata; a v3-prefixed token is not a collab ticket and never
 * verifies.
 *
 * Pure functions only: the caller supplies `secret` explicitly (no implicit
 * `process.env` reads). This module is Node-only (`node:crypto`); import it
 * via `@megaui/core/collab/ticket`, not the package root barrel, so browser
 * bundles never pull in Node builtins.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const COLLAB_TICKET_PREFIX = 'mega-collab.v1.' as const
export const COLLAB_TICKET_PREFIX_V2 = 'mega-collab.v2.' as const
export const COLLAB_TICKET_TTL_MS = 3_600_000

export interface VerifiedCollabTicket {
  userId: string
  roomName: string | null
}

export interface MintCollabTicketOptions {
  nowMs?: number
  ttlMs?: number
  roomName?: string
}

function signBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function requireNonEmpty(value: string, label: string): string {
  if (!value) {
    throw new Error(`collab ticket ${label} must be a non-empty string`)
  }
  return value
}

/** Mint a collab-only ticket. Omit `roomName` for v1; pass it for v2. */
export function mintCollabTicket(
  userId: string,
  secret: string,
  options?: MintCollabTicketOptions,
): string {
  requireNonEmpty(secret, 'secret')
  requireNonEmpty(userId, 'userId')
  const nowMs = options?.nowMs ?? Date.now()
  const ttlMs = options?.ttlMs ?? COLLAB_TICKET_TTL_MS
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('collab ticket nowMs and ttlMs must be positive safe integers')
  }
  const expMs = nowMs + ttlMs
  const roomName = options?.roomName
  if (roomName !== undefined) {
    requireNonEmpty(roomName, 'roomName')
    const body = `${userId}.${expMs}.${roomName}`
    return `${COLLAB_TICKET_PREFIX_V2}${body}.${signBody(body, secret)}`
  }
  const body = `${userId}.${expMs}`
  return `${COLLAB_TICKET_PREFIX}${body}.${signBody(body, secret)}`
}

function parseSignedBody(
  token: string,
  prefix: string,
  secret: string,
): string | null {
  if (!token.startsWith(prefix)) return null
  const rest = token.slice(prefix.length)
  const lastDot = rest.lastIndexOf('.')
  if (lastDot <= 0) return null
  const body = rest.slice(0, lastDot)
  const sig = rest.slice(lastDot + 1)
  if (!body || !sig) return null
  if (!safeEqual(sig, signBody(body, secret))) return null
  return body
}

function parseExpMs(raw: string): number | null {
  const expMs = Number(raw)
  if (!Number.isSafeInteger(expMs)) return null
  return expMs
}

/**
 * Verify ticket and return `{ userId, roomName }`, or null if invalid/expired.
 * v1 yields `roomName: null`. Non-ticket strings return null so callers can
 * fall back to session lookup.
 */
export function verifyCollabTicket(
  token: string,
  secret: string,
  options?: { nowMs?: number },
): VerifiedCollabTicket | null {
  const trimmed = token.trim()
  if (!secret) return null
  const nowMs = options?.nowMs ?? Date.now()

  const v2Body = parseSignedBody(trimmed, COLLAB_TICKET_PREFIX_V2, secret)
  if (v2Body) {
    const firstDot = v2Body.indexOf('.')
    if (firstDot <= 0) return null
    const userId = v2Body.slice(0, firstDot)
    const afterUser = v2Body.slice(firstDot + 1)
    const secondDot = afterUser.indexOf('.')
    if (secondDot <= 0) return null
    const expMs = parseExpMs(afterUser.slice(0, secondDot))
    const roomName = afterUser.slice(secondDot + 1)
    if (!userId || !roomName || expMs === null || expMs < nowMs) return null
    return { userId, roomName }
  }

  const v1Body = parseSignedBody(trimmed, COLLAB_TICKET_PREFIX, secret)
  if (!v1Body) return null
  const sep = v1Body.lastIndexOf('.')
  if (sep <= 0) return null
  const userId = v1Body.slice(0, sep)
  const expMs = parseExpMs(v1Body.slice(sep + 1))
  if (!userId || expMs === null || expMs < nowMs) return null
  return { userId, roomName: null }
}

export function isCollabTicket(token: string): boolean {
  const trimmed = token.trim()
  return trimmed.startsWith(COLLAB_TICKET_PREFIX) || trimmed.startsWith(COLLAB_TICKET_PREFIX_V2)
}
