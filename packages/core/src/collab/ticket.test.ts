import { describe, expect, it } from 'vitest'
import {
  COLLAB_TICKET_PREFIX,
  COLLAB_TICKET_PREFIX_V2,
  COLLAB_TICKET_PREFIX_V3,
  COLLAB_TICKET_V3_MAX_TTL_MS,
  isCollabTicket,
  mintCollabTicket,
  verifyCollabTicket,
} from './ticket'

const SECRET = 'test-secret-do-not-use-in-prod'

describe('mintCollabTicket', () => {
  it('mints a ticket with the expected prefix and userId', () => {
    const ticket = mintCollabTicket('user-1', SECRET, { nowMs: 1000 })
    expect(ticket.startsWith(COLLAB_TICKET_PREFIX)).toBe(true)
    // mega-collab . v1 . userId . expMs . sig
    expect(ticket.split('.')).toHaveLength(5)
  })

  it('mints a ticket that verifies back to the same userId', () => {
    const ticket = mintCollabTicket('user-42', SECRET, { nowMs: 1000 })
    expect(verifyCollabTicket(ticket, SECRET, { nowMs: 1000 })).toEqual({
      userId: 'user-42',
      roomName: null,
    })
  })

  it('honors a custom ttlMs', () => {
    const ticket = mintCollabTicket('user-1', SECRET, { nowMs: 0, ttlMs: 10 })
    expect(verifyCollabTicket(ticket, SECRET, { nowMs: 5 })).toEqual({
      userId: 'user-1',
      roomName: null,
    })
    expect(verifyCollabTicket(ticket, SECRET, { nowMs: 11 })).toBeNull()
  })

  it('rejects an empty secret when minting (fail closed)', () => {
    expect(() => mintCollabTicket('user-1', '')).toThrow(/non-empty string/)
  })

  it('rejects an empty userId when minting (fail closed)', () => {
    expect(() => mintCollabTicket('', SECRET)).toThrow(/non-empty string/)
  })
})

describe('verifyCollabTicket boundaries', () => {
  it('rejects an expired ticket (nowMs strictly past expMs)', () => {
    const ticket = mintCollabTicket('user-1', SECRET, { nowMs: 0, ttlMs: 1000 })
    expect(verifyCollabTicket(ticket, SECRET, { nowMs: 1001 })).toBeNull()
    expect(verifyCollabTicket(ticket, SECRET, { nowMs: 999 })).toEqual({
      userId: 'user-1',
      roomName: null,
    })
  })

  it('accepts a ticket at the exact expiry boundary (expMs === nowMs)', () => {
    const ticket = mintCollabTicket('user-1', SECRET, { nowMs: 0, ttlMs: 1000 })
    expect(verifyCollabTicket(ticket, SECRET, { nowMs: 1000 })).toEqual({
      userId: 'user-1',
      roomName: null,
    })
  })

  it('rejects a tampered signature', () => {
    const ticket = mintCollabTicket('user-1', SECRET, { nowMs: 0 })
    const tampered = `${ticket.slice(0, -1)}${ticket.endsWith('A') ? 'B' : 'A'}`
    expect(verifyCollabTicket(tampered, SECRET, { nowMs: 0 })).toBeNull()
  })

  it('rejects a ticket verified with the wrong secret', () => {
    const ticket = mintCollabTicket('user-1', SECRET, { nowMs: 0 })
    expect(verifyCollabTicket(ticket, 'wrong-secret', { nowMs: 0 })).toBeNull()
  })

  it('rejects an empty secret', () => {
    const ticket = mintCollabTicket('user-1', SECRET, { nowMs: 0 })
    expect(verifyCollabTicket(ticket, '', { nowMs: 0 })).toBeNull()
  })

  it('rejects a non-ticket string so callers can fall back to session lookup', () => {
    expect(verifyCollabTicket('some-session-token', SECRET)).toBeNull()
    expect(verifyCollabTicket('', SECRET)).toBeNull()
  })

  it('rejects a ticket with a malformed body (missing segments)', () => {
    expect(verifyCollabTicket(`${COLLAB_TICKET_PREFIX}onlyonepart`, SECRET)).toBeNull()
    expect(verifyCollabTicket(`${COLLAB_TICKET_PREFIX}.sig`, SECRET)).toBeNull()
    expect(verifyCollabTicket(`${COLLAB_TICKET_PREFIX}userId.notanumber.sig`, SECRET)).toBeNull()
  })

  it('rejects a ticket whose userId segment is empty', () => {
    // body = "".expMs -> sep <= 0
    const forged = `${COLLAB_TICKET_PREFIX}.123.sig`
    expect(verifyCollabTicket(forged, SECRET)).toBeNull()
  })

  it('trims surrounding whitespace before checking the prefix', () => {
    const ticket = mintCollabTicket('user-1', SECRET, { nowMs: 0 })
    expect(verifyCollabTicket(`  ${ticket}  `, SECRET, { nowMs: 0 })).toEqual({
      userId: 'user-1',
      roomName: null,
    })
  })
})

describe('mint/verify/expire matrix (EG-13 AC1, supplements PK-01 coverage)', () => {
  const MINT_AT = 10_000
  const TTL = 60_000
  const EXPIRES_AT = MINT_AT + TTL

  it.each<{
    name: string
    checkAtMs: number
    secretForCheck?: string
    tamper?: boolean
    expectValid: boolean
  }>([
    { name: 'valid: verified immediately after minting', checkAtMs: MINT_AT, expectValid: true },
    {
      name: 'valid: verifier clock behind the minter clock (skew, still under TTL)',
      checkAtMs: MINT_AT - 5_000,
      expectValid: true,
    },
    {
      name: 'valid: checked one ms before the absolute expiry boundary',
      checkAtMs: EXPIRES_AT - 1,
      expectValid: true,
    },
    {
      name: 'valid: checked exactly at the absolute expiry boundary (inclusive)',
      checkAtMs: EXPIRES_AT,
      expectValid: true,
    },
    {
      name: 'invalid: checked one ms past the absolute expiry boundary',
      checkAtMs: EXPIRES_AT + 1,
      expectValid: false,
    },
    {
      name: 'invalid: forged signature',
      checkAtMs: MINT_AT,
      tamper: true,
      expectValid: false,
    },
    {
      name: 'invalid: verified with the wrong secret',
      checkAtMs: MINT_AT,
      secretForCheck: 'a-completely-different-secret',
      expectValid: false,
    },
  ])('$name', ({ checkAtMs, secretForCheck, tamper, expectValid }) => {
    const minted = mintCollabTicket('user-matrix', SECRET, { nowMs: MINT_AT, ttlMs: TTL })
    const candidate = tamper
      ? `${minted.slice(0, -1)}${minted.endsWith('A') ? 'B' : 'A'}`
      : minted
    const result = verifyCollabTicket(candidate, secretForCheck ?? SECRET, { nowMs: checkAtMs })
    expect(result).toEqual(expectValid ? { userId: 'user-matrix', roomName: null } : null)
  })
})

describe('isCollabTicket', () => {
  it('identifies well-formed and malformed collab tickets by prefix only', () => {
    expect(isCollabTicket(mintCollabTicket('user-1', SECRET))).toBe(true)
    expect(isCollabTicket(`${COLLAB_TICKET_PREFIX}garbage`)).toBe(true)
    expect(isCollabTicket(`${COLLAB_TICKET_PREFIX_V2}garbage`)).toBe(true)
    expect(isCollabTicket('random-session-token')).toBe(false)
    expect(isCollabTicket('')).toBe(false)
  })
})

describe('collab ticket v2 room binding (RT-03)', () => {
  const ROOM = 'collection:channel:abc'

  it('mints a v2 prefix when roomName is provided', () => {
    const ticket = mintCollabTicket('user-1', SECRET, { nowMs: 1000, roomName: ROOM })
    expect(ticket.startsWith(COLLAB_TICKET_PREFIX_V2)).toBe(true)
    expect(ticket.includes('mega-collab.v2')).toBe(true)
    expect(verifyCollabTicket(ticket, SECRET, { nowMs: 1000 })).toEqual({
      userId: 'user-1',
      roomName: ROOM,
    })
  })

  it('rejects an empty roomName when minting v2 (fail closed)', () => {
    expect(() => mintCollabTicket('user-1', SECRET, { roomName: '' })).toThrow(/non-empty string/)
  })

  it('rejects an expired v2 ticket, a tampered room, and a tampered signature', () => {
    const ticket = mintCollabTicket('user-1', SECRET, { nowMs: 0, ttlMs: 1000, roomName: ROOM })
    expect(verifyCollabTicket(ticket, SECRET, { nowMs: 1001 })).toBeNull()

    const swappedRoom = ticket.replace(ROOM, 'collection:channel:other')
    expect(verifyCollabTicket(swappedRoom, SECRET, { nowMs: 0 })).toBeNull()

    const tampered = `${ticket.slice(0, -1)}${ticket.endsWith('A') ? 'B' : 'A'}`
    expect(verifyCollabTicket(tampered, SECRET, { nowMs: 0 })).toBeNull()
  })
})

describe('collab ticket v3 enterprise binding (FS-16)', () => {
  const ROOM = 'collection:channel:enterprise'

  it('binds identity and epoch and caps the TTL at five minutes', () => {
    const ticket = mintCollabTicket('user-1', SECRET, {
      nowMs: 1_000,
      ttlMs: COLLAB_TICKET_V3_MAX_TTL_MS + 10_000,
      identityId: 'identity-1',
      authEpoch: 7,
    })
    expect(ticket.startsWith(COLLAB_TICKET_PREFIX_V3)).toBe(true)
    expect(verifyCollabTicket(ticket, SECRET, { nowMs: 1_000 })).toEqual({
      userId: 'user-1',
      identityId: 'identity-1',
      authEpoch: 7,
      roomName: null,
    })
    expect(verifyCollabTicket(ticket, SECRET, { nowMs: 1_000 + COLLAB_TICKET_V3_MAX_TTL_MS })).not.toBeNull()
    expect(verifyCollabTicket(ticket, SECRET, { nowMs: 1_000 + COLLAB_TICKET_V3_MAX_TTL_MS + 1 })).toBeNull()
  })

  it('supports collection binding and rejects incomplete enterprise metadata', () => {
    const ticket = mintCollabTicket('user-1', SECRET, {
      nowMs: 0,
      roomName: ROOM,
      identityId: 'identity-1',
      authEpoch: 1,
    })
    expect(verifyCollabTicket(ticket, SECRET, { nowMs: 0 })).toMatchObject({
      userId: 'user-1', identityId: 'identity-1', authEpoch: 1, roomName: ROOM,
    })
    expect(() => mintCollabTicket('user-1', SECRET, { identityId: 'identity-1' })).toThrow(/provided together/)
    expect(() => mintCollabTicket('user-1', SECRET, { authEpoch: 1 })).toThrow(/provided together/)
  })
})
