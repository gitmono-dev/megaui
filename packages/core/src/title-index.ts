/**
 * megaui:libs/mega/title-index.ts@0ff3a9d
 *
 * Wikilink/entity title index used by `[[...]]` autocomplete and CE-42
 * linkify (`linkify-plain.ts`).
 *
 * Intentional diff vs upstream (GC-03): the upstream source built the index
 * directly from `libs/mega/fixtures/*` (a hard fixture-data coupling that
 * would make `core` a non-leaf package once fixtures move to `apps/web` /
 * `packages/engine`). This port takes the doc/issue/CL/user rows as plain
 * data (`TitleIndexSource`) so the index builder stays a pure function with
 * no dependency on any particular data source — callers (mock service,
 * future `GET /api/mega/docs/title-index` route) supply the rows.
 */

import type { CL, Doc, Issue, User } from './types'

export type TitleIndexEntry = {
  kind: 'doc' | 'issue' | 'cl' | 'user'
  targetTitle: string
  targetId: string
  detail?: string
}

export interface TitleIndexSource {
  docs?: readonly Pick<Doc, 'id' | 'title'>[]
  issues?: readonly Pick<Issue, 'number' | 'title'>[]
  cls?: readonly Pick<CL, 'number' | 'title'>[]
  users?: readonly Pick<User, 'username' | 'displayName'>[]
}

/** Builds a title index from workspace rows (docs/issues/CLs/users). */
export function buildTitleIndex(source: TitleIndexSource): TitleIndexEntry[] {
  const docs = (source.docs ?? []).map((doc) => ({
    kind: 'doc' as const,
    targetTitle: doc.title,
    targetId: doc.id,
    detail: 'doc',
  }))
  const issues = (source.issues ?? []).map((issue) => ({
    kind: 'issue' as const,
    targetTitle: issue.title,
    targetId: String(issue.number),
    detail: `#${issue.number}`,
  }))
  const cls = (source.cls ?? []).map((cl) => ({
    kind: 'cl' as const,
    targetTitle: cl.title,
    targetId: String(cl.number),
    detail: `!${cl.number}`,
  }))
  const users = (source.users ?? []).map((user) => ({
    kind: 'user' as const,
    targetTitle: user.displayName,
    targetId: user.username,
    detail: `@${user.username}`,
  }))
  return [...docs, ...issues, ...cls, ...users]
}

/** Case-insensitive substring filter over a title index. */
export function searchTitleIndex(entries: readonly TitleIndexEntry[], query: string, limit = 8): TitleIndexEntry[] {
  const needle = query.trim().toLowerCase()
  const matched = needle
    ? entries.filter((entry) =>
      entry.targetTitle.toLowerCase().includes(needle)
      || entry.targetId.toLowerCase().includes(needle)
      || (entry.detail?.toLowerCase().includes(needle) ?? false),
    )
    : entries
  return matched.slice(0, limit)
}
