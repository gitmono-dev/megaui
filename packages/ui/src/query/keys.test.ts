import { describe, expect, it } from 'vitest'
import { isMegaDocLinksQueryKey, megaMutationInvalidations, megaQueryKeys } from './keys'

// UI-04 AC1: keys 工厂覆盖全部 workspace 域（清单对照 upstream keys）— each
// domain megaui actually ships (docs/issues/cls/chat/releases/notifications/
// agent/search/collab/code, per `packages/engine/src/services/*`) must have
// at least one covering key, and the SaaS-only keys stripped per
// `packages/core/README.md` must not resurface.

describe('megaQueryKeys domain coverage (UI-04 AC1)', () => {
  it('covers the docs domain', () => {
    expect(megaQueryKeys.docs()).toEqual(['mega', 'docs'])
    expect(megaQueryKeys.doc('d1')).toEqual(['mega', 'docs', 'd1'])
    expect(megaQueryKeys.docComments('d1')).toEqual(['mega', 'docs', 'd1', 'comments'])
    expect(megaQueryKeys.docBacklinks('d1')).toEqual(['mega', 'links', 'backlinks', 'doc', 'd1'])
    expect(megaQueryKeys.docUnlinked('d1')).toEqual(['mega', 'docs', 'd1', 'unlinked'])
    expect(megaQueryKeys.embedResolve('d1', 'b1')).toEqual(['mega', 'embed', 'resolve', 'd1', 'b1'])
    expect(megaQueryKeys.titleIndex()).toEqual(['mega', 'docs', 'title-index'])
    expect(megaQueryKeys.contentLinkGraph()).toEqual(['mega', 'graph'])
  })

  it('covers the issues domain', () => {
    expect(megaQueryKeys.issues()).toEqual(['mega', 'issues'])
    expect(megaQueryKeys.issue(7)).toEqual(['mega', 'issues', 7])
    expect(megaQueryKeys.issueBody(7)).toEqual(['mega', 'issues', 7, 'body'])
    expect(megaQueryKeys.issueComments(7)).toEqual(['mega', 'issues', 7, 'comments'])
  })

  it('covers the cls domain', () => {
    expect(megaQueryKeys.cls()).toEqual(['mega', 'cls'])
    expect(megaQueryKeys.cl(4)).toEqual(['mega', 'cls', 4])
    const publicId = 'AqNM10BseQv1'
    expect(megaQueryKeys.cl(publicId)).toEqual(['mega', 'cls', publicId])
    expect(megaQueryKeys.clOverview(publicId)).toEqual([...megaQueryKeys.cl(publicId), 'overview'])
    expect(megaQueryKeys.clDescription(4)).toEqual(['mega', 'cls', 4, 'description'])
    expect(megaQueryKeys.clInlineComments(4)).toEqual(['mega', 'cls', 4, 'inline-comments'])
    expect(megaQueryKeys.clComments(4)).toEqual(['mega', 'cls', 4, 'comments'])
    expect(megaQueryKeys.clCommits(4)).toEqual(['mega', 'cls', 4, 'commits'])
    expect(megaQueryKeys.clChecks(4)).toEqual(['mega', 'cls', 4, 'checks'])
    expect(megaQueryKeys.clDependencyGraph(4)).toEqual(['mega', 'cls', 4, 'dependency-graph'])
  })

  it('covers the chat domain', () => {
    expect(megaQueryKeys.channels()).toEqual(['mega', 'channels'])
    expect(megaQueryKeys.channelMembers('c1')).toEqual(['mega', 'channels', 'c1', 'members'])
    expect(megaQueryKeys.channelMemberSearch('c1', 'ann')).toEqual(['mega', 'channels', 'c1', 'members', 'search', 'ann'])
    expect(megaQueryKeys.channelMessages('c1')).toEqual(['mega', 'channels', 'c1', 'messages'])
    expect(megaQueryKeys.channelThreads('c1')).toEqual(['mega', 'channels', 'c1', 'threads'])
    expect(megaQueryKeys.chatThread('t1')).toEqual(['mega', 'chat-threads', 't1'])
    expect(megaQueryKeys.chatThreads()).toEqual(['mega', 'chat-threads'])
  })

  it('covers the releases domain', () => {
    expect(megaQueryKeys.releases()).toEqual(['mega', 'releases'])
  })

  it('covers the notifications domain', () => {
    expect(megaQueryKeys.notifications()).toEqual(['mega', 'notifications'])
    expect(megaQueryKeys.notificationUnreadCount()).toEqual(['mega', 'notifications', 'unread-count'])
  })

  it('covers the agent domain', () => {
    expect(megaQueryKeys.agentThreads()).toEqual(['mega', 'agent'])
    expect(megaQueryKeys.agentThread('a1')).toEqual(['mega', 'agent', 'a1'])
  })

  it('covers the search domain', () => {
    expect(megaQueryKeys.search('foo')).toEqual(['mega', 'search', 'foo'])
  })

  it('covers the collab domain (doc collaborator roster)', () => {
    expect(megaQueryKeys.docCollaborators('d1')).toEqual(['mega', 'docs', 'd1', 'collaborators'])
  })

  it('covers the code domain (repo/package browsing, backed by the mega2 client)', () => {
    expect(megaQueryKeys.workspace()).toEqual(['mega', 'workspace'])
    expect(megaQueryKeys.packages()).toEqual(['mega', 'packages'])
    expect(megaQueryKeys.package('p1')).toEqual(['mega', 'packages', 'p1'])
    expect(megaQueryKeys.codeTree('a/b')).toEqual(['mega', 'code-tree', 'a/b'])
    expect(megaQueryKeys.codeTree()).toEqual(['mega', 'code-tree', 'root'])
    expect(megaQueryKeys.rootEntries()).toEqual(['mega', 'root-entries'])
    expect(megaQueryKeys.readme()).toEqual(['mega', 'readme'])
    expect(megaQueryKeys.codeReadme()).toEqual(['mega', 'code-readme'])
    expect(megaQueryKeys.adminMe()).toEqual(['mega', 'admin', 'me'])
    expect(megaQueryKeys.sourceFile('a/b.ts')).toEqual(['mega', 'source-file', 'a/b.ts'])
  })

  it('has home/root/users as cross-domain aggregate keys', () => {
    expect(megaQueryKeys.root).toEqual(['mega'])
    expect(megaQueryKeys.home()).toEqual(['mega', 'home'])
    expect(megaQueryKeys.users()).toEqual(['mega', 'users'])
  })

  it('namespaces list queries by filter, falling back to the bare list key', () => {
    expect(megaQueryKeys.issues({ text: 'bug' })).toEqual(['mega', 'issues', 'list', { text: 'bug' }])
    expect(megaQueryKeys.cls({ text: 'wip' })).toEqual(['mega', 'cls', 'list', { text: 'wip' }])
    expect(megaQueryKeys.notifications({ unreadOnly: true })).toEqual(['mega', 'notifications', 'list', { unreadOnly: true }])
  })

  it('does not resurface SaaS-only keys stripped per packages/core/README.md domain diff', () => {
    const keys = megaQueryKeys as Record<string, unknown>
    expect(keys.session).toBeUndefined()
    expect(keys.workspaceNotificationSettings).toBeUndefined()
    expect(keys.profilePrefs).toBeUndefined()
    expect(keys.sshKeys).toBeUndefined()
    expect(keys.personalAccessTokens).toBeUndefined()
  })
})

describe('megaMutationInvalidations', () => {
  it('does not resurface SaaS-only invalidation entries', () => {
    const invalidations = megaMutationInvalidations as Record<string, unknown>
    expect(invalidations.workspaceNotificationSettings).toBeUndefined()
    expect(invalidations.sshKeys).toBeUndefined()
    expect(invalidations.personalAccessTokens).toBeUndefined()
  })

  it('invalidates the issues + home lists together on issue mutations', () => {
    expect(megaMutationInvalidations.issueCreate).toEqual([megaQueryKeys.issues(), megaQueryKeys.home()])
    expect(megaMutationInvalidations.issueWatch).toEqual([megaQueryKeys.issues()])
  })

  it('docLinks/docRename invalidate the full backlink/unlinked/title-index fan-out (CE-42)', () => {
    expect(megaMutationInvalidations.docLinks('d1')).toEqual([
      megaQueryKeys.doc('d1'),
      megaQueryKeys.docBacklinks('d1'),
      megaQueryKeys.docUnlinked('d1'),
      megaQueryKeys.titleIndex(),
      megaQueryKeys.docs(),
      megaQueryKeys.home(),
    ])
    expect(megaMutationInvalidations.docRename('d1')).toEqual([
      megaQueryKeys.doc('d1'),
      megaQueryKeys.titleIndex(),
      megaQueryKeys.docs(),
      megaQueryKeys.home(),
    ])
  })
})

describe('isMegaDocLinksQueryKey', () => {
  it('matches backlinks keys', () => {
    expect(isMegaDocLinksQueryKey(megaQueryKeys.docBacklinks('d1'))).toBe(true)
    expect(isMegaDocLinksQueryKey(megaQueryKeys.backlinks('issue', '7'))).toBe(true)
  })

  it('matches unlinked keys', () => {
    expect(isMegaDocLinksQueryKey(megaQueryKeys.docUnlinked('d1'))).toBe(true)
  })

  it('does not match unrelated keys', () => {
    expect(isMegaDocLinksQueryKey(megaQueryKeys.doc('d1'))).toBe(false)
    expect(isMegaDocLinksQueryKey(megaQueryKeys.docs())).toBe(false)
    expect(isMegaDocLinksQueryKey(megaQueryKeys.issues())).toBe(false)
  })
})
