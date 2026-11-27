# `@megaui/engine`

Engine package: Mega API result envelope, domain errors, parsers, test-domain
fixtures, seed CLI (EG-01), workspace ACL and channel members (EG-02), and the
docs service — CRUD/rename/versions/stars, blocks, wikilink backlinks, embeds,
and the cross-entity content-link graph (EG-03).

Also the issues service — list (filter/sort/pagination), detail, comments,
state transitions (open/closed legality matrix), and watch subscriptions
(EG-04); and the CL (changelist) service core — list (filter string),
detail, comments/timeline, and the submit/review/merge/close state-machine
decision surface (EG-05).

Later cards round out the CL surface and add the remaining domains: CL
attachments — checks CRUD, dependency-graph cycle detection, inline
file/line comments, and revision creation (EG-06); chat — channels/DMs
(via EG-02's `MembersService`), messages/threads, reactions, and unread
projection (EG-07); releases — draft/publish state machine and
asset-key ownership (EG-08); notifications — idempotent event fan-out,
read/unread watermark, and bearer-gated email delivery (EG-09); PG English
full-text search over `mega_content_blocks` plus title/number-group ranking
(EG-10, `ADR-FS-01` — CJK recall is EG-14, not in this package yet);
read-only mega2 client/mappers for code-tree browsing and CL commit
history (EG-11); the agent domain — ask/regenerate orchestration over an
injectable, fail-closed LLM client (EG-12, `ADR-ARCH-06`); and collab —
ticket minting, doc-container authz, and the internal HTTP bridge to
`apps/collab-server` (EG-13). This package does **not** implement HTTP.

## Provenance (GC-03)

Ported surfaces carry a `upstream-frontend:<path>@<sha>` header. Baseline SHA `0ff3a9d`
(plan `REF-05` / `REF-07` for seed).

| File | Source path |
|---|---|
| `src/result.ts` | `libs/mega/types.ts` (`MegaApiSuccess` / `MegaApiFailure`) |
| `src/errors.ts` | `libs/mega/services/types.ts` (`MEGA_ERROR_CODES` + error classes) |
| `src/context.ts` | megaui-only (shared parsers; upstream inlined `currentUserId` / ad-hoc limits) |
| `src/testing/fixtures.ts` | `libs/mega/fixtures/{users,docs,cls,chat}.ts` |
| `src/seed.ts` | `libs/mega/services/seed-mega.ts` |
| `src/services/acl.ts` | `libs/mega/services/acl.ts` |
| `src/services/members.ts` | `libs/mega/services/members.ts` |
| `src/services/docs/docs.ts` | `libs/mega/services/docs.ts` + `libs/mega/services/repos/docs-repo.ts` |
| `src/services/docs/blocks.ts` | `libs/mega/services/blocks.ts` |
| `src/services/docs/links.ts` | `libs/mega/services/links.ts` |
| `src/services/docs/embed.ts` | `libs/mega/services/embed.ts` + `libs/mega/embed-subtree.ts` (also ported to `@megaui/core` for CE-52) |
| `src/services/docs/content-link-graph.ts` | `libs/mega/services/content-link-graph.ts` |
| `src/services/docs/types.ts` | `libs/mega/services/types.ts` (doc-shaped input/output types) |
| `src/services/docs/validation.ts` | `libs/react-shared/components/mega/content/nodes-core.ts` (Lexical node shape checks, extended for GC-11) |
| `src/services/issues/issues.ts` | `libs/mega/services/issues.ts` + `libs/mega/services/repos/issues-repo.ts` |
| `src/services/issues/types.ts` | `libs/mega/services/types.ts` (issue-shaped input/output types) |
| `src/services/cls/cls.ts` | `libs/mega/services/cls.ts` + `libs/mega/services/repos/cls-repo.ts` |
| `src/services/cls/state.ts` | `libs/mega/services/cls.ts` + `libs/mega/services/repos/cls-repo.ts` (`TRANSITIONS` / `mergeStateFor` — the two upstream copies collapse into one module here) |
| `src/services/cls/comment-body.ts` | `libs/mega/import/plain-text.ts` (CL-comment scope only) |
| `src/services/cls/description.ts` | `libs/mega/services/repos/cls-repo.ts` (`normalizeCLDescriptionJson` / `plainSummaryFromDescription`) |
| `src/services/cls/types.ts` | `libs/mega/services/cls.ts` (`CreateCLInput`) |
| `src/services/cls/checks.ts` | `libs/mega/services/repos/cls-repo.ts` (`CLChecksView` / `getCLChecks` / `designChecksSnapshot`) |
| `src/services/cls/deps.ts` | `libs/mega/services/repos/cls-repo.ts` (`CLDependencyView` / `getCLDependencyGraph` / `designDependencySnapshot`) |
| `src/services/cls/inline.ts` | `libs/mega/services/repos/cls-repo.ts` (`parseFiles` / inline comment CRUD) |
| `src/services/cls/revisions.ts` | `libs/mega/services/repos/cls-repo.ts` (`parseRevisions`) |
| `src/services/cls/authz.ts` | `libs/mega/services/cls.ts` (`CURRENT_USER` gate) |
| `src/services/cls/envelope.ts` | `libs/mega/services/repos/cls-repo.ts` (`loadClContent` / `writeClEnvelope` / `asEnvelope`) |
| `src/services/cls/ids.ts` | `libs/mega/services/store.ts` (`nextId`) |
| `src/services/cls/users.ts` | `libs/mega/services/repos/cls-repo.ts` (`toMegaUser` / `userById`) |
| `src/services/chat/chat.ts` | `libs/mega/services/chat.ts` |
| `src/services/chat/messages.ts` | `libs/mega/services/chat.ts` (message/thread CRUD slice) |
| `src/services/chat/limits.ts` | `libs/mega/services/chat.ts` (megaui-only GC-10 input ceiling) |
| `src/services/chat/users.ts` | `libs/mega/services/chat.ts` (private user-row hydration) |
| `src/services/chat/reactions.ts` | `libs/mega/types.ts` (`Reaction` wire shape) |
| `src/services/chat/unread.ts` | `libs/mega/services/unread.ts` |
| `src/services/chat/content.ts` | `libs/mega/services/repos/chat-repo.ts` (`packChatContentBody` envelope) |
| `src/services/chat/channels.ts` | `libs/mega/services/repos/chat-repo.ts` (`loadChannel` slice) |
| `src/services/chat/types.ts` | `libs/mega/services/types.ts` (chat-shaped input/output slice) |
| `src/services/releases/releases.ts` | `libs/mega/services/releases.ts` + `libs/mega/services/repos/releases-repo.ts` |
| `src/services/releases/asset-key.ts` | `libs/mega/services/repos/releases-repo.ts` (megaui-only key-ownership addition; upstream never persists assets) |
| `src/services/releases/types.ts` | `libs/mega/services/repos/releases-repo.ts` (`DraftReleaseInput` shape) |
| `src/services/notifications/notifications.ts` | `libs/mega/services/notifications.ts` + `libs/mega/services/unread.ts` |
| `src/services/notifications/notification-delivery.ts` | `libs/mega/services/notification-delivery.ts` |
| `src/services/notifications/unread.ts` | `libs/mega/unread-math.ts` (watermark semantics ported to a per-row shape) |
| `src/services/notifications/types.ts` | `libs/mega/services/types.ts` (notification-shaped input/output slice) |
| `src/services/search/english.ts` | `libs/mega/services/search.ts` (English `plainto_tsquery`/`ts_rank` behavior, reimplemented over `ADR-FS-01`) |
| `src/services/search/title.ts` | `libs/mega/services/search.ts` (`searchTextScore` rank order, reimplemented from the ADR's behavior spec) |
| `src/services/search/limits.ts` | `libs/mega/services/search.ts` (fetch-window/limit budgets shared with EG-14) |
| `src/services/search/types.ts` | `libs/mega/services/search.ts` (body-search vocabulary/types) |
| `src/services/mega2/client.ts` | `libs/mega/services/monoengine/client.ts` |
| `src/services/mega2/code-backend.ts` | `libs/mega/services/monoengine/code-backend.ts` |
| `src/services/mega2/mappers.ts` | `libs/mega/services/monoengine/mappers.ts` |
| `src/services/mega2/types.ts` | `libs/mega/services/monoengine/types.ts` |
| `src/services/agent/agent.ts` | `libs/mega/services/agent.ts` (ask/regenerate orchestration slice) |
| `src/services/agent/llm.ts` | `libs/mega/services/agent.ts` (LLM call slice) |
| `src/services/agent/store.ts` | `libs/mega/services/agent.ts` (persistence slice) |
| `src/services/agent/types.ts` | `libs/mega/services/agent.ts` (input/output slice) |
| `src/services/collab/token.ts` | `apps/next-app/lib/mega-api.ts` (ticket-minting core extracted from the route handler) |
| `src/services/collab/authz.ts` | `libs/mega/services/collab-authz.ts` (doc-container slice only) |
| `src/services/collab/internal-bridge.ts` | `libs/mega/services/collab-bridge.ts` (generic config + transport only) |

`src/index.ts` and `src/services/docs/index.ts` are barrels (no provenance
header), same convention as `@megaui/auth`.

## Diffs vs upstream (intentional — registered on the EG-01 task card)

| Upstream surface | Disposition here | Why |
|---|---|---|
| `MegaApiSuccess` / `MegaApiFailure` lived in `libs/mega/types.ts` (and PK-01 kept them out of `@megaui/core`) | Owned by `@megaui/engine` as the service-layer result contract | Transport envelope, not a domain noun; WA-03 maps it to HTTP |
| `libs/mega/services/store.ts` mock backend + `MEGA_*_DATA_BACKEND=mock` | Not ported | DEBT-04: runtime zero mock |
| Full `MEGA_FIXTURES` dump (packages, source files, 72 chat lines, agent, sessions, …) | Small representative samples only | Card scope is users/docs/CL/chat samples, not every fixture file |
| `User.status` / `User.team` | Dropped | Already stripped in `@megaui/core` |
| SaaS seed (blog posts, orders, branded default users like legacy-demo-brand copy) | Not ported | SaaS 剥离; seed writes only mega_* + auth `user` rows |
| Markdown-outline import, FTS rebuild, mega2 commit probe | Not ported | Later EG-* / EG-10 cards |
| Fixtures exported from the main `@libs/mega` barrel | Isolated at `@megaui/engine/testing` | DEBT-04 + EG-01 AC2 |

## Diffs vs upstream (intentional — registered on the EG-02 task card)

| Upstream surface | Disposition here | Why |
|---|---|---|
| CASL `Ability` builder | Closed `evaluateAcl` role×action matrix | Card AC + GC-07; drop the CASL dependency |
| ADR-CE-11 `default_open_editor` (any signed-in user can write) | Deny anonymous **and** non-members | GC-07 fail-closed; collaborator rows are the source of truth |
| `MEGA_DOCS_DATA_BACKEND=mock` / `store.ts` | Not ported | DEBT-04 |
| Members mock backend + `ensureMockWorkspaceUser` | Injected `Database` only | DEBT-04; no process-wide singleton |
| Invite notification fan-out | Omitted | EG-09 |
| Last channel admin removable | Denied (`Cannot remove the last channel admin`); check runs under `FOR UPDATE` | Card AC: 移除 owner 边界; GC-08 |
| Public workspace channels | Authenticated users may read without a member row | Kind=`public` is the visibility grant; private/DM stay member-only |
| Unauthenticated actor → `MegaForbiddenError` | `MegaUnauthorizedError` (401) | Aligns no-session vs wrong-role with GC-04 |
| DM id `dm_${a}_${b}` (truncates / `_`-ambiguous) | `dm_` + sha256(sorted NUL-joined ids) | Collision-free pair key (Codex P1) |
| `searchUsersForInvite` | Not ported | Invite UI / WA-* card; not in EG-02 ACs |
| Upstream `ensureDmMemberPair` as a public service method | Not exposed; DM membership is written only inside `openOrCreateDm`'s transaction | GC-07: avoid an authz-bypass insert helper |
| Upstream peer `lastReadMessageId` helper exposed on the service | Kept private to `openOrCreateDm` (not on the returned service) | GC-07: watermark lookup must not bypass channel access |

## Diffs vs upstream (intentional — registered on the EG-03 task card)

| Upstream surface | Disposition here | Why |
|---|---|---|
| `MEGA_DOCS_DATA_BACKEND=mock` / in-memory `store.ts` doc map | Not ported | DEBT-04: runtime zero mock |
| Doc repo is an in-memory array (`repos/docs-repo.ts`) | Drizzle PG repo over `megaDocs` / `megaContent` / `megaDocVersions` / `megaDocStars` / `megaDocCollaborators` | Card constraint: inject `Database`, real persistence |
| ADR-CE-11 `default_open_editor` (any signed-in user can write any doc) | `createAclService` role×action matrix (owner/editor/viewer/none); anonymous and non-collaborators denied | GC-07 fail-closed, consistent with EG-02's ACL |
| `Client`-side-only Lexical shape enforcement before save | Server-side `validateDocBodyJson` — rejects malformed JSON, illegal/duplicate block ids, and bodies over `MAX_DOC_BODY_BYTES` | GC-11: illegal block payloads / oversized content must fail server-side, not just in the editor |
| Version numbering assumed single-process, no race handling | `(docId, version)` DB unique index + row lock on `megaDocs` during save; a residual unique-violation still maps to `MegaConflictError` | Card AC: concurrent save conflict semantics under a real DB |
| Tags (`docTagIds` / tag CRUD) | Omitted | Not in EG-03 write set; no `megaDocTags`-equivalent wiring in this card |
| Doc comments (`listDocComments` / `addDocComment`) | Ported as plain-text list+create with `acl.assert(..., "read")`; `commentCount` is COUNT | ADR-DC-01 / DC-01; edit/delete/reactions and comment link/block rebuild remain omitted |
| Issue / CL nodes and edges in `content-link-graph` | Passed through unfiltered (no ACL check) | Issue/CL graph nodes have no doc-style ACL; EG-04/EG-05 keep list/get reads open (mutations gated). Doc nodes/edges remain ACL-filtered fail-closed |
| `resolveOrCreateDoc` / `resolveEmbed` / `getContentLinkGraph` as `DocsService` methods | Standalone functions taking `(database, acl, ...)` | Avoids a `docs.ts` ↔ `links.ts`/`embed.ts` import cycle; `createDocsDomain` still wires `BlocksRepo`/`LinksRepo` for callers |
| Independent post-save link/block rebuilds (race-prone) | Content write + link/block rebuild share one TX under per-doc `pg_advisory_xact_lock` | Rebuild failure rolls back the body write; concurrent save/delete cannot leave stale indexes |
| `resolveOrCreateDoc` rethrows `TITLE_CONFLICT` when the live title is private | Non-disclosing `MegaConflictError("Unable to create document")` | GC-07: title existence must not leak via error code |
| `bodyFormatVersion: 1` on every write; empty `root.children` accepted | Writes `BODY_FORMAT_VERSION_BLOCK_TREE` (2); `normalizeDocBodyJson` on load + `prepareWritableDocBody` on write | Editor requires a mega-block tree; consumers must not treat block-tree JSON as legacy v1 |
| Full-text/plain-text "unlinked mentions" scan (`listDocUnlinked`) matched against every doc/issue/CL title in-memory | Same behavior, but title index and mention scan run as bounded DB queries | No mock backend; matches upstream-frontend's matching semantics against real rows |

## Diffs vs upstream (intentional — registered on the EG-04 task card)

| Upstream surface | Disposition here | Why |
|---|---|---|
| `MEGA_ISSUES_DATA_BACKEND=mock` / `store.ts` in-memory issue map / `getIssuesDataBackend()` | Not ported | DEBT-04: runtime zero mock; drizzle PG is the only backend |
| No ACL / authz model on issues at all (`CURRENT_USER` trusted implicitly) | `assertWorkspaceMember` fail-closed gate on every mutation (`createIssue`, `addIssueComment`, `toggleIssueWatch`, `transitionIssueState`, `saveIssueBody`, `toggleIssueReaction`, `toggleIssueCommentReaction`): unauthenticated → `MegaUnauthorizedError`, `actorUserId` not a row in `user` → `MegaForbiddenError` ("non-member") | Card AC: comment permission must deny non-members (GC-07 fail-closed); generalized to one consistent authz baseline instead of comment-only |
| `closeIssue`: single idempotent one-way action, no reopen; repeat close on an already-closed issue silently succeeds | `transitionIssueState(number, "close" \| "reopen", actorUserId)`: only `open→closed` and `closed→open` are legal; every other (state, action) pair throws `MegaConflictError` | Card AC: full state-transition legality matrix with illegal transitions rejected |
| `listIssues(filter?)` returns every matching row, no pagination | `listIssues({ filter?, pagination? })` returns `{ items, total, offset, limit }` via the shared `parsePagination` parser; empty results and out-of-range offsets both return `items: []`, never an error | Card AC: list pagination (empty state, out-of-range page) |
| `normalizeIssueBodyJson` / `normalizeCommentBodyJson` — Lexical EditorState JSON via `import/plain-text.ts` | Plain text stored directly as `mega_content.body_json = { text }` (container types `issue` / `issue_comment`) | `import/plain-text.ts` (Lexical import pipeline) has not been ported to `@megaui/engine`; out of this card's write set |
| `getIssueBody` / `saveIssueBody` | Ported as plain-text `{ text }` (no Lexical). GET missing content is `{ body: "" }`. Save is `assertWorkspaceMember` then author-or-assignee; one TX upserts content and bumps `mega_issues.updatedAt`; no post-write link/block rebuild | IB-01 / ADR-IB-01 |
| `toggleIssueReaction` / `toggleIssueCommentReaction` | Ported as `ReactionRow` persist + per-actor `Reaction[]` projection (reuses EG-07 helpers). Toggle is `assertWorkspaceMember` then any member; issue toggle bumps `updatedAt`; comment toggle does not. No post-write link/block rebuild | RX-01 / ADR-RX-01 |
| post-write link/block index rebuild hooks | Not ported | Content-graph surfaces remain deferred (`DEFER-IB-*` / `DEFER-RX-*`) |
| Label catalog (`ISSUE_LABELS` fixture) resolving `labelIds` → `Label[]` | Workspace label names are stored in `labelIds` and projected as labels. The property picker reads distinct labels, projects and milestones from persisted issues | Workspace-defined names can be added during issue creation |
| Bare `MAX(number)+1` read with no race guard | `mega_issues.number` allocation serialized under a dedicated `pg_advisory_xact_lock` namespace | GC-08: concurrent `createIssue` calls must not collide on the same number |
| Issue/CL ACL described as "not implemented yet" in `docs/links.ts` (EG-03) | Still true for reads (`listIssues`/`getIssue`/`listIssueComments` stay open, matching upstream-frontend) — only mutations gained the new membership gate above | EG-04 adds a mutation-only authz baseline, not a full doc-style read ACL; registered as a partial, not a contradiction of the EG-03 note |

## Diffs vs upstream (intentional — registered on the EG-05 task card)

| Upstream surface | Disposition here | Why |
|---|---|---|
| `MEGA_CLS_DATA_BACKEND=mock` / `store.ts` in-memory CL map / `getClsDataBackend()` / `CURRENT_USER` global | Not ported | DEBT-04: runtime zero mock; drizzle PG is the only backend; every method takes an explicit `actorUserId` instead |
| `transitionCLState(number, target)` — no actor param, no permission check; any caller can drive any CL through the matrix | `transitionCLState(number, target, actorUserId)`: fail-closed permission×state decision surface (`decideCLTransition` in `state.ts`, card AC2) — only the CL author may transition; unauthenticated → `MegaUnauthorizedError`, non-author → `MegaForbiddenError` | Card AC2: "状态流转决策矩阵测试（权限 × 状态）" — GC-07 fail-closed default applies to state transitions, not just description edits |
| Two copies of `TRANSITIONS` / `mergeStateFor` (mock backend in `cls.ts`, DB backend in `cls-repo.ts`) | One `CL_STATE_TRANSITIONS` / `mergeStateForTransition` in `state.ts`, a pure module with no DB dependency | GC-02 single source of truth; also makes the full permission×state matrix unit-testable without Postgres |
| `mockCreateCL` / `addCLComment` reject with a raw `TypeError` | `MegaBadRequestError` / `MegaUnauthorizedError` | GC-11: no raw JS errors on a production write path |
| Bare `MAX(number)+1` read with no race guard | `mega_cls.number` allocation serialized under a dedicated `pg_advisory_xact_lock` namespace | GC-08: concurrent `createCL` calls must not collide on the same number (same hardening as EG-03 doc versions and EG-04 issue numbers) |
| `normalizeCommentBodyJson` / `normalizeCLDescriptionJson` via `libs/mega/import/plain-text.ts` + `markdown-outline.ts` (`importMarkdownOutline`, headings/lists/`semanticIssueRefs`) | `comment-body.ts` ports the plain-text→Lexical importer (line-based mega-blocks + `#N`/`!N`/`@user` → `mega-ref` promotion); `description.ts` reuses the same importer instead of `importMarkdownOutline` | The markdown-outline import pipeline has not been ported (registered EG-01/EG-03 omission already); headings/lists in a CL description collapse to plain-text blocks, `#N`/`!N`/`@user` refs still promote |
| `promotePlainRefsInEditorState` (re-scanning an already-Lexical payload for bare ref tokens) | Not ported | This card's comment/description composer always submits plain text, never pre-built Lexical JSON with embedded plain-text refs to promote; a body arriving as `{ root: ... }` passes through unchanged |
| `getCLChecks` / `getCLDependencyGraph` / `setCLFileViewed` / `listInlineComments` / `addInlineComment` / `replyInlineComment` / `resolveInlineComment` | Not ported | EG-06 (CL attachments), same `cls/**` directory, serialized after this card |
| `listCLCommits` (mega2 commit chain) | Not ported | EG-11 |
| `CL.revisions` populated from `mega_cls.revisions` JSON (commits/rebase/reviewerState/ci) | Always `[]` in this card | This card never writes populated revision rows; EG-06 owns revision creation/parsing |
| `CL.files` fully parsed (path/status/diffs/rangePatches) | Parsed defensively (path/status/additions/deletions/patch/viewed/commentCount) but always `[]` in practice — this card never writes non-empty `files` | `setCLFileViewed` / diff-view writers are EG-06 scope |
| `mega_cls.subscribed` global boolean toggled by any caller (`cls-repo.ts` `toggleCLSubscription`) | Same global bit — `toggleCLSubscription` flips `mega_cls.subscribed` for the row (not per-actor). `CL.subscribed` JSDoc says "current viewer" but upstream-frontend never stored per-viewer subscriptions either | Matching upstream storage; a per-viewer subscription table is out of this card's scope (would need a schema addition) |
| Issue/CL ACL described as "not implemented yet" in `docs/links.ts` (EG-03) | Still true — `listCLs`/`getCL`/`listCLComments` stay open (no ACL), matching upstream-frontend's workspace-wide CL visibility; mutations require `assertWorkspaceMember` (live `user` row) plus author checks where applicable | CLs have no per-CL collaborator table (unlike docs); membership + author gates are this card's authz baseline, consistent with EG-04 |
| Description/comment body writes leave `mega_content_links` / `mega_content_blocks` untouched | `createCL` / `saveCLDescription` / `addCLComment` rebuild both indexes in the same write transaction via EG-03's `replace*ForSourceOnTx` | Backlinks/content-link-graph must see CL/comment refs; GC-08 atomicity with the body write |

## Diffs vs upstream (intentional — registered on the EG-06 task card)

CL attachments: checks CRUD, dependency-graph annotation, inline file/line
comments, and revision creation.

| Upstream surface | Disposition here | Why |
|---|---|---|
| `designChecksSnapshot()` / `designDependencySnapshot()` — a process-global fixture the mock store designs the first time a CL is read, then persists | Not ported (DEBT-04) | `getCLChecks`/`getCLDependencyGraph` return an empty view/graph until `upsertCLCheckRun`/`setCLDependencyGraph` writes real rows — no fixture-seeded snapshot |
| Checks / dependency graph are read-only upstream (fixture-only) | `upsertCLCheckRun` / `deleteCLCheckRun` (AC1 "checks CRUD") and `setCLDependencyGraph` are new writes | Card scope requires a real write path where upstream only ever read a fixture |
| Dependency graph is never annotated | `detectDependencyCycles` (AC3): a pure DFS returning every simple cycle as frontend xyflow layout input | Layout-hint data — a cyclic package graph is not rejected, only annotated |
| `addInlineComment`: `Number.isSafeInteger(line) && line >= 1`, no upper bound, no `revision` validation | Also rejects `line` past the file's own diff length and an unknown `revision` (both `MegaBadRequestError`, AC2) | OOB line / invalid revision must be rejected, not silently anchored past the diff |
| `createCLRevision` — no such upstream API; `mega_cls.revisions` is fixture-seeded, read-only | Added, fail-closed on a blank `sha` (`MegaBadRequestError`), gated by `assertWorkspaceMember` | EG-05's header registered "CL.revisions is always `[]` — EG-06 owns revision creation" |
| `commitList` / `reviewerState` populated on revision creation | Always `[]` on a freshly created revision | EG-11 (mega2 commit chain) and the EG-05 reviewer matrix are not wired into revision creation |
| `TypeError` / `RangeError` (upstream, mock backend) | `MegaBadRequestError` | GC-11: no raw JS errors on a production write path |

## Diffs vs upstream (intentional — registered on the EG-07 task card)

Chat: channels/DMs, messages/threads, reactions, unread projection.

| Upstream surface | Disposition here | Why |
|---|---|---|
| Channel CRUD / membership forked inside `chat.ts` | Reuses EG-02's `createMembersService` as-is, composed via `createChatDomain` | Task card instruction: "reuse `createMembersService`, do not fork" |
| `toggleMessageReaction` takes no actor, no lock (single-viewer mock store) | Requires explicit `actorUserId`, channel-access-gated, `FOR UPDATE`-locked | GC-08: concurrent toggles cannot race past the GC-10 reaction-capacity check |
| `Reaction` wire shape (`{ emoji, count, reactedByMe }`) computed against one process-wide `CURRENT_USER` | Rows carry the reactor-id set (`ReactionRow.userIds`); `projectReactions` derives the wire shape per viewing actor | A real multi-actor service cannot recover "did *this* actor react" from a bare boolean once two different callers ask |
| No server-side input ceiling (mock store + single-process editor never needed one) | `validateChatSegments` / `assertReactionCapacity` (GC-10): message segment count, combined text length, serialized byte size, and distinct-reaction-emoji count are all capped | GC-10 performance budget: no unbounded-memory write path |
| Message segments + thread routing stored however `chat-repo.ts`'s mock shape happened to hold them | `mega_content` under container type `chat_message`, minus the Lexical `root` key (`./content.ts`) | Same envelope upstream's `packChatContentBody` writes; no Lexical chat body is ported (registered on `./types.ts`) |
| `listChannels(actorUserId?)`: `actorUserId === undefined` (vs. `null`) is a trusted-internal-caller escape hatch that skips ACL filtering entirely | Removed (ER-05 P1) — `undefined`/`null`/empty are all "no actor" and always go through `filterChannelsForActor` | Fail-open ACL bypass on a real multi-tenant service; no internal caller here needs the unfiltered list |
| Chat mutations do not notify collab | send/reply `append` the message id; edit/reaction `bump` revision. Bridge skip/HTTP failure never rolls back the PG write | RT-07 / ADR-RT-01: Y.Doc is a hint channel, not the message store |

## Diffs vs upstream (intentional — registered on the EG-08 task card)

Releases: draft/publish state machine, asset-key ownership.

| Upstream surface | Disposition here | Why |
|---|---|---|
| `MEGA_RELEASES_DATA_BACKEND` mock/database switch | Not ported (DEBT-04) | drizzle PG is the only backend, same as the other EG-04/05 services |
| No permission check on any mutation | Every mutation takes an explicit `actorUserId` and gates through `assertWorkspaceMember` | GC-07 fail-closed default |
| Tags page only ever creates drafts — no draft→publish mutation at all | `publishRelease` added: `draft --publish--> published`, duplicate publish rejected with `MegaConflictError` | Card AC requires the state machine; there is no upstream precedent to diverge from |
| "Assets are not persisted in v1" — no asset metadata table, no ownership check | `buildReleaseAssetKey` / `assertReleaseAssetKeyOwnership` (`releases/{releaseId}/{fileName}`, GC-07 fail-closed) | Card AC "asset key ownership"; the actual object-storage upload/presign path is WA-19, out of scope here |

## Diffs vs upstream (intentional — registered on the EG-09 task card)

Notifications: idempotent event fan-out, read/unread watermark, bearer-gated email delivery.

| Upstream surface | Disposition here | Why |
|---|---|---|
| `MEGA_NOTIFICATIONS_DATA_BACKEND` mock/database switch; webhook delivery channel | Not ported (DEBT-04) | drizzle PG is the only backend; webhook retry surface dropped (DEFER-RW-06) |
| No idempotency-key concept — replaying an event risks duplicate rows | Row id is `deterministicNotificationId(userId, idempotencyKey)` (sha256) + `.onConflictDoNothing()` | AC1: replaying the same event for the same recipient always resolves to the same row, not a race-prone check-then-insert |
| `mega_notifications` has no per-row `read_at` watermark math of its own (an ordered chat-style watermark exists in `unread-math.ts`, a different domain) | `unread.ts` ports that watermark's *semantics* (monotonic, idempotent) to the per-row `read_at` shape | AC2: unread aggregation + monotonic read transitions, same rules as the chat watermark, different storage shape |
| No email-delivery auth surface | `compareBearerToken` / `extractBearerToken` (constant-time) gate `MEGA2_INTERNAL_MAIL_BEARER` | Card AC; the actual HTTP route consuming this is WA-05, out of scope here |
| Barrel not wired into the package root (registered on this card's own header) | Wired here — `createNotificationsDomain` is now on the root barrel | This integration task is the one the EG-09 header deferred to |

## Diffs vs upstream (intentional — registered on the EG-10 task card, `ADR-FS-01`)

Search: PG English full-text search + title/number-group ranking.

| Upstream surface | Disposition here | Why |
|---|---|---|
| `libs/mega/services/search.ts`'s `searchTextScore` / body search — not vendored, no reference implementation in this repo | Reimplemented from the ADR's documented behavior spec only (rank order exact < prefix < word-boundary < substring for titles; `plainto_tsquery`+`ts_rank` for body) | REF-05 marks the file itself out of scope; only its documented behavior is a source of truth here |
| CJK substring recall (window + round-robin + `SearchCjkScaleExceededError`) | Not implemented in this package | EG-14, explicitly split out (`ADR-FS-01`, `SP-01` go/no-go) |
| `channel` / `comment` / `release` search kind aliases | Excluded from `BODY_FTS_KINDS` | ADR-FS-01 explicitly forbids those non-body kinds |
| Title search and body FTS share one ranking pass | Kept separate: `title.ts`'s graded rank never touches `text_search`; body FTS has no `setweight` title>body inside the generated column | ADR-FS-01 §③: title stays app-layer, not blended into the tsvector |

## Diffs vs upstream (intentional — registered on the EG-11 task card)

Mega2: read-only client for code-tree browsing and CL commit history.

| Upstream surface | Disposition here | Why |
|---|---|---|
| `postJson` / `putJson` / `deleteJson` / `postCommonResultJson` / `putCommonResultJson` / `postCommonResultVoid` / `deleteCommonResultVoid` (write endpoints: create-entry, edit/*, credentials, notifications) | Not ported | Card scope is the 5 read-only `GET` endpoints on REF-02 only |
| Standalone `Mega2ApiError` | Engine's own `Mega*` domain errors (`MegaUnauthorizedError`/`MegaForbiddenError`/`MegaNotFoundError`/`MegaBadRequestError`/`MegaInternalError`) thrown directly | Single domain-error exit (DEBT-03/GC-04); 401/403/404/400/5xx classification is unchanged |
| `getJson` / `getCommonResultJson` untyped | Generic over a zod schema (`getMega2Json` / `getMega2CommonResult`), validates the response shape | Type-safe response parsing at the one integration boundary this package doesn't control |

## Diffs vs upstream (intentional — registered on the EG-12 task card, `ADR-ARCH-06`)

Agent: ask/regenerate orchestration over an injectable LLM client.

| Upstream surface | Disposition here | Why |
|---|---|---|
| Credit pre-authorization/deduction before calling DeepSeek; 402 on insufficient balance | No billing gate at all | SaaS 剥离 — this product has no credits/billing feature |
| SSE streaming built into `askAgent` itself | Not this package's job — `ask`/`regenerate` call the LLM once (non-streaming `doGenerate`) and return the final thread state | WA-06 fans a single completion out as SSE chunks; out of scope on this card |
| DeepSeek-specific SDK | `@ai-sdk/openai-compatible` (`LanguageModelV4`) | ADR-ARCH-06: the one third-party LLM dependency this repo depends on is provider-agnostic, not vendor-locked |
| No fail-closed behavior when LLM config is absent | `resolveAgentLlmConfig` returns `undefined` when `AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL` aren't all set; `ask`/`regenerate` then resolve `{ status: "llm_disabled" }` instead of throwing | ADR-ARCH-06 fail-closed default |

## Diffs vs upstream (intentional — registered on the EG-13 task card)

Collab: ticket minting, doc-container authz, internal HTTP bridge to `apps/collab-server`.

| Upstream surface | Disposition here | Why |
|---|---|---|
| Minted directly inside the `/api/mega/collab/token` route handler dispatch, reading `process.env` and calling `auth.api.getSession` itself | Session-gated core extracted into `@megaui/engine`, decoupled from HTTP/cookie transport | Both the BFF route (WA-05) and any future call site share one fail-closed implementation |
| `assertCanJoinCollab` (ADR-CE-11 "default open editor" gate on minting) | Dropped | `createCollabAuthzService` judges per-document access only at write time (AC2) — no open-by-default minting gate |
| `collab-authz.ts` covers doc/channel/chat-message/inbox rooms + an open-editor fallback for any authenticated user | Doc-container-only, reuses the EG-02 closed role×action matrix instead of an open default | Chat/channel/inbox room kinds land in EG-07..10/WA-05, out of scope for this card; fail-closed by construction (no ACL row/role ⇒ no access, GC-07) |
| `collab-bridge.ts` also derives the internal URL from `MEGA_COLLAB_PUBLIC_URL` and ships concrete actions (rename, collection append, inbox unread push) | Generic `postInternal` plus RT-07 `appendCollectionChild` / `bumpCollectionRevision` after chat mutations; **no inbox unread push** | Chat hints only (ADR-RT-01); unread stays on PG watermark (DEBT-RT-03) |

## Public surface

```ts
import {
  megaOk,
  serializeMegaError,
  requireSession,
  parsePagination,
  MegaNotFoundError,
  createAclService,
  createMembersService,
  createDocsDomain,
  createIssuesDomain,
  createClsDomain,
  createChatDomain,
  createReleasesDomain,
  createNotificationsDomain,
  searchEnglish,
  fetchWorkspace,
  createAgentDomain,
  createCollabDomain,
} from "@megaui/engine";
import { USERS, SAMPLE_DOC } from "@megaui/engine/testing";
import { seedMegaDatabase } from "@megaui/engine/seed";

const { docs, linksRepo, blocksRepo } = createDocsDomain(database);
const { issues } = createIssuesDomain(database);
const page = await issues.listIssues({ filter: { states: ["open"] }, pagination: { limit: 20 } });
const { cls } = createClsDomain(database);
const created = await cls.createCL({ title: "Add streaming diff viewer", packageId: "pkg_engine", branch: "b" }, userId);
await cls.transitionCLState(created.number, "ready", userId);

const { chat } = createChatDomain(database);
await chat.sendChatMessage({ channelId, segments: [{ type: "text", text: "shipped" }] }, userId);

const { releases } = createReleasesDomain(database);
const draft = await releases.createDraftRelease({ tag: "v0.2.0", title: "0.2.0", targetSha: "abc123" }, userId);
await releases.publishRelease(draft.id, userId);

const { notifications } = createNotificationsDomain(database);
await notifications.notifyEvent({
  userId,
  kind: "cl_ready",
  entityType: "cl",
  entityId: String(created.number),
  url: `/cls/${created.number}`,
  summary: "CL is ready for review",
  idempotencyKey: `cl_ready:${created.number}`,
});

const hits = await searchEnglish(database, { query: "streaming diff viewer" });
const workspace = await fetchWorkspace(); // reads MEGA_CODE_* env for the mega2 base URL/repo

// Fails closed with `{ status: "llm_disabled" }` when AI_BASE_URL/AI_API_KEY/AI_MODEL are unset (ADR-ARCH-06).
const { agent } = createAgentDomain(database);
const thread = await agent.createThread({ title: "CL review" }, userId);
await agent.ask(thread.id, { message: "Summarize this CL" }, userId);

const { token, authz } = createCollabDomain(database);
const ticket = token.mintForSession({ userId });
await authz.resolveDocAccess(docId, userId);
```

Root barrel exports **must not** include fixtures. Importing
`@megaui/engine/testing` from production code is a DEBT-04 violation;
`exports.test.ts` guards the split.

## Seed CLI

Idempotent (`ON CONFLICT DO NOTHING`). Applies drizzle migrations, then
inserts the sample users / doc / CL / channel / messages.

```sh
DATABASE_URL=postgres://megaui:megaui@localhost:5432/website \
  pnpm --filter @megaui/engine seed
```

The script runs via `tsx` (workspace TypeScript, not native `node` on `.ts`
files) so the package's extensionless ESM imports resolve.

Prints `{ "ok": true, "inserted": n, "skipped": n }` (no connection string).
Re-running against the same database increments `skipped` and does not
duplicate rows.

The unit suite `src/seed.test.ts` uses a throwaway database created from
`DATABASE_URL` (CREATEDB). It never migrates the database named in
`DATABASE_URL` itself. Missing `DATABASE_URL` skips locally and hard-fails
in CI.

## Dependencies (ADR-ARCH-01)

`@megaui/engine` may depend on `core` / `content` / `database` / `i18n` /
`email` and must not depend on `ui` or `apps/*`. This card uses
`core` (`EMBED_MAX_DEPTH`, `extractBlockSubtreeJSON`, title-index helpers),
`content` (empty-doc JSON, Lexical node type guards for docs/blocks/refs/embeds),
`database`, plus `zod`, `drizzle-orm`, and `tsx` (seed CLI runner). i18n keys
and email sending are later cards.

The agent domain (EG-12, `ADR-ARCH-06`) adds exactly one more third-party
dependency: `@ai-sdk/openai-compatible` (a `LanguageModelV4` client for any
openai-compatible endpoint, not a DeepSeek-specific SDK). `exports.test.ts`
pins the full allowed-dependency list so an accidental new dependency fails
CI instead of silently landing.
The package `tsconfig` includes the DOM lib because `@megaui/content` Lexical
node types reference `HTMLElement` / `document` (same as the content package
itself).
