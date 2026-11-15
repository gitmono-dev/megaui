import type { Page } from '@playwright/test';

const author = { id: 'surface-author', username: 'ada', displayName: 'Ada', email: 'ada@example.com', avatarInitials: 'A' };
const timestamp = '2026-01-01T00:00:00.000Z';
const thread = { id: 'surface-thread', title: 'Surface review', messages: [], updatedAt: timestamp };
const body = JSON.stringify({ root: { type: 'root', version: 1, children: [{ type: 'mega-block', version: 1, blockId: 'surfaceRow01', variant: 'text', collapsed: false, todoChecked: false, children: [{ type: 'text', version: 1, text: 'Document content', detail: 0, format: 0, mode: 'normal', style: '' }], direction: null, format: '', indent: 0 }], direction: null, format: '', indent: 0 } });
const doc = { id: 'surface-doc', title: 'Document baseline', body, excerpt: 'Document content', author, collaborators: [], tags: [], linkedCLs: [], linkedIssues: [], versions: [], starred: false, preview: [], status: 'draft', viewCount: 1, commentCount: 0, createdAt: timestamp, updatedAt: timestamp, canEdit: false };
const issue = { id: 'surface-issue', number: 7, title: 'Review workspace styles', body: '', state: 'open', priority: 'P1', labels: [], linkedCLs: [], reactions: [], author, assignees: [], packageId: 'pkg_engine', commentCount: 0, watcherIds: [], createdAt: timestamp, updatedAt: timestamp };
const cl = { id: 'surface-cl', number: 42, title: 'Unify workspace styles', description: '', state: 'ready', packageId: 'pkg_engine', author, reviewers: [], additions: 0, deletions: 0, files: [], revisions: [], ci: 'passing', merge: 'queue-ready', atomic: false, crossPackage: [], linkedIssues: [], branch: 'style', subscribed: false, createdAt: timestamp, updatedAt: timestamp };
const channel = { id: 'surface-channel', kind: 'channel', name: 'Design', visibility: 'public', topic: 'Shared document style', unreadCount: 0, mentionCount: 0 };
const dm = { id: 'surface-dm', kind: 'dm', name: 'Ada', participant: author, unreadCount: 0, mentionCount: 0 };
const pageOf = (items: unknown[]) => ({ items, total: items.length, offset: 0, limit: 20 });

export async function stubSurfaceApis(page: Page) {
  const responses: Record<string, unknown> = {
    agent: pageOf([thread]), 'agent/surface-thread': thread,
    docs: [doc], 'docs/surface-doc': doc, 'docs/surface-doc/backlinks': { items: [] }, 'docs/surface-doc/unlinked': { items: [] },
    graph: { nodes: [], edges: [] },
    issues: pageOf([issue]), 'issues/7': issue,
    cls: [cl], 'cls/42': cl,
    'cls/42/checks': { pipeline: [], runner: '', checks: [], logTail: [], benchmarks: [] },
    'cls/42/dependency-graph': { nodes: [], edges: [], apiChanges: [], relatedCLs: [], symbolUsage: [], cycles: [] },
    channels: [channel, dm],
    notifications: pageOf([]), 'notifications/unread-count': { count: 0 },
    workspace: { id: 'mega', name: 'Mega', defaultBranch: 'main', packages: [] },
    home: { kpis: { reviewsRequested: 0, mentions: 0, myOpenIssues: 0, mainCI: 'skipped', agentSessionsToday: 0 }, cards: { reviewRequests: [], assignedIssues: [], activity: [], releases: [], agentThreads: [], docs: [], channels: [], quickLinks: [] } },
    releases: pageOf([]),
    'profile-prefs': { username: 'ada', bio: '' },
    'user/notifications': { settings: { username: 'ada', enabled: true, deliveryMode: 'in_app', preferredLocale: 'en' }, preferences: [] },
    'sessions/surface-session': { id: 'surface-session', title: 'Review session', status: 'completed', threadRef: 'refs/ai/style', usage: { inputTokens: 12, outputTokens: 10, totalTokens: 22, latencyMs: 100 }, decisions: [], evidence: [], citations: [] },
    'code-tree': [{ name: 'README.md', path: 'README.md', kind: 'file' }],
    readme: [{ type: 'heading', level: 1, text: 'README heading' }, { type: 'paragraph', text: 'Repository content' }],
    'source-file': { path: 'README.md', language: 'markdown', content: '# Readme\n\nContent', lines: 3, sizeBytes: 17 },
  };
  await page.route('**/api/mega/**', route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/mega\/?/, '');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: responses[path] ?? [] }) });
  });
}

export const SURFACE_ROUTES = [
  ['', '[data-mega-home="page"]'],
  ['/docs', '[data-mega-docs="page"]'],
  ['/docs/surface-doc', '[data-mega-docs="detail"]'],
  ['/docs/graph', '[data-mega-docs="graph"]'],
  ['/issues', '[data-mega-issues="page"]'],
  ['/issues/7', '[data-mega-issues="detail"]'],
  ['/inbox', '[data-mega-inbox="page"]'],
  ['/agent/surface-thread', '[data-mega-agent="thread"]'],
  ['/sessions/surface-session', '[data-mega-session="page"]'],
  ['/code', '[data-mega-code="page"]'],
  ['/code/README.md', '[data-mega-code="page"]'],
  ['/tags', '[data-mega-tags="page"]'],
  ['/cls', '[data-mega-cls="page"]'],
  ['/cls/42', '[data-mega-cls="detail"]'],
  ['/cls/42/files', '[data-mega-cls="detail"]'],
  ['/cls/42/checks', '[data-mega-cls="detail"]'],
  ['/cls/42/revisions', '[data-mega-cls="detail"]'],
  ['/cls/42/deps', '[data-mega-cls="detail"]'],
  ['/channels/new', '[data-mega-chat="create"]'],
  ['/channels/surface-channel', '[data-mega-chat="channel"]'],
  ['/dm/surface-dm', '[data-mega-chat="dm"]'],
  ...['profile', 'appearance', 'account-security', 'ssh-keys', 'tokens', 'notifications', 'shortcuts'].map(section => [`/settings?section=${section}`, '[data-mega-settings="page"]']),
];
