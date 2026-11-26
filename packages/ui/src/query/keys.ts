/**
 * megaui:libs/react-shared/components/mega/query/keys.ts@0ff3a9d
 *
 * Central query-key and mutation-invalidation contract for the Mega
 * workspace. Screens consume these factories rather than assembling array
 * keys locally.
 *
 * Diff vs upstream (GC-03, registered on the UI-04 task card):
 * - SaaS-domain keys are dropped along with their `@megaui/core` types
 *   (see `packages/core/README.md` "Domain diff"): `session` (the
 *   agent-session / observability timeline model), `workspaceNotificationSettings`
 *   (workspace notification *delivery* config, not the `Notification`
 *   entity itself), `profilePrefs`, `sshKeys`, `personalAccessTokens`
 *   (personal account settings). Their `megaMutationInvalidations` entries
 *   are dropped for the same reason.
 * - Upstream typed list-filter params as `Filter` (from `@megaui/core`) and
 *   `NotificationFilter` (from `@libs/mega/services`). `packages/ui` does
 *   not declare a `@megaui/core` workspace dependency yet — UI-04's write
 *   set is `packages/ui/src/query/**` only, and adding the dependency
 *   touches `package.json` (out of scope; ADR-ARCH-01 permits `ui -> core`
 *   for a future card that needs it). This module never inspects a
 *   filter's fields — it only embeds it verbatim as a cache-key
 *   discriminator — so `issues`/`cls` take the filter as a caller-supplied
 *   generic `F` instead of importing `Filter`, and `NotificationFilter` is
 *   redefined locally (kind narrowed to `string`, not `@megaui/core`'s
 *   `NotificationKind` union, for the same reason).
 */

/** Mirrors upstream `libs/mega/services/types.ts` `NotificationFilter` shape (see module header). */
export interface NotificationFilter {
  kind?: string
  unreadOnly?: boolean
  starredOnly?: boolean
}

export const megaQueryKeys = {
  root: ['mega'] as const,
  home: () => ['mega', 'home'] as const,
  workspace: () => ['mega', 'workspace'] as const,
  packages: () => ['mega', 'packages'] as const,
  package: (id: string) => ['mega', 'packages', id] as const,
  codeTree: (path?: string) => ['mega', 'code-tree', path ?? 'root'] as const,
  rootEntries: () => ['mega', 'root-entries'] as const,
  readme: () => ['mega', 'readme'] as const,
  codeReadme: () => ['mega', 'code-readme'] as const,
  adminMe: () => ['mega', 'admin', 'me'] as const,
  issues: <F>(filter?: F) => filter ? ['mega', 'issues', 'list', filter] as const : ['mega', 'issues'] as const,
  issue: (number: number) => ['mega', 'issues', number] as const,
  issueBody: (number: number) => ['mega', 'issues', number, 'body'] as const,
  issueComments: (number: number) => ['mega', 'issues', number, 'comments'] as const,
  cls: <F>(filter?: F) => filter ? ['mega', 'cls', 'list', filter] as const : ['mega', 'cls'] as const,
  cl: (id: number | string) => ['mega', 'cls', id] as const,
  clOverview: (id: string) => ['mega', 'cls', id, 'overview'] as const,
  clDescription: (number: number) => ['mega', 'cls', number, 'description'] as const,
  clInlineComments: (number: number) => ['mega', 'cls', number, 'inline-comments'] as const,
  clComments: (number: number) => ['mega', 'cls', number, 'comments'] as const,
  clCommits: (number: number) => ['mega', 'cls', number, 'commits'] as const,
  clChecks: (number: number) => ['mega', 'cls', number, 'checks'] as const,
  clDependencyGraph: (number: number) => ['mega', 'cls', number, 'dependency-graph'] as const,
  notifications: (filter?: NotificationFilter) => filter ? ['mega', 'notifications', 'list', filter] as const : ['mega', 'notifications'] as const,
  notificationUnreadCount: () => ['mega', 'notifications', 'unread-count'] as const,
  docs: () => ['mega', 'docs'] as const,
  doc: (id: string) => ['mega', 'docs', id] as const,
  docComments: (id: string) => ['mega', 'docs', id, 'comments'] as const,
  backlinks: (kind: 'doc' | 'issue' | 'cl', id: string) => ['mega', 'links', 'backlinks', kind, id] as const,
  docBacklinks: (id: string) => ['mega', 'links', 'backlinks', 'doc', id] as const,
  docUnlinked: (id: string) => ['mega', 'docs', id, 'unlinked'] as const,
  embedResolves: () => ['mega', 'embed', 'resolve'] as const,
  embedResolve: (docId: string, blockId?: string) => ['mega', 'embed', 'resolve', docId, blockId ?? ''] as const,
  titleIndex: () => ['mega', 'docs', 'title-index'] as const,
  contentLinkGraph: () => ['mega', 'graph'] as const,
  /** Doc-level collaborator roster (collab domain surface reachable from a doc). */
  docCollaborators: (id: string) => ['mega', 'docs', id, 'collaborators'] as const,
  channels: () => ['mega', 'channels'] as const,
  channelMembers: (id: string) => ['mega', 'channels', id, 'members'] as const,
  channelMemberSearch: (id: string, q: string) => ['mega', 'channels', id, 'members', 'search', q] as const,
  channelMessages: (id: string) => ['mega', 'channels', id, 'messages'] as const,
  channelThreads: (id: string) => ['mega', 'channels', id, 'threads'] as const,
  chatThread: (id: string) => ['mega', 'chat-threads', id] as const,
  chatThreads: () => ['mega', 'chat-threads'] as const,
  agentThreads: () => ['mega', 'agent'] as const,
  agentThread: (id: string) => ['mega', 'agent', id] as const,
  releases: () => ['mega', 'releases'] as const,
  search: (query: string) => ['mega', 'search', query] as const,
  users: () => ['mega', 'users'] as const,
  sourceFile: (path: string) => ['mega', 'source-file', path] as const,
} as const

export const megaMutationInvalidations = {
  issueComment: [megaQueryKeys.issues(), megaQueryKeys.home()],
  issueReaction: [megaQueryKeys.issues(), megaQueryKeys.home()],
  issueClose: [megaQueryKeys.issues(), megaQueryKeys.home()],
  issueCreate: [megaQueryKeys.issues(), megaQueryKeys.home()],
  issueWatch: [megaQueryKeys.issues()],
  issueBody: [megaQueryKeys.issues()],
  clViewed: [megaQueryKeys.cls(), megaQueryKeys.home()],
  clDescription: [megaQueryKeys.cls(), megaQueryKeys.home()],
  clInlineComment: [megaQueryKeys.cls(), megaQueryKeys.home()],
  clComment: [megaQueryKeys.cls(), megaQueryKeys.home()],
  clTransition: [megaQueryKeys.cls(), megaQueryKeys.home()],
  clCreate: [megaQueryKeys.cls(), megaQueryKeys.home()],
  clSubscribe: [megaQueryKeys.cls()],
  notification: [megaQueryKeys.notifications(), megaQueryKeys.home()],
  doc: [megaQueryKeys.docs(), megaQueryKeys.home()],
  docComment: [megaQueryKeys.docs(), megaQueryKeys.home()],
  /** CE-42: invalidate backlinks/unlinked/title-index after link mutations / rename. */
  docLinks: (docId: string) => [
    megaQueryKeys.doc(docId),
    megaQueryKeys.docBacklinks(docId),
    megaQueryKeys.docUnlinked(docId),
    megaQueryKeys.titleIndex(),
    megaQueryKeys.docs(),
    megaQueryKeys.home(),
  ],
  /**
   * CE-42 rename: refresh the renamed doc + title-index + every backlinks/unlinked
   * query (source titles are resolved live). Pair with `invalidateMegaDocLinkQueries`.
   */
  docRename: (docId: string) => [
    megaQueryKeys.doc(docId),
    megaQueryKeys.titleIndex(),
    megaQueryKeys.docs(),
    megaQueryKeys.home(),
  ],
  chat: [megaQueryKeys.channels(), megaQueryKeys.chatThreads(), megaQueryKeys.home()],
  channelRead: [megaQueryKeys.channels()],
  agentAsk: [megaQueryKeys.agentThreads()],
  releaseDraft: [megaQueryKeys.releases(), megaQueryKeys.home()],
  workspaceStar: [megaQueryKeys.workspace()],
} as const

export type MegaQueryKey = readonly unknown[]

/** True for backlinks or unlinked query keys affected by a document rename. */
export function isMegaDocLinksQueryKey(queryKey: readonly unknown[]): boolean {
  return (
    (
      queryKey[0] === 'mega'
      && queryKey[1] === 'links'
      && queryKey[2] === 'backlinks'
    )
    || (
      queryKey[0] === 'mega'
      && queryKey[1] === 'docs'
      && typeof queryKey[2] === 'string'
      && queryKey[3] === 'unlinked'
    )
  )
}
