import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import {
  appendItem,
  appendThreadReply,
  removeItemById,
  removeThreadReply,
  replaceById,
  replaceThreadReply,
  setThreadResolved,
} from './optimistic'

// Local fixture shapes exercise the same fields `@megaui/core`'s real
// `InlineComment`/`InlineCommentReply` carry (author/body/createdAt/etc.),
// which is what proves the module's minimal structural types (see
// `optimistic.ts`'s module header) accept the richer real domain objects
// without a cast — but this test file itself has no `@megaui/core`
// dependency to import from (see same header note), so the fixtures are
// plain local shapes instead.
interface FixtureReply {
  id: string
  author: { id: string; username: string; displayName: string; avatarInitials: string }
  body: string
  createdAt: string
}

interface FixtureComment {
  id: string
  clNumber: number
  filePath: string
  line: number
  author: { id: string; username: string; displayName: string; avatarInitials: string }
  body: string
  createdAt: string
  resolvedAt?: string
  replies: readonly FixtureReply[]
}

function makeComment(overrides: Partial<FixtureComment> = {}): FixtureComment {
  return {
    id: 'ic-1',
    clNumber: 4,
    filePath: 'src/a.ts',
    line: 10,
    author: { id: 'u1', username: 'ann', displayName: 'Ann', avatarInitials: 'A' },
    body: 'looks good',
    createdAt: '2026-01-01T00:00:00.000Z',
    replies: [],
    ...overrides,
  }
}

function makeReply(overrides: Partial<FixtureReply> = {}): FixtureReply {
  return {
    id: 'reply-1',
    author: { id: 'u2', username: 'bob', displayName: 'Bob', avatarInitials: 'B' },
    body: 'thanks',
    createdAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  }
}

describe('appendItem', () => {
  it('appends to an existing list', () => {
    expect(appendItem([1, 2], 3)).toEqual([1, 2, 3])
  })

  it('starts a new list when the base list is undefined', () => {
    expect(appendItem(undefined, 1)).toEqual([1])
  })
})

describe('replaceById', () => {
  it('replaces the matching temporary entry', () => {
    const list = [{ id: 'tmp-1', v: 'a' }, { id: 'x', v: 'b' }]
    expect(replaceById(list, 'tmp-1', { id: 'real-1', v: 'a' })).toEqual([
      { id: 'real-1', v: 'a' },
      { id: 'x', v: 'b' },
    ])
  })

  it('leaves non-matching entries untouched', () => {
    const list = [{ id: 'x', v: 'b' }]
    expect(replaceById(list, 'tmp-1', { id: 'real-1', v: 'a' })).toEqual(list)
  })

  it('starts a singleton list when the base list is undefined', () => {
    expect(replaceById(undefined, 'tmp-1', { id: 'real-1', v: 'a' })).toEqual([{ id: 'real-1', v: 'a' }])
  })
})

describe('removeItemById', () => {
  it('removes the matching entry', () => {
    const list = [{ id: 'a' }, { id: 'b' }]
    expect(removeItemById(list, 'a')).toEqual([{ id: 'b' }])
  })

  it('returns undefined when the base list is undefined', () => {
    expect(removeItemById(undefined, 'a')).toBeUndefined()
  })
})

describe('thread reply helpers (CL-05)', () => {
  it('appendThreadReply appends only to the matching thread', () => {
    const other = makeComment({ id: 'ic-2' })
    const target = makeComment({ id: 'ic-1' })
    const reply = makeReply()
    const result = appendThreadReply([target, other], 'ic-1', reply)
    expect(result?.find((c) => c.id === 'ic-1')?.replies).toEqual([reply])
    expect(result?.find((c) => c.id === 'ic-2')?.replies).toEqual([])
  })

  it('replaceThreadReply swaps only the temporary reply in its thread', () => {
    const temp = makeReply({ id: 'tmp-reply' })
    const target = makeComment({ replies: [temp] })
    const real = makeReply({ id: 'real-reply' })
    const result = replaceThreadReply([target], 'ic-1', 'tmp-reply', real)
    expect(result?.[0]?.replies).toEqual([real])
  })

  it('removeThreadReply removes only the matching reply from its thread', () => {
    const keep = makeReply({ id: 'keep' })
    const drop = makeReply({ id: 'drop' })
    const target = makeComment({ replies: [keep, drop] })
    const result = removeThreadReply([target], 'ic-1', 'drop')
    expect(result?.[0]?.replies).toEqual([keep])
  })

  it('setThreadResolved sets resolvedAt on the matching thread only', () => {
    const target = makeComment({ id: 'ic-1' })
    const other = makeComment({ id: 'ic-2' })
    const result = setThreadResolved([target, other], 'ic-1', '2026-01-02T00:00:00.000Z')
    expect(result?.find((c) => c.id === 'ic-1')?.resolvedAt).toBe('2026-01-02T00:00:00.000Z')
    expect(result?.find((c) => c.id === 'ic-2')?.resolvedAt).toBeUndefined()
  })

  it('setThreadResolved can clear resolvedAt (unresolve toggle)', () => {
    const target = makeComment({ id: 'ic-1', resolvedAt: '2026-01-01T12:00:00.000Z' })
    const result = setThreadResolved([target], 'ic-1', undefined)
    expect(result?.[0]?.resolvedAt).toBeUndefined()
  })

  it('all thread helpers return undefined for an undefined comment list', () => {
    expect(appendThreadReply(undefined, 'ic-1', makeReply())).toBeUndefined()
    expect(replaceThreadReply(undefined, 'ic-1', 'tmp', makeReply())).toBeUndefined()
    expect(removeThreadReply(undefined, 'ic-1', 'r1')).toBeUndefined()
    expect(setThreadResolved(undefined, 'ic-1', undefined)).toBeUndefined()
  })
})

// UI-04 AC3 / GC-08: optimistic-update rollback-on-failure. These
// integration tests compose the pure helpers above with a real
// `QueryClient` to exercise the full snapshot -> optimistic apply ->
// failure -> rollback cycle a `useMutation({ onMutate, onError })` caller
// would run, proving the helpers are safe rollback building blocks (not
// just correct in isolation).
describe('rollback on failure (GC-08)', () => {
  const listKey = ['mega', 'issues', 7, 'comments'] as const

  function seedClient<T>(initial: T) {
    const client = new QueryClient()
    client.setQueryData(listKey, initial)
    return client
  }

  it('full-snapshot rollback restores the pre-mutation list after a failed append', () => {
    const original = [{ id: 'c1', body: 'first' }]
    const client = seedClient(original)

    // onMutate: snapshot + optimistic apply.
    const snapshot = client.getQueryData<typeof original>(listKey)
    const optimisticEntry = { id: 'tmp-1', body: 'pending...' }
    client.setQueryData(listKey, (old: typeof original | undefined) => appendItem(old, optimisticEntry))
    expect(client.getQueryData(listKey)).toEqual([...original, optimisticEntry])

    // onError: mutation failed server-side -> roll back to the snapshot.
    client.setQueryData(listKey, snapshot)
    expect(client.getQueryData(listKey)).toEqual(original)
    expect(client.getQueryData(listKey)).not.toEqual([...original, optimisticEntry])
  })

  it('surgical rollback removes only the failed optimistic entry, preserving concurrent cache writes', () => {
    const original = [{ id: 'c1', body: 'first' }]
    const client = seedClient(original)
    const optimisticEntry = { id: 'tmp-1', body: 'pending...' }

    client.setQueryData(listKey, (old: typeof original | undefined) => appendItem(old, optimisticEntry))
    // A concurrent, unrelated successful mutation lands in the cache before this one fails.
    const concurrentEntry = { id: 'c2', body: 'unrelated, already confirmed' }
    client.setQueryData(listKey, (old: typeof original | undefined) => appendItem(old, concurrentEntry))

    // onError: surgical rollback via id, not a full snapshot restore (which would drop c2).
    client.setQueryData(listKey, (old: typeof original | undefined) => removeItemById(old, 'tmp-1'))

    expect(client.getQueryData(listKey)).toEqual([original[0], concurrentEntry])
  })

  it('rolls back an optimistic thread-reply insert on failure', () => {
    const target = makeComment({ id: 'ic-1' })
    const client = seedClient([target])
    const tempReply = makeReply({ id: 'tmp-reply' })

    const snapshot = client.getQueryData<FixtureComment[]>(listKey)
    client.setQueryData(listKey, (old: FixtureComment[] | undefined) => appendThreadReply(old, 'ic-1', tempReply))
    expect(client.getQueryData<FixtureComment[]>(listKey)?.[0]?.replies).toEqual([tempReply])

    client.setQueryData(listKey, snapshot)
    expect(client.getQueryData<FixtureComment[]>(listKey)?.[0]?.replies).toEqual([])
  })

  it('rolls back an optimistic resolve toggle on failure', () => {
    const target = makeComment({ id: 'ic-1', resolvedAt: undefined })
    const client = seedClient([target])

    const snapshot = client.getQueryData<FixtureComment[]>(listKey)
    client.setQueryData(listKey, (old: FixtureComment[] | undefined) => setThreadResolved(old, 'ic-1', '2026-01-02T00:00:00.000Z'))
    expect(client.getQueryData<FixtureComment[]>(listKey)?.[0]?.resolvedAt).toBe('2026-01-02T00:00:00.000Z')

    client.setQueryData(listKey, snapshot)
    expect(client.getQueryData<FixtureComment[]>(listKey)?.[0]?.resolvedAt).toBeUndefined()
  })
})
