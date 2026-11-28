// megaui:libs/mega/services/issues.ts@0ff3a9d
// megaui:libs/mega/services/repos/issues-repo.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-04 task card):
// - No `MEGA_ISSUES_DATA_BACKEND` mock/database switch or `store.ts`
//   fixture backend (DEBT-04) — this is the only (drizzle PG)
//   implementation; `getIssuesDataBackend()` is not ported.
// - Single PG dialect (ADR-ARCH-02): no sqlite/d1 `withIssuesTx` branch —
//   every mutation that touches more than one row runs in a real
//   `database.transaction`.
// - No workspace/channel/doc-style ACL exists for issues yet (EG-04/EG-05
//   registered omission, see `docs/links.ts`); reads (`listIssues`,
//   `getIssue`, `getIssueBody`, `listIssueComments`) stay open like upstream. Mutations
//   (`createIssue`, `addIssueComment`, `toggleIssueWatch`,
//   `transitionIssueState`, `saveIssueBody`, `toggleIssueReaction`,
//   `toggleIssueCommentReaction`) gate through `assertWorkspaceMember` instead —
//   a **new** invariant not present upstream (upstream trusted a single
//   process-wide `CURRENT_USER`): unauthenticated → `MegaUnauthorizedError`,
//   authenticated but not a row in the `user` table → `MegaForbiddenError`
//   ("non-member"). This is the card AC's fail-closed comment-permission
//   check (GC-07), generalized to every issue mutation for one consistent
//   authz baseline.
// - `IssueTransitionAction` (`close` | `reopen`) replaces upstream's single
//   idempotent `closeIssue` (upstream has no reopen and treats a repeat
//   `closeIssue` on an already-closed issue as a no-op success). This card's
//   AC requires a full state-transition legality matrix with illegal
//   transitions rejected, so `transitionIssueState` throws
//   `MegaConflictError` for `close` on an already-closed issue and `reopen`
//   on an already-open issue, instead of silently succeeding.
// - `listIssues` adds pagination (`ListIssuesInput.pagination` via the
//   shared `parsePagination` parser) — upstream's `listIssues(filter?)`
//   returned every matching row. Out-of-range offsets and empty result sets
//   both return `{ items: [], total, offset, limit }`, never an error.
// - Issue/comment `body` is plain text stored directly as
//   `mega_content.body_json = { text }` (container types `issue` /
//   `issue_comment`), not Lexical EditorState JSON. Upstream's
//   `normalizeIssueBodyJson` / `normalizeCommentBodyJson` depend on
//   `import/plain-text.ts` (not ported to `@megaui/engine` — no plain-text
//   → Lexical pipeline exists yet). `getIssueBody` / `saveIssueBody` are
//   ported as plain-text `{ text }` (IB-01 / ADR-IB-01): missing content
//   reads as `{ body: "" }`; save is `assertWorkspaceMember` then
//   author-or-assignee, upserts content and bumps `mega_issues.updatedAt`
//   in one TX, and does not rebuild link/block indexes. Reactions persist
//   `ReactionRow { emoji, userIds }` and project `Reaction[]` per viewing
//   actor (RX-01 / ADR-RX-01), reusing EG-07 `parseReactionRows` /
//   `projectReactions` / `toggleReactionRow`. Toggle is member-gated
//   (not author-or-assignee); issue toggle bumps `updatedAt`; comment
//   toggle does not. Legacy wire-shaped jsonb without `userIds` projects
//   as empty until the next toggle. No link/block index rebuild.
// - Issue labels and projects use their workspace names as identifiers.
// - Issue numbering is serialized with a dedicated `pg_advisory_xact_lock`
//   namespace instead of relying on a bare `MAX(number)+1` read outside a
//   lock (upstream has no race guard here at all).
import { randomUUID } from "node:crypto";
import type { Issue, IssueComment, IssuePropertyOptions, Milestone } from "@megaui/core";
import { ISSUE_TYPES, ISSUE_WORKFLOW_STATUSES, ISSUE_PRIORITY_RANK, MEGA_ISSUE_PRIORITIES, matchesIssueFilter } from "@megaui/core";
import {
  megaClPublicIds,
  megaContent,
  megaContentContainerTypes,
  megaIssueComments,
  megaIssuePriorities,
  megaIssueStates,
  megaIssues,
  user,
  type Database,
} from "@megaui/database";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import {
  MegaBadRequestError,
  MegaConflictError,
  MegaForbiddenError,
  MegaNotFoundError,
  MegaUnauthorizedError,
} from "../../errors";
import { parsePagination } from "../../context";
import { parseReactionRows, projectReactions, toggleReactionRow } from "../chat/reactions";
import { fallbackPublicProfile, resolvePublicProfiles } from "../public-profile";
import type { CreateIssueInput, IssueTransitionAction, ListIssuesInput, ListIssuesResult } from "./types";

/** Advisory-lock namespace serializing `mega_issues.number` allocation. */
const ISSUE_NUMBER_LOCK_NS = 1_396_386_881;

function newIssueId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function persistReactionRows(rows: ReturnType<typeof parseReactionRows>): Array<Record<string, unknown>> {
  return rows as unknown as Array<Record<string, unknown>>;
}

function parseMilestone(raw: unknown): Milestone | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const milestone = raw as Record<string, unknown>;
  if (typeof milestone.id !== "string" || typeof milestone.title !== "string") return undefined;
  return {
    id: milestone.id,
    title: milestone.title,
    dueDate: typeof milestone.dueDate === "string" ? milestone.dueDate : undefined,
    progress: typeof milestone.progress === "number" ? milestone.progress : undefined,
  };
}

/** Plain-text body reader — see module diff header (no Lexical pipeline ported). */
function unpackPlainBody(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const text = (raw as { text?: unknown }).text;
  return typeof text === "string" && text.length > 0 ? text : undefined;
}

async function readPlainBody(database: Database, containerType: string, containerId: string): Promise<string | undefined> {
  const [row] = await database
    .select({ bodyJson: megaContent.bodyJson })
    .from(megaContent)
    .where(and(eq(megaContent.containerType, containerType), eq(megaContent.containerId, containerId)))
    .limit(1);
  return row ? unpackPlainBody(row.bodyJson) : undefined;
}

async function upsertPlainBody(tx: Database, containerType: string, containerId: string, text: string, now: Date): Promise<void> {
  await tx
    .insert(megaContent)
    .values({ containerType, containerId, bodyJson: { text }, bodyFormatVersion: 1, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [megaContent.containerType, megaContent.containerId],
      set: { bodyJson: { text }, bodyFormatVersion: 1, updatedAt: now },
    });
}

async function recountComments(database: Database, issueNumber: number): Promise<number> {
  const [row] = await database
    .select({ value: count() })
    .from(megaIssueComments)
    .where(eq(megaIssueComments.issueNumber, issueNumber));
  return Number(row?.value ?? 0);
}

/**
 * Compact workspace filter DSL sort — mirrors upstream's `services.ts`
 * `sortIssues` / `issues-repo.ts` in-memory comparator exactly (GC-02: one
 * sort implementation).
 */
function sortIssues(issues: readonly Issue[], sort: import("@megaui/core").Filter["sort"]): Issue[] {
  const byNumber = (left: Issue, right: Issue) => left.number - right.number;
  const compareTime = (left: Issue, right: Issue, field: "updatedAt" | "createdAt", direction: 1 | -1) =>
    direction * left[field].localeCompare(right[field]) || byNumber(left, right);
  return [...issues].sort((left, right) => {
    if (sort === "priority-desc") {
      return (
        ISSUE_PRIORITY_RANK[left.priority] - ISSUE_PRIORITY_RANK[right.priority] ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        byNumber(left, right)
      );
    }
    if (sort === "updated-asc") return compareTime(left, right, "updatedAt", 1);
    if (sort === "created-desc") return compareTime(left, right, "createdAt", -1);
    if (sort === "created-asc") return compareTime(left, right, "createdAt", 1);
    return compareTime(left, right, "updatedAt", -1);
  });
}

async function loadIssue(database: Database, number: number, actorUserId?: string | null): Promise<Issue> {
  const [row] = await database.select().from(megaIssues).where(eq(megaIssues.number, number)).limit(1);
  if (!row) throw new MegaNotFoundError("Issue", number);

  const assigneeIds = Array.isArray(row.assigneeIds) ? row.assigneeIds : [];
  const watcherIds = Array.isArray(row.watcherIds) ? row.watcherIds : [];
  const linkedCLs = Array.isArray(row.linkedCLs) ? row.linkedCLs : [];
  const [publicUsers, clIds] = await Promise.all([
    resolvePublicProfiles(database, [row.authorId, ...assigneeIds]),
    linkedCLs.length
      ? database.select().from(megaClPublicIds).where(inArray(megaClPublicIds.number, linkedCLs))
      : [],
  ]);
  const publicIdByNumber = new Map(clIds.map((cl) => [cl.number, cl.publicId]));
  const author = publicUsers.get(row.authorId) ?? fallbackPublicProfile(row.authorId);
  const assignees = assigneeIds.map((id) => publicUsers.get(id) ?? fallbackPublicProfile(id));

  const derivedCount = await recountComments(database, number);
  if (derivedCount !== row.commentCount) {
    await database.update(megaIssues).set({ commentCount: derivedCount }).where(eq(megaIssues.id, row.id));
  }

  const body = await readPlainBody(database, megaContentContainerTypes.ISSUE, row.id);

  return {
    id: row.id,
    number: row.number,
    title: row.title,
    body,
    state: row.state === megaIssueStates.CLOSED ? "closed" : "open",
    workflowStatus: row.workflowStatus,
    priority: row.priority as Issue["priority"],
    labels: row.labelIds.map(name => ({ id: name, name, color: "#64748b" })),
    issueType: row.issueType ?? undefined,
    projects: row.projects,
    milestone: parseMilestone(row.milestone),
    linkedCLs,
    linkedClPublicIds: linkedCLs.flatMap((clNumber) => publicIdByNumber.get(clNumber) ?? []),
    reactions: projectReactions(parseReactionRows(row.reactions), actorUserId),
    author,
    assignees,
    packageId: row.packageId,
    commentCount: derivedCount,
    watcherIds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : undefined,
  };
}

async function loadIssueComment(
  database: Database,
  commentId: string,
  actorUserId?: string | null,
): Promise<IssueComment> {
  const [row] = await database.select().from(megaIssueComments).where(eq(megaIssueComments.id, commentId)).limit(1);
  if (!row) throw new MegaNotFoundError("Issue comment", commentId);
  return toIssueComment(database, row, actorUserId);
}

async function toIssueComment(
  database: Database,
  row: { id: string; issueNumber: number; authorId: string; reactions: unknown; createdAt: Date },
  actorUserId?: string | null,
): Promise<IssueComment> {
  const publicUsers = await resolvePublicProfiles(database, [row.authorId]);
  const author = publicUsers.get(row.authorId) ?? fallbackPublicProfile(row.authorId);
  const body = (await readPlainBody(database, megaContentContainerTypes.ISSUE_COMMENT, row.id)) ?? "";
  return {
    id: row.id,
    issueNumber: row.issueNumber,
    author,
    body,
    createdAt: row.createdAt.toISOString(),
    reactions: projectReactions(parseReactionRows(row.reactions), actorUserId),
  } satisfies IssueComment;
}

async function loadIssueRow(database: Database, issueNumber: number): Promise<{ id: string }> {
  const [row] = await database.select({ id: megaIssues.id }).from(megaIssues).where(eq(megaIssues.number, issueNumber)).limit(1);
  if (!row) throw new MegaNotFoundError("Issue", issueNumber);
  return row;
}

export function createIssuesService(database: Database) {
  /**
   * Fail-closed workspace-membership gate (GC-07) shared by every issue
   * mutation. Not a doc/channel-style role ACL (issues have no such table
   * yet) — "member" means "resolves to a live `user` row"; anything else
   * (anonymous, or an actorUserId that is not a real account) is denied.
   */
  async function assertWorkspaceMember(actorUserId: string | null | undefined): Promise<string> {
    const id = actorUserId?.trim();
    if (!id) throw new MegaUnauthorizedError("A signed-in session is required");
    const [row] = await database.select({ id: user.id }).from(user).where(eq(user.id, id)).limit(1);
    if (!row) throw new MegaForbiddenError("Only workspace members can perform this action");
    return id;
  }

  async function listIssues(input: ListIssuesInput = {}, actorUserId?: string | null): Promise<ListIssuesResult> {
    const { offset, limit } = parsePagination(input.pagination);
    const rows = await database.select({ number: megaIssues.number }).from(megaIssues);
    const issues = await Promise.all(rows.map((row) => loadIssue(database, row.number, actorUserId)));
    const filtered = issues.filter((issue) => matchesIssueFilter(issue, input.filter ?? {}, actorUserId?.trim() ?? ""));
    const sorted = sortIssues(filtered, input.filter?.sort);
    const items = sorted.slice(offset, offset + limit);
    return { items, total: sorted.length, offset, limit };
  }

  async function getIssue(number: number, actorUserId?: string | null): Promise<Issue> {
    return loadIssue(database, number, actorUserId);
  }

  async function getIssueBody(number: number): Promise<{ body: string }> {
    const issue = await loadIssue(database, number);
    return { body: issue.body ?? "" };
  }

  async function saveIssueBody(
    number: number,
    body: string,
    actorUserId: string | null | undefined,
  ): Promise<{ body: string }> {
    const memberId = await assertWorkspaceMember(actorUserId);
    const trimmedBody = body.trim();
    if (!trimmedBody) throw new MegaBadRequestError("Issue body is required");

    const now = new Date();
    await database.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: megaIssues.id,
          authorId: megaIssues.authorId,
          assigneeIds: megaIssues.assigneeIds,
        })
        .from(megaIssues)
        .where(eq(megaIssues.number, number))
        .for("update")
        .limit(1);
      if (!row) throw new MegaNotFoundError("Issue", number);

      const assigneeIds = Array.isArray(row.assigneeIds) ? row.assigneeIds : [];
      const canEdit = row.authorId === memberId || assigneeIds.includes(memberId);
      if (!canEdit) {
        throw new MegaForbiddenError("Only the issue author or an assignee can edit the body");
      }

      await upsertPlainBody(tx, megaContentContainerTypes.ISSUE, row.id, trimmedBody, now);
      await tx.update(megaIssues).set({ updatedAt: now }).where(eq(megaIssues.id, row.id));
    });

    return { body: trimmedBody };
  }

  async function listPropertyOptions(actorUserId: string | null | undefined): Promise<IssuePropertyOptions> {
    await assertWorkspaceMember(actorUserId);
    const [users, names] = await Promise.all([
      database.select({ id: user.id }).from(user).where(sql`${user.banned} IS NOT TRUE`),
      database.execute<{ kind: string; name: string }>(sql`
        SELECT 'label' AS kind, jsonb_array_elements_text(${megaIssues.labelIds}) AS name FROM ${megaIssues}
        UNION SELECT 'project', jsonb_array_elements_text(${megaIssues.projects}) FROM ${megaIssues}
        UNION SELECT 'milestone', ${megaIssues.milestone}->>'title' FROM ${megaIssues}
          WHERE ${megaIssues.milestone}->>'title' IS NOT NULL
        ORDER BY kind, name
      `),
    ]);
    const profiles = await resolvePublicProfiles(database, users.map(row => row.id));
    const values = (kind: string) => names.rows.filter(row => row.kind === kind).map(row => row.name);
    return {
      members: Array.from(profiles.values(), ({ id, displayName }) => ({ id, displayName }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      labels: values("label"), projects: values("project"), milestones: values("milestone"),
    };
  }

  async function createIssue(input: CreateIssueInput, actorUserId: string | null | undefined): Promise<Issue> {
    const authorId = await assertWorkspaceMember(actorUserId);
    const title = input.title.trim();
    if (!title) throw new MegaBadRequestError("Issue title is required");
    const packageId = input.packageId?.trim() ?? "";
    if (input.packageId !== undefined && !packageId) throw new MegaBadRequestError("Issue packageId is required");
    const priority = input.priority ?? megaIssuePriorities.P2;
    if (!MEGA_ISSUE_PRIORITIES.includes(priority)) {
      throw new MegaBadRequestError(`Invalid issue priority: ${input.priority}`);
    }

    if (input.issueType !== undefined && !ISSUE_TYPES.includes(input.issueType)) {
      throw new MegaBadRequestError("Invalid issue type");
    }
    if (input.workflowStatus !== undefined && !ISSUE_WORKFLOW_STATUSES.includes(input.workflowStatus)) {
      throw new MegaBadRequestError("Invalid issue workflow status");
    }
    const normalizeNames = (values: string[] = []) => {
      const names = values.map(value => value.trim());
      if (names.length > 32 || names.some(name => !name || name.length > 80)) {
        throw new MegaBadRequestError("Invalid issue property");
      }
      return [...new Set(names)];
    };
    const labels = normalizeNames(input.labels);
    const projects = normalizeNames(input.projects);
    const milestone = input.milestoneTitle === undefined ? undefined : normalizeNames([input.milestoneTitle])[0];
    const assignees = [...new Set(input.assigneeIds ?? [])];
    if (assignees.length > 32) throw new MegaBadRequestError("Too many issue assignees");

    const now = new Date();
    const id = newIssueId("issue");
    const bodyText = input.body?.trim();

    const number = await database.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ISSUE_NUMBER_LOCK_NS})`);
      const [maxRow] = await tx.select({ number: megaIssues.number }).from(megaIssues).orderBy(desc(megaIssues.number)).limit(1);
      const nextNumber = (maxRow?.number ?? 0) + 1;
      if (assignees.length) {
        const eligible = await tx.select({ id: user.id }).from(user)
          .where(and(inArray(user.id, assignees), sql`${user.banned} IS NOT TRUE`)).for("share");
        if (eligible.length !== assignees.length) throw new MegaBadRequestError("Invalid issue assignee");
      }
      await tx.insert(megaIssues).values({
        id,
        number: nextNumber,
        title,
        state: megaIssueStates.OPEN,
        workflowStatus: input.workflowStatus ?? "backlog",
        priority,
        packageId,
        authorId,
        issueType: input.issueType,
        projects,
        milestone: milestone ? { id: milestone, title: milestone } : null,
        labelIds: labels,
        assigneeIds: assignees,
        watcherIds: [authorId],
        linkedCLs: [],
        reactions: [],
        commentCount: 0,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      if (bodyText) {
        await upsertPlainBody(tx, megaContentContainerTypes.ISSUE, id, bodyText, now);
      }
      return nextNumber;
    });

    return loadIssue(database, number, authorId);
  }

  async function listIssueComments(issueNumber: number, actorUserId?: string | null): Promise<IssueComment[]> {
    await loadIssueRow(database, issueNumber);
    const rows = await database
      .select()
      .from(megaIssueComments)
      .where(eq(megaIssueComments.issueNumber, issueNumber))
      .orderBy(asc(megaIssueComments.createdAt));

    return Promise.all(rows.map((row) => toIssueComment(database, row, actorUserId)));
  }

  /** Card AC: comment permission — non-members are denied (fail-closed, GC-07). */
  async function addIssueComment(
    issueNumber: number,
    body: string,
    actorUserId: string | null | undefined,
  ): Promise<IssueComment> {
    const authorId = await assertWorkspaceMember(actorUserId);
    const trimmedBody = body.trim();
    if (!trimmedBody) throw new MegaBadRequestError("Issue comment body is required");
    const issueRow = await loadIssueRow(database, issueNumber);

    const now = new Date();
    const id = newIssueId("issue_comment");

    await database.transaction(async (tx) => {
      const [locked] = await tx
        .select({ id: megaIssues.id })
        .from(megaIssues)
        .where(eq(megaIssues.id, issueRow.id))
        .for("update")
        .limit(1);
      if (!locked) throw new MegaNotFoundError("Issue", issueNumber);
      await tx.insert(megaIssueComments).values({ id, issueNumber, authorId, reactions: [], createdAt: now });
      await upsertPlainBody(tx, megaContentContainerTypes.ISSUE_COMMENT, id, trimmedBody, now);
      const derived = await recountComments(tx, issueNumber);
      await tx.update(megaIssues).set({ commentCount: derived, updatedAt: now }).where(eq(megaIssues.id, issueRow.id));
    });

    const publicUsers = await resolvePublicProfiles(database, [authorId]);
    const author = publicUsers.get(authorId) ?? fallbackPublicProfile(authorId);

    return { id, issueNumber, author, body: trimmedBody, createdAt: now.toISOString(), reactions: [] };
  }

  /**
   * Card AC: full state-transition legality matrix. Only two transitions
   * exist (`open --close--> closed`, `closed --reopen--> open`); every
   * other (state, action) pair is illegal and rejected with
   * `MegaConflictError` — see module diff header for why this departs from
   * upstream's idempotent one-way `closeIssue`.
   */
  async function transitionIssueState(
    issueNumber: number,
    action: IssueTransitionAction,
    actorUserId: string | null | undefined,
  ): Promise<Issue> {
    const memberId = await assertWorkspaceMember(actorUserId);

    await database.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: megaIssues.id, state: megaIssues.state })
        .from(megaIssues)
        .where(eq(megaIssues.number, issueNumber))
        .for("update")
        .limit(1);
      if (!row) throw new MegaNotFoundError("Issue", issueNumber);

      if (action !== "close" && action !== "reopen") {
        throw new MegaBadRequestError(`Unknown issue transition action: ${String(action)}`);
      }

      const currentState = row.state === megaIssueStates.CLOSED ? "closed" : "open";
      if (action === "close" && currentState === "closed") {
        throw new MegaConflictError(`Issue #${issueNumber} is already closed`);
      }
      if (action === "reopen" && currentState === "open") {
        throw new MegaConflictError(`Issue #${issueNumber} is already open`);
      }

      const now = new Date();
      await tx
        .update(megaIssues)
        .set({
          state: action === "close" ? megaIssueStates.CLOSED : megaIssueStates.OPEN,
          closedAt: action === "close" ? now : null,
          updatedAt: now,
        })
        .where(eq(megaIssues.id, row.id));
    });

    return loadIssue(database, issueNumber, memberId);
  }

  async function closeIssue(issueNumber: number, actorUserId: string | null | undefined): Promise<Issue> {
    return transitionIssueState(issueNumber, "close", actorUserId);
  }

  async function reopenIssue(issueNumber: number, actorUserId: string | null | undefined): Promise<Issue> {
    return transitionIssueState(issueNumber, "reopen", actorUserId);
  }

  /** Card AC: watch semantics — toggles `actorUserId` membership in `watcherIds`. */
  async function toggleIssueWatch(issueNumber: number, actorUserId: string | null | undefined): Promise<Issue> {
    const memberId = await assertWorkspaceMember(actorUserId);

    await database.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: megaIssues.id, watcherIds: megaIssues.watcherIds })
        .from(megaIssues)
        .where(eq(megaIssues.number, issueNumber))
        .for("update")
        .limit(1);
      if (!row) throw new MegaNotFoundError("Issue", issueNumber);
      const current = Array.isArray(row.watcherIds) ? row.watcherIds : [];
      const next = current.includes(memberId) ? current.filter((watcherId) => watcherId !== memberId) : [...current, memberId];
      await tx.update(megaIssues).set({ watcherIds: next, updatedAt: new Date() }).where(eq(megaIssues.id, row.id));
    });

    return loadIssue(database, issueNumber, memberId);
  }

  async function toggleIssueReaction(
    issueNumber: number,
    emoji: string,
    actorUserId: string | null | undefined,
  ): Promise<Issue> {
    const memberId = await assertWorkspaceMember(actorUserId);

    await database.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: megaIssues.id, reactions: megaIssues.reactions })
        .from(megaIssues)
        .where(eq(megaIssues.number, issueNumber))
        .for("update")
        .limit(1);
      if (!row) throw new MegaNotFoundError("Issue", issueNumber);
      const next = toggleReactionRow(parseReactionRows(row.reactions), emoji, memberId);
      await tx
        .update(megaIssues)
        .set({ reactions: persistReactionRows(next), updatedAt: new Date() })
        .where(eq(megaIssues.id, row.id));
    });

    return loadIssue(database, issueNumber, memberId);
  }

  async function toggleIssueCommentReaction(
    commentId: string,
    emoji: string,
    actorUserId: string | null | undefined,
  ): Promise<IssueComment> {
    const memberId = await assertWorkspaceMember(actorUserId);

    await database.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: megaIssueComments.id, reactions: megaIssueComments.reactions })
        .from(megaIssueComments)
        .where(eq(megaIssueComments.id, commentId))
        .for("update")
        .limit(1);
      if (!row) throw new MegaNotFoundError("Issue comment", commentId);
      const next = toggleReactionRow(parseReactionRows(row.reactions), emoji, memberId);
      await tx.update(megaIssueComments).set({ reactions: persistReactionRows(next) }).where(eq(megaIssueComments.id, row.id));
    });

    return loadIssueComment(database, commentId, memberId);
  }

  return {
    listPropertyOptions,
    listIssues,
    getIssue,
    getIssueBody,
    saveIssueBody,
    createIssue,
    listIssueComments,
    addIssueComment,
    transitionIssueState,
    closeIssue,
    reopenIssue,
    toggleIssueWatch,
    toggleIssueReaction,
    toggleIssueCommentReaction,
  };
}

export type IssuesService = ReturnType<typeof createIssuesService>;

// Keep re-exported so consumers importing constants from this module (a
// convention docs.ts/members.ts also follow) get the drizzle vocabulary too.
export { megaIssuePriorities, megaIssueStates };
