# `@megaui/core`

Zero-UI foundation package: mega domain types, `MEGA_*` constants, collab
pure functions (ticket mint/verify, container room naming, presence color),
the prose entity-reference tokenizer, and the content-processing pure
functions (filter DSL, patch ranges, tree sort, title index, plain-text
linkify, embed subtree extraction, chat unread math).

`packages/core` is a leaf package (enforced by `.dependency-cruiser.cjs`):
it has no dependency on any other `packages/*` or `apps/*` in this repo, and
currently pulls in **zero third-party runtime dependencies** (the collab
ticket functions use only Node's built-in `node:crypto`).

## Provenance

Every ported file carries a `upstream-frontend:<path>@<sha>` header comment (GC-03).
Source: `upstream-frontend` @ `0ff3a9d`.

| File | Source |
|---|---|
| `src/types.ts` | `libs/mega/types.ts` |
| `src/refs.ts` | `libs/mega/refs.ts` |
| `src/collab/ticket.ts` | `libs/mega/collab/ticket.ts` |
| `src/collab/container.ts` | `libs/mega/collab/container.ts` |
| `src/collab/presence-color.ts` | `libs/mega/collab/presence-color.ts` |
| `src/filter.ts` | `libs/mega/filter.ts` |
| `src/patch.ts` | `libs/mega/patch.ts` |
| `src/tree-sort.ts` | `libs/mega/tree-sort.ts` |
| `src/title-index.ts` | `libs/mega/title-index.ts` |
| `src/linkify-plain.ts` | `libs/mega/linkify-plain.ts` |
| `src/embed-subtree.ts` | `libs/mega/embed-subtree.ts` |
| `src/unread-math.ts` | `libs/mega/unread-math.ts` |

## Domain diff vs upstream-frontend (`libs/mega/types.ts`)

megaui strips upstream-frontend's SaaS-only and backend-mode surfaces from the ported
domain types. All diffs below are intentional (reason = SaaS 剥离 / 架构边界,
per the PK-01 task card's `Reference source` note).

### Removed entirely

| upstream-frontend surface | Why removed |
|---|---|
| `MegaApiSuccess<T>` / `MegaApiFailure` | BFF transport envelope, not a domain type. Belongs to the `apps/web` adapter layer (`DIR-03`), not a zero-UI leaf package. |
| `clCommitWireSchema` / `clCommitsWireSchema` / `ClCommitWire` / `ClCommit` (zod schema + snake_case→camelCase transform) | mega2 wire-format mapping is a BFF/engine adapter concern, not a core domain shape. Dropping it also lets `@megaui/core` avoid a `zod` dependency entirely (0 runtime deps). If a package needs this later it belongs in `@megaui/engine`. |
| `AvatarStatus` type, `User.status` | `@deprecated` fixture-only rail status in upstream-frontend; live presence uses collab awareness, not this field. |
| `User.team` | Fixture-only chat team handle (upstream-frontend CH-02); not a durable domain field. |
| `DirectMessageChannel.typing` | `@deprecated` fixture-only DM typing flag in upstream-frontend; not a durable domain field. |
| `Workspace.starSupported` | Backend-mode flag specific to upstream-frontend's mega2 integration ("Code backend cannot persist stars"). Backend capability negotiation is an engine/adapter concern. |
| `CL.link` | mega2-specific random 8-char CL link used for that backend's `n → link` resolution. Backend-integration detail, not a domain concept. |
| `AgentMessage.cannedId` / `AgentMessage.variantIndex` | mock/fixture provenance fields (which canned answer pool + which regenerate variant is showing). Test/demo-only, not a real domain concept. |
| `ProfilePrefs` (ST-01 profile display prefs) | Personal account settings, not a Workspace/Repo/Doc/Issue/CL/Release/Chat/Comment/Notification/ProseBlock domain shape. |
| `SshKey`, `PersonalAccessToken`, `GeneratedPersonalAccessToken` (ST-02) | Account security / credential management settings, mega2-backed. Out of scope for a domain-types package; would live with auth/settings if ever ported. |
| `WORKSPACE_NOTIFICATION_DELIVERY_MODES`, `WorkspaceNotificationDeliveryMode`, `WorkspaceNotificationSettings`, `WorkspaceNotificationPreference`, `WorkspaceNotificationConfig`, `UpdateWorkspaceNotificationConfig` | Workspace notification **delivery/config** settings (email delivery mode, locale, per-event-type opt-in). This is a settings feature, not the `Notification` domain entity itself — `Notification` / `NotificationPayload` / `NotificationKind` / `MEGA_NOTIFICATION_KINDS` are kept. |
| `SessionLayer`, `SnapshotObjectKind`, `EventObjectKind`, `SessionObjectKind`, `SnapshotSessionObject`, `EventSessionObject`, `SessionObject`, `Scheduler`, `QueryIndex`, `SessionThread`, `PatchSet`, `Provenance`, `RunUsage`, `Decision`, `EvidenceCheck`, `Evidence` | The agent-session / observability timeline model (Intent/Plan/Task/Run + 16 Snapshot/Event kinds). This is a distinct, large subsystem outside the 9 domain nouns named on the PK-01 task card (Workspace/Repo/Doc/Issue/CL/Release/Chat/Comment/Notification/ProseBlock). Not ported; revisit as its own task card if/when needed. |

### Kept as-is

Everything else ports 1:1, including `User` (trimmed to `id`, `username`,
`displayName`, `avatarUrl`, `avatarInitials`, `avatarColor`), `Workspace`,
`Package`/`PackageSymbol`, the repo browsing shapes (`SourceFile`, `TreeNode`,
`RootEntry`, `DepGraph`/`DepNode`/`DepEdge`, `ApiChange`, `SymbolUsage`),
`ProseBlock`/`ProseListItem`, the `Issue`/`Label`/`Milestone`/`Filter` family,
the `CL`/`Revision`/`CheckRun`/`PipelineStage`/`BenchTile`/`RelatedCL` family,
`Release`/`ReleaseNote`/`ReleaseAsset`, the `Doc`/`DocTag`/`DocVersion`/`Folder`
family, `Notification`/`NotificationPayload`, `MEGA_USERNAME_PATTERN`, and the
chat family (`Channel`/`WorkspaceChannel`/`DirectMessageChannel`/`ChannelMember`,
`ChatMessage`/`Thread`/`ChatSegment`, `AgentThread`/`AgentMessage`/`Citation`).

All `MEGA_*` constants (`MEGA_ISSUE_STATES`, `MEGA_ISSUE_PRIORITIES`,
`MEGA_FILTER_SORTS`, `MEGA_CL_LABELS`, `MEGA_OPEN_CL_STATES`,
`MEGA_NOTIFICATION_KINDS`, `MEGA_USERNAME_PATTERN`) live in `src/types.ts`,
matching upstream-frontend — there is no separate constants file upstream.

## Collab pure functions

Ported verbatim behavior-wise from `libs/mega/collab/**`:

- `collab/ticket.ts` — `mintCollabTicket` / `verifyCollabTicket` /
  `isCollabTicket`. HMAC-SHA256 ticket format
  `mega-collab.v1.<userId>.<expMs>.<base64url-hmac>`. Both functions take
  `secret` as an explicit parameter (never read from `process.env` inside
  this package), so the same pure functions work in any runtime that embeds
  `@megaui/core` — the caller (e.g. `@megaui/engine` or the collab server)
  owns secret sourcing.
- `collab/container.ts` — `buildContainerRoomName` / `buildDocContainerRoomName`.
- `collab/presence-color.ts` — `colorFromUserId`, a deterministic per-user
  HSL hue for carets/presence indicators.

## Content pure functions (PK-02)

Ported behavior-verbatim from `libs/mega/{filter,patch,tree-sort,linkify-plain,embed-subtree,unread-math}.ts`,
all operating on `types.ts` domain shapes (or plain JSON) — no fixture or
DB coupling:

- `filter.ts` — the compact workspace filter DSL (`parseQuery`/`serializeQuery`)
  and the single Issue/CL list predicates (GC-02) `matchesIssueFilter` /
  `matchesCLFilter`.
- `patch.ts` — `parseRevRange` and `normalizeRevRangeBounds` handle revision ranges.
  `clFilePatchForRange` selects the stored patch. `clFileForRange` pairs it with
  the additions and deletions counted by `countDiffLines`.
- `tree-sort.ts` — canonical repo/doc tree ordering (directories before
  files, each group by name).
- `linkify-plain.ts` — replaces the first plain-text occurrence of a title
  with a resolved `mega-ref` node inside serialized Lexical editor-state
  JSON (CE-42). Pure JSON walk, no Lexical runtime dependency.
- `embed-subtree.ts` — extracts the Lexical JSON subtree rooted at a given
  block id (`{{` embed resolution, CE-52/CE-53), plus the `EMBED_MAX_DEPTH`
  constant (ADR-CE-11).
- `unread-math.ts` — chat `@`-mention extraction (segments or Lexical
  `mega-ref` JSON body) and unread-watermark math (ADR-CE-05 monotonic
  merge).

`title-index.ts` has one **intentional diff vs upstream** (GC-03): the
upstream-frontend source (`libs/mega/title-index.ts`) built the index directly from
`libs/mega/fixtures/*`, a hard fixture-data coupling that would make `core`
a non-leaf package once fixtures move to `apps/web` / `packages/engine`.
This port's `buildTitleIndex` takes the doc/issue/CL/user rows as plain data
(`TitleIndexSource`) instead, so the index builder stays a pure function
with no dependency on any particular data source — callers (mock service,
future `GET /api/mega/docs/title-index` route) supply the rows.
`searchTitleIndex` (the case-insensitive substring filter) is unchanged
behavior-wise.

## `refs.ts`

`parseRefs` tokenizes prose into typed entity references (`!42` CL,
`#7` issue, `@user`, `thr_...` thread, short git SHAs) plus lossless
plain-text spans; `formatDiffStat` renders a `+N −M` diff stat using the
canonical U+2212 minus sign.

## Usage

```ts
// Browser-safe root barrel (types, refs, container, presence-color)
import { colorFromUserId, parseRefs, type CL } from '@megaui/core'

// Node-only collab ticket helpers (uses node:crypto — import the subpath)
import { mintCollabTicket, verifyCollabTicket } from '@megaui/core/collab/ticket'
```
