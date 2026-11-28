/**
 * megaui:libs/mega/types.ts@0ff3a9d
 *
 * Mega domain types ported from upstream, with SaaS-only surfaces stripped
 * (accounts/settings, workspace notification delivery config, mega2
 * backend-mode flags, and the agent-session observability model). See
 * `packages/core/README.md` for the full domain diff (GC-03).
 */

export type ISODateString = string
/** Serialized Lexical EditorState JSON stored by the domain layer. */
export type SerializedEditorStateJSON = string

export type CIStatus = 'passing' | 'failing' | 'queued' | 'running' | 'skipped'

export interface User {
  id: string
  username: string
  displayName: string
  avatarUrl?: string
  avatarInitials: string
  avatarColor?: string
}

export interface Workspace {
  id: string
  name: string
  description: string
  defaultBranch: string
  headSha: string
  starred: boolean
  packages: readonly Package[]
}

export interface PackageSymbol {
  kind: 'mod' | 'fn' | 'struct'
  name: string
  detail?: string
}

export interface Package {
  id: string
  name: string
  version: string
  path: string
  description?: string
  owners: readonly string[]
  ci: CIStatus
  ciDurationSeconds?: number
  dependencyCount: number
  usedByCount: number
  indexed: boolean
  sparse?: boolean
  dependencies?: readonly string[]
  usedBy?: readonly string[]
  symbols?: readonly PackageSymbol[]
}

export type TreeNodeKind = 'file' | 'directory'

export interface SourceFile {
  path: string
  /** Shiki language id used by the diff/code highlighter. */
  language: string
  content: string
}

export interface TreeNode {
  name: string
  path: string
  kind: TreeNodeKind
  expanded?: boolean
  active?: boolean
  children?: readonly TreeNode[]
}

export interface RootEntry {
  name: string
  path: string
  kind: TreeNodeKind
  lastCommitMessage: string
  updatedAt: ISODateString
  author: User
  packageId?: string
}

export type ProseBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; language: string; text: string }
  | { type: 'list'; ordered: boolean; items: readonly ProseListItem[] }
  | { type: 'quote'; text: string }
  | { type: 'divider' }

export interface ProseListItem {
  text: string
  detail?: string
}

export const MEGA_ISSUE_STATES = ['open', 'closed'] as const
export type IssueState = typeof MEGA_ISSUE_STATES[number]

export const MEGA_ISSUE_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'] as const
export type IssuePriority = typeof MEGA_ISSUE_PRIORITIES[number]

/** `string & {}` keeps the @me sentinel visible to editor completions. */
export type FilterActor = '@me' | (string & {})
export const MEGA_FILTER_SORTS = ['updated-desc', 'updated-asc', 'created-desc', 'created-asc', 'priority-desc'] as const
export type FilterSort = typeof MEGA_FILTER_SORTS[number]

/** Shared structured query contract consumed by the search/filter layer. */
export interface Filter {
  text?: string
  states?: readonly (IssueState | CLState)[]
  priority?: {
    min?: IssuePriority
    max?: IssuePriority
    values?: readonly IssuePriority[]
  }
  packageIds?: readonly string[] | 'all'
  labels?: readonly string[]
  assignee?: FilterActor
  author?: FilterActor
  reviewer?: FilterActor
  sort?: FilterSort
}

/** Signature implemented by the DSL parser that turns a query string into a `Filter`. */
export type ParseQuery = (query: string) => Filter

export interface Label {
  id: string
  name: string
  color: string
  description?: string
}

export interface Milestone {
  id: string
  title: string
  dueDate?: ISODateString
  progress?: number
}

export interface Reaction {
  emoji: string
  count: number
  reactedByMe: boolean
}

export const ISSUE_TYPES = ['task', 'bug', 'feature'] as const
export type IssueType = typeof ISSUE_TYPES[number]
export const ISSUE_WORKFLOW_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review'] as const
export type IssueWorkflowStatus = typeof ISSUE_WORKFLOW_STATUSES[number]

export interface IssuePropertiesInput {
  workflowStatus?: IssueWorkflowStatus
  assigneeIds?: string[]
  labels?: string[]
  issueType?: IssueType
  projects?: string[]
  milestoneTitle?: string
  priority?: IssuePriority
}

export interface IssuePropertyOptions {
  members: Pick<User, 'id' | 'displayName'>[]
  labels: string[]
  projects: string[]
  milestones: string[]
}

export interface Issue {
  id: string
  publicId?: string
  number: number
  title: string
  body?: string
  state: IssueState
  workflowStatus?: IssueWorkflowStatus
  priority: IssuePriority
  labels: readonly Label[]
  milestone?: Milestone
  issueType?: IssueType
  projects?: readonly string[]
  linkedCLs: readonly number[]
  linkedClPublicIds?: readonly string[]
  reactions: readonly Reaction[]
  author: User
  assignees: readonly User[]
  packageId: string
  commentCount: number
  watcherIds: readonly string[]
  createdAt: ISODateString
  updatedAt: ISODateString
  closedAt?: ISODateString
}

export interface IssueComment {
  id: string
  issueNumber: number
  author: User
  body: string
  createdAt: ISODateString
  reactions: readonly Reaction[]
}

/** Doc discussion comment; body is Lexical editor-state JSON. */
export interface DocComment {
  id: string
  docId: string
  author: User
  body: string
  createdAt: ISODateString
  reactions: readonly Reaction[]
}

/** The canonical six-state CL domain vocabulary. */
export const MEGA_CL_LABELS = {
  ready: { label: 'ready' },
  wip: { label: 'WIP' },
  queued: { label: 'queued' },
  merged: { label: 'merged' },
  closed: { label: 'closed' },
  conflicts: { label: 'conflicts' },
} as const

export type CLState = keyof typeof MEGA_CL_LABELS
export const MEGA_OPEN_CL_STATES = ['ready', 'wip', 'queued', 'conflicts'] as const satisfies readonly CLState[]
export type OpenCLState = typeof MEGA_OPEN_CL_STATES[number]

const MEGA_OPEN_CL_STATE_SET: ReadonlySet<CLState> = new Set(MEGA_OPEN_CL_STATES)

export function isOpenCLState(state: CLState): state is OpenCLState {
  return MEGA_OPEN_CL_STATE_SET.has(state)
}

export type CLMergeState = 'queue-ready' | 'needs-review' | 'in-queue' | 'merged' | 'rebase-needed'
export type ReviewerVerdict = 'approved' | 'commented' | 'requested' | 'pending'

export interface CLReviewer {
  user: User
  verdict: ReviewerVerdict
  reviewedAt?: ISODateString
}

export interface CLFile {
  path: string
  /** Source path when a review compares a renamed file against its previous name. */
  oldPath?: string
  status: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  patch: string
  viewed: boolean
  commentCount: number
  /**
   * Patches keyed by a rev range ("1..4"); the Files tab serves the matching
   * patch for `?range=` deep links. No dynamic diff computation happens —
   * absent ranges fall back to `patch`.
   */
  rangePatches?: Readonly<Record<string, string>>
}

export interface InlineCommentReply {
  id: string
  author: User
  body: string
  createdAt: ISODateString
  /** The CL revision the reply was posted from. */
  revision?: number
}

export interface InlineComment {
  id: string
  clNumber: number
  filePath: string
  /** Which diff side the anchor line lives on; defaults to 'additions'. */
  side?: 'additions' | 'deletions'
  line: number
  author: User
  body: string
  createdAt: ISODateString
  resolvedAt?: ISODateString
  replies: readonly InlineCommentReply[]
}

export interface CL {
  id: string
  /** Stable twelve-character alphanumeric code used in user-facing CL references. */
  publicId: string
  number: number
  title: string
  description?: string
  state: CLState
  packageId: string
  author: User
  reviewers: readonly CLReviewer[]
  /** False when only file metadata was requested and no line counts or patches were loaded. */
  diffStatsAvailable?: boolean
  additions: number
  deletions: number
  files: readonly CLFile[]
  revisions: readonly Revision[]
  /** False when the upstream merge requirements explicitly omit CI. */
  ciRequired?: boolean
  ci: CIStatus
  merge: CLMergeState
  mergeScore?: number
  queuePosition?: number
  atomic: boolean
  crossPackage: readonly string[]
  linkedIssues: readonly number[]
  /** Source branch shown in the detail header. */
  branch?: string
  /** Current viewer's subscription state. */
  subscribed?: boolean
  createdAt: ISODateString
  updatedAt: ISODateString
  mergedAt?: ISODateString
}

export interface CLComment {
  id: string
  clNumber: number
  author: User
  body: string
  createdAt: ISODateString
  reactions: readonly Reaction[]
}

export interface RevisionCommit {
  sha: string
  message: string
  author: User
  createdAt: ISODateString
  filesChanged: number
  additions: number
  deletions: number
}

export interface RevisionRebase {
  from: string
  to: string
  upstreamCommits: number
}

export interface Revision {
  id: string
  number: number
  sha: string
  label: string
  createdAt: ISODateString
  rebased: boolean
  forcePushed: boolean
  commitList: readonly RevisionCommit[]
  reviewerState: readonly CLReviewer[]
  /** One-line prose summary shown on the revision card. */
  summary: string
  /** Base branch pointer, e.g. "main @ e29d1a4". */
  base: string
  ci: CIStatus
  additions: number
  deletions: number
  filesChanged: number
  /** Present on force-push revisions: the rebase bar (from → to + upstream commits). */
  rebase?: RevisionRebase
}

export interface CheckRun {
  id: string
  name: string
  status: CIStatus
  matrix?: string
  durationSeconds?: number
  logId?: string
  startedAt?: ISODateString
  completedAt?: ISODateString
  /** Log line count shown in the check table's Logs column. */
  logCount?: number
  /** Free-form annotation, e.g. runner/environment note. */
  note?: string
  /** Passed-test count for test-stage checks. */
  passedCount?: number
}

export interface PipelineStage {
  id: string
  name: string
  status: CIStatus
  checks: readonly CheckRun[]
}

export interface LogLine {
  id: string
  timestamp?: ISODateString
  level: 'debug' | 'info' | 'warn' | 'error' | 'success'
  text: string
}

export interface BenchTile {
  id: string
  name: string
  baseline: number
  candidate: number
  unit: string
  deltaPercent: number
  direction: 'improved' | 'regressed' | 'unchanged'
}

export type DepNodeKind = 'this' | 'upstream' | 'downstream'
export type DepHeat = 'none' | 'low' | 'medium' | 'high'

export interface DepNode {
  id: string
  label: string
  kind: DepNodeKind
  packageId?: string
  /** Approximate size annotation rendered inside the node ("18.4k"). */
  kloc?: string
}

export interface DepEdge {
  id: string
  from: string
  to: string
  heat: DepHeat
  via?: string
}

export interface DepGraph {
  nodes: readonly DepNode[]
  edges: readonly DepEdge[]
}

export type ApiChangeKind = 'added' | 'removed' | 'note'

export interface ApiChange {
  id: string
  kind: ApiChangeKind
  text: string
}

export type CLRelation = 'blocks' | 'depends-on' | 'supersedes' | 'follows'

/** Stores only the relation + target number; title/package/state derive from the CL record. */
export interface RelatedCL {
  id: string
  relation: CLRelation
  number: number
  publicId?: string
  note?: string
}

export interface SymbolUsage {
  id: string
  symbol: string
  refs: number
  files: number
  packages: string
  removed?: boolean
}

export type ReleaseNoteKind = 'feature' | 'performance' | 'fix' | 'breaking'

export interface ReleaseNote {
  id: string
  kind: ReleaseNoteKind
  /** Plain-text projection (search / legacy entity-ref link). */
  text: string
  /** Lexical editor-state JSON (release_note container body). */
  body?: string
  linkedCLs: readonly number[]
}

export interface ReleaseAsset {
  id: string
  name: string
  downloadUrl: string
  sizeBytes: number
  contentType: string
  downloadCount?: number
}

export interface Release {
  id: string
  tag: string
  title: string
  state: 'draft' | 'published'
  publishedAt?: ISODateString
  targetSha: string
  author: User
  /** Commit count since `sinceTag`. */
  commitsSince: number
  sinceTag?: string
  prerelease?: boolean
  major?: boolean
  notes: readonly ReleaseNote[]
  assets: readonly ReleaseAsset[]
}

export interface DocTag {
  id: string
  name: string
  color?: string
}

export interface Folder {
  id: string
  name: string
  parentId?: string
  path: string
}

export interface DocVersion {
  id: string
  version: number
  author: User
  createdAt: ISODateString
  summary?: string
  /** EditorState snapshot for the read-only `?v=` view. */
  body?: SerializedEditorStateJSON
}

export interface Doc {
  id: string
  title: string
  /** Serialized Lexical EditorState JSON for the mega block tree. */
  body: SerializedEditorStateJSON
  excerpt: string
  author: User
  collaborators: readonly User[]
  tags: readonly DocTag[]
  folderId?: string
  linkedCLs: readonly string[]
  linkedIssues: readonly number[]
  versions: readonly DocVersion[]
  starred: boolean
  /** Which inline hero placeholder the grid card shows. */
  hero?: 'mountain' | 'stream'
  /** Card preview lines derived from the source content at fixture-build time. */
  preview: readonly string[]
  /** Lifecycle chip. */
  status?: 'draft' | 'published'
  /** Actor-specific edit capability, resolved by the server ACL. */
  canEdit?: boolean
  /** Byline counters; views increment on read. */
  viewCount: number
  commentCount: number
  createdAt: ISODateString
  updatedAt: ISODateString
}

export const MEGA_NOTIFICATION_KINDS = [
  'mention',
  'reply',
  'dm',
  'invite',
  'review',
  'ci',
  'cifail',
  'issue',
] as const
export type NotificationKind = typeof MEGA_NOTIFICATION_KINDS[number]

export interface NotificationPayload {
  entityType: 'issue' | 'cl' | 'channel' | 'dm' | 'check' | 'doc'
  entityId: string
  entityNumber?: number
  url: string
  summary: string
  /** Fanout actor display name for i18n title templates. */
  actorName?: string
  /** Channel/DM label for i18n title templates. */
  channelLabel?: string
}

export interface Notification {
  id: string
  kind: NotificationKind
  title: string
  payload: NotificationPayload
  actor?: User
  packageId?: string
  readAt?: ISODateString
  starred: boolean
  createdAt: ISODateString
}

/** Single source for the username shape — shared by service, API and form validation. */
export const MEGA_USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/

/** Single source for the admin-managed Code root README size limit (UTF-16 code units). */
export const MEGA_CODE_README_MAX_LENGTH = 100_000

export interface ChannelBase {
  id: string
  name: string
  topic?: string
  packageId?: string
  unreadCount: number
  mentionCount: number
  lastReadMessageId?: string
  /** Latest message that @-mentions the viewing actor (jump target). */
  latestMentionMessageId?: string
}

/** Workspace channel visibility. Public = workspace-implicit; private = members-only. */
export type ChannelVisibility = 'public' | 'private'

export interface WorkspaceChannel extends ChannelBase {
  kind: 'channel'
  visibility: ChannelVisibility
}

export interface DirectMessageChannel extends ChannelBase {
  kind: 'dm'
  /** Peer user derived from the channel membership pair. */
  participant: User
  /** Shared packages shown in the DM header. */
  sharedPackageIds?: readonly string[]
  /**
   * Peer read watermark derived from the peer member row's `lastReadMessageId`.
   */
  participantLastReadMessageId?: string
}

export type Channel = WorkspaceChannel | DirectMessageChannel

/** Channel membership row. */
export interface ChannelMember {
  id: string
  channelId: string
  userId: string
  user: User
  role: 'admin' | 'member'
  lastReadMessageId?: string
  muted: boolean
  joinedAt: ISODateString
}

export type ChatSegment =
  | { type: 'text'; text: string }
  | { type: 'code'; language?: string; text: string }
  | { type: 'link'; url: string; text: string }
  | { type: 'cl-ref'; publicId: string }
  | { type: 'cl-ref'; number: number }
  | { type: 'issue-ref'; number: number }
  | { type: 'user-ref'; username: string }
  | { type: 'file-ref'; path: string; line?: number }

export interface ChatMessage {
  id: string
  channelId?: string
  threadId?: string
  author: User
  /** Lexical editor-state JSON (write surface). */
  body?: string
  segments: readonly ChatSegment[]
  reactions: readonly Reaction[]
  createdAt: ISODateString
  editedAt?: ISODateString
}

export interface Thread {
  id: string
  rootMessageId: string
  channelId?: string
  messages: readonly ChatMessage[]
  participantIds: readonly string[]
}

export interface Citation {
  id: string
  kind: 'file' | 'cl' | 'issue' | 'doc' | 'thread'
  label: string
  url: string
  detail?: string
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  /** Lexical editor-state JSON (agent_message container body). */
  body?: string
  segments: readonly ChatSegment[]
  citations: readonly Citation[]
  createdAt: ISODateString
}

export interface AgentThread {
  id: string
  title: string
  scopePackageId?: string
  messages: readonly AgentMessage[]
  updatedAt: ISODateString
}
