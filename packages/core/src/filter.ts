/**
 * megaui:libs/mega/filter.ts@0ff3a9d
 *
 * Compact workspace filter DSL: parse/serialize a query string into the
 * structured `Filter` shape, plus the single Issue/CL list predicates
 * (GC-02) so any consumer (mock service, client-side optimistic check,
 * future server route) matches identically.
 */

import {
  MEGA_CL_LABELS,
  MEGA_FILTER_SORTS,
  MEGA_ISSUE_PRIORITIES,
  MEGA_ISSUE_STATES,
  type CL,
  type CLState,
  type Filter,
  type FilterActor,
  type FilterSort,
  type Issue,
  type IssuePriority,
  type IssueState,
} from './types'

const states = new Set<string>([...MEGA_ISSUE_STATES, ...Object.keys(MEGA_CL_LABELS)])
const priorities = new Set<string>(MEGA_ISSUE_PRIORITIES)
const sorts = new Set<string>(MEGA_FILTER_SORTS)

const isPriority = (value: string): value is IssuePriority => priorities.has(value)
const isState = (value: string): value is IssueState | CLState => states.has(value)

function commaValues(value: string): string[] | undefined {
  const values = value.split(',')
  return values.length > 0 && values.every(Boolean) ? values : undefined
}

function parsePriority(value: string): Filter['priority'] | undefined {
  const range = value.split('..')
  if (
    range.length === 2
    && (range[0] || range[1])
    && (!range[0] || isPriority(range[0]))
    && (!range[1] || isPriority(range[1]))
  ) {
    if (
      range[0]
      && range[1]
      && MEGA_ISSUE_PRIORITIES.indexOf(range[0] as IssuePriority) > MEGA_ISSUE_PRIORITIES.indexOf(range[1] as IssuePriority)
    ) return undefined
    return {
      ...(range[0] ? { min: range[0] as IssuePriority } : {}),
      ...(range[1] ? { max: range[1] as IssuePriority } : {}),
    }
  }
  const values = commaValues(value)
  return values && values.every(isPriority) ? { values } : undefined
}

function serializePriority(priority: NonNullable<Filter['priority']>): string | undefined {
  if (priority.values?.length) return priority.values.join(',')
  if (priority.min || priority.max) return `${priority.min ?? ''}..${priority.max ?? ''}`
}

function serializeActor(key: 'assignee' | 'author' | 'reviewer', value: FilterActor | undefined): string | undefined {
  return value ? `${key}:${value}` : undefined
}

/** Parses the compact workspace filter DSL. Invalid terms deliberately stay searchable text. */
export function parseQuery(query: string): Filter {
  const text: string[] = []
  const result: Filter = {}

  for (const token of query.trim().split(/\s+/)) {
    if (!token) continue
    const separator = token.indexOf(':')
    if (separator < 1) {
      text.push(token)
      continue
    }

    const key = token.slice(0, separator)
    const value = token.slice(separator + 1)
    if (!value) {
      text.push(token)
      continue
    }

    if (key === 'is') {
      const values = commaValues(value)
      if (values?.every(isState)) result.states = values
      else text.push(token)
      continue
    }
    if (key === 'priority') {
      const priority = parsePriority(value)
      if (priority) result.priority = priority
      else text.push(token)
      continue
    }
    if (key === 'pkg') {
      if (value === '*') result.packageIds = 'all'
      else {
        const values = commaValues(value)
        if (values && !values.includes('*')) result.packageIds = values
        else text.push(token)
      }
      continue
    }
    if (key === 'label') {
      const values = commaValues(value)
      if (values) result.labels = values
      else text.push(token)
      continue
    }
    if (key === 'sort' && sorts.has(value)) {
      result.sort = value as FilterSort
      continue
    }
    if ((key === 'assignee' || key === 'author' || key === 'reviewer') && /^@?[\w-]+$/.test(value)) {
      result[key] = value as FilterActor
      continue
    }
    text.push(token)
  }

  if (text.length) result.text = text.join(' ')
  return result
}

/** Produces the canonical, URL-safe form of a structured workspace filter. */
export function serializeQuery(filter: Filter): string {
  const terms = [
    filter.states?.length ? `is:${filter.states.join(',')}` : undefined,
    filter.priority ? (() => {
      const value = serializePriority(filter.priority)
      return value ? `priority:${value}` : undefined
    })() : undefined,
    filter.packageIds === 'all' ? 'pkg:*' : filter.packageIds?.length ? `pkg:${filter.packageIds.join(',')}` : undefined,
    filter.labels?.length ? `label:${filter.labels.join(',')}` : undefined,
    serializeActor('assignee', filter.assignee),
    serializeActor('author', filter.author),
    serializeActor('reviewer', filter.reviewer),
    filter.sort ? `sort:${filter.sort}` : undefined,
    filter.text?.trim() || undefined,
  ]

  return terms.filter((term): term is string => Boolean(term)).join(' ')
}

export const ISSUE_PRIORITY_RANK: Readonly<Record<IssuePriority, number>> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 }

function actorMatches(user: { id: string; username: string }, actor: FilterActor | undefined, currentUserId: string): boolean {
  if (!actor) return true
  const normalized = actor.startsWith('@') ? actor.slice(1) : actor
  return actor === '@me' ? user.id === currentUserId : user.id === normalized || user.username === normalized
}

function priorityMatches(priority: IssuePriority, query: Filter['priority']): boolean {
  if (!query) return true
  if (query.values?.length) return query.values.includes(priority)
  const rank = ISSUE_PRIORITY_RANK[priority]
  const min = query.min ? ISSUE_PRIORITY_RANK[query.min] : Number.NEGATIVE_INFINITY
  const max = query.max ? ISSUE_PRIORITY_RANK[query.max] : Number.POSITIVE_INFINITY
  return rank >= min && rank <= max
}

/**
 * The single issue-filter predicate (GC-02): the mock service and any
 * client-side optimistic checks must both use this implementation.
 */
export function matchesIssueFilter(issue: Issue, filter: Filter, currentUserId: string): boolean {
  if (filter.states?.length && !filter.states.includes(issue.state)) return false
  if (!priorityMatches(issue.priority, filter.priority)) return false
  if (filter.packageIds && filter.packageIds !== 'all' && !filter.packageIds.includes(issue.packageId)) return false
  if (filter.labels?.length && !filter.labels.every((label) => issue.labels.some((candidate) => candidate.id === label || candidate.name === label))) return false
  if (!actorMatches(issue.author, filter.author, currentUserId)) return false
  if (filter.assignee && !issue.assignees.some((assignee) => actorMatches(assignee, filter.assignee, currentUserId))) return false
  if (filter.text) {
    const haystack = `${issue.title} ${issue.body ?? ''}`.toLocaleLowerCase()
    if (!haystack.includes(filter.text.toLocaleLowerCase())) return false
  }
  return true
}

/** CL counterpart of matchesIssueFilter — the single list predicate (GC-02). */
export function matchesCLFilter(cl: CL, filter: Filter, currentUserId: string): boolean {
  if (filter.states?.length && !filter.states.includes(cl.state)) return false
  if (filter.packageIds && filter.packageIds !== 'all' && !filter.packageIds.includes(cl.packageId) && !cl.crossPackage.some((id) => filter.packageIds !== 'all' && (filter.packageIds as readonly string[]).includes(id))) return false
  if (filter.author) {
    const normalized = filter.author.startsWith('@') ? filter.author.slice(1) : filter.author
    const matches = filter.author === '@me' ? cl.author.id === currentUserId : cl.author.id === normalized || cl.author.username === normalized
    if (!matches) return false
  }
  if (filter.reviewer) {
    const normalized = filter.reviewer.startsWith('@') ? filter.reviewer.slice(1) : filter.reviewer
    const matches = cl.reviewers.some((reviewer) => filter.reviewer === '@me'
      ? reviewer.user.id === currentUserId
      : reviewer.user.id === normalized || reviewer.user.username === normalized)
    if (!matches) return false
  }
  if (filter.text) {
    const haystack = `${cl.title} ${cl.description ?? ''}`.toLocaleLowerCase()
    if (!haystack.includes(filter.text.toLocaleLowerCase())) return false
  }
  return true
}
