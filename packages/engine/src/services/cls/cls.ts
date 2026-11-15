// megaui:libs/mega/services/cls.ts@0ff3a9d
// megaui:libs/mega/services/repos/cls-repo.ts@0ff3a9d
//
// Diff vs upstream (registered on the EG-05 task card):
// - No `MEGA_CLS_DATA_BACKEND` mock/database switch or `store.ts` fixture
//   backend (DEBT-04) — this is the only (drizzle PG) implementation, same
//   as the EG-02/EG-03 services.
// - No `CURRENT_USER` global; every method takes an explicit
//   `actorUserId: string | null | undefined` (GC-07 fail-closed default —
//   mutations without a signed-in actor throw `MegaUnauthorizedError`).
// - `transitionCLState` is fail-closed on permission, not just state: only
//   the CL author may drive a transition (upstream lets any caller drive
//   any CL through the matrix). The permission×state decision surface
//   lives in `./state.ts` (card AC2) so it is unit-testable without a
//   database.
// - `createCL` / `addCLComment` / `saveCLDescription` reject with
//   `MegaBadRequestError` / `MegaUnauthorizedError` / `MegaForbiddenError`
//   instead of upstream's raw `TypeError` (GC-11: no raw JS errors on a
//   production write path).
// - CL number allocation runs under a `pg_advisory_xact_lock` (upstream's
//   `MAX(number) + 1` has no concurrency guard) — same GC-08 hardening as
//   the EG-03 doc-version/star races.
// - `getCLChecks` / `getCLDependencyGraph` / `setCLFileViewed` /
//   `listInlineComments` / `addInlineComment` / `replyInlineComment` /
//   `resolveInlineComment` were out of scope for this card and now live in
//   the EG-06 attachment modules (`checks.ts` / `deps.ts` / `inline.ts` /
//   `revisions.ts`), wired into this same returned service object below.
//   `CL.revisions` now parses `mega_cls.revisions` via `./revisions`
//   (EG-06 owns revision creation/parsing).
// - `listCLCommits` (mega2 commit chain) is out of scope (EG-11).
// - No `ensureAuthorUser` — unlike upstream's mock `CURRENT_USER` shim,
//   `authorId` here is a real actor id and is expected to already exist in
//   `user` (matches the EG-03 docs-service convention: no synthetic user
//   rows are created on write).
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  megaClCiStatuses,
  megaClComments,
  megaClMergeStates,
  megaCls,
  megaClStates,
  megaContent,
  megaContentContainerTypes,
  type Database,
} from "@megaui/database";
import { createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import { matchesCLFilter, type CIStatus, type CL, type CLComment, type CLMergeState, type CLReviewer, type CLState, type Filter, type Reaction, type ReviewerVerdict, type User } from "@megaui/core";
import { MegaBadRequestError, MegaForbiddenError, MegaNotFoundError } from "../../errors";
import { BODY_FORMAT_VERSION_BLOCK_TREE } from "../docs/body-format";
import { replaceBlocksForSourceOnTx } from "../docs/blocks";
import { replaceLinksForSourceOnTx } from "../docs/links";
import { assertWorkspaceMember } from "./authz";
import { deleteCLCheckRun, getCLChecks, upsertCLCheckRun, type CLCheckRunInput, type CLChecksView } from "./checks";
import { isEmptyCommentBody, normalizeCommentBodyJson } from "./comment-body";
import { normalizeCLDescriptionJson, plainSummaryFromDescription } from "./description";
import {
  getCLDependencyGraph,
  setCLDependencyGraph,
  type CLDependencyGraphResult,
  type SetCLDependencyGraphInput,
} from "./deps";
import {
  addInlineComment,
  listInlineComments,
  parseFiles,
  replyInlineComment,
  resolveInlineComment,
  setCLFileViewed,
  type AddInlineCommentInput,
} from "./inline";
import { createCLRevision, listCLRevisions, parseRevisions, type CreateCLRevisionInput } from "./revisions";
import { assertCLTransitionAllowed, decideCLTransition, mergeStateForTransition } from "./state";
import type { CLDescriptionPayload, CreateCLInput } from "./types";
import { fallbackUser, resolveUsers } from "./users";

/** Advisory-lock namespace serializing `mega_cls.number` allocation (GC-08). */
const CL_NUMBER_LOCK_NS = 1_396_386_881;

function newClId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function parseState(value: string): CLState {
  return value === "ready" ||
    value === "wip" ||
    value === "queued" ||
    value === "merged" ||
    value === "closed" ||
    value === "conflicts"
    ? value
    : "wip";
}

function parseCi(value: string): CIStatus {
  return value === "passing" || value === "failing" || value === "queued" || value === "running" || value === "skipped"
    ? value
    : "queued";
}

function parseMerge(value: string): CLMergeState {
  return value === "queue-ready" ||
    value === "needs-review" ||
    value === "in-queue" ||
    value === "merged" ||
    value === "rebase-needed"
    ? value
    : "needs-review";
}

interface ReviewerRow {
  userId: string;
  verdict: ReviewerVerdict;
  reviewedAt?: string;
}

function parseReviewerRows(raw: unknown): ReviewerRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const verdict = record.verdict;
    if (verdict !== "approved" && verdict !== "commented" && verdict !== "requested" && verdict !== "pending") return [];
    if (typeof record.userId !== "string") return [];
    return [
      {
        userId: record.userId,
        verdict,
        reviewedAt: typeof record.reviewedAt === "string" ? record.reviewedAt : undefined,
      },
    ];
  });
}

function parseReactions(raw: unknown): Reaction[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.emoji !== "string") return [];
    return [
      {
        emoji: record.emoji,
        count: typeof record.count === "number" ? record.count : 0,
        reactedByMe: Boolean(record.reactedByMe),
      },
    ];
  });
}

function asEnvelope(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function sortCLs(cls: CL[], sort: Filter["sort"]): CL[] {
  const byField = (field: "updatedAt" | "createdAt", direction: 1 | -1) => (left: CL, right: CL) =>
    direction * left[field].localeCompare(right[field]) || right.updatedAt.localeCompare(left.updatedAt);
  if (sort === "updated-asc") return cls.sort(byField("updatedAt", 1));
  if (sort === "created-desc") return cls.sort(byField("createdAt", -1));
  if (sort === "created-asc") return cls.sort(byField("createdAt", 1));
  // CLs carry no priority axis; 'priority-desc' falls back to the default recency order.
  return cls.sort(byField("updatedAt", -1));
}

export function createClsService(database: Database) {
  async function rebuildDerivedIndexesOnTx(
    tx: Database,
    sourceType: string,
    sourceId: string,
    bodyJson: string,
  ): Promise<void> {
    await replaceLinksForSourceOnTx(tx, sourceType, sourceId, bodyJson);
    await replaceBlocksForSourceOnTx(tx, sourceType, sourceId, bodyJson);
  }

  async function loadCL(number: number): Promise<CL> {
    const [row] = await database.select().from(megaCls).where(eq(megaCls.number, number)).limit(1);
    if (!row) throw new MegaNotFoundError("CL", number);

    const reviewerRows = parseReviewerRows(row.reviewers);
    const usersById = await resolveUsers(database, [row.authorId, ...reviewerRows.map((reviewer) => reviewer.userId)]);
    const resolveUser = (id: string): User => usersById.get(id) ?? fallbackUser(id);

    const [content] = await database
      .select({ bodyJson: megaContent.bodyJson })
      .from(megaContent)
      .where(and(eq(megaContent.containerType, megaContentContainerTypes.CL), eq(megaContent.containerId, row.id)))
      .limit(1);

    const reviewers: CLReviewer[] = reviewerRows.map((reviewer) => ({
      user: resolveUser(reviewer.userId),
      verdict: reviewer.verdict,
      reviewedAt: reviewer.reviewedAt,
    }));

    return {
      id: row.id,
      number: row.number,
      title: row.title,
      description: plainSummaryFromDescription(content?.bodyJson),
      state: parseState(row.state),
      packageId: row.packageId,
      author: resolveUser(row.authorId),
      reviewers,
      additions: row.additions,
      deletions: row.deletions,
      files: parseFiles(row.files),
      revisions: parseRevisions(row.revisions),
      ci: parseCi(row.ci),
      merge: parseMerge(row.merge),
      mergeScore: row.mergeScore ?? undefined,
      queuePosition: row.queuePosition ?? undefined,
      atomic: row.atomic,
      crossPackage: Array.isArray(row.crossPackage) ? row.crossPackage.filter((value): value is string => typeof value === "string") : [],
      linkedIssues: Array.isArray(row.linkedIssues)
        ? row.linkedIssues.filter((value): value is number => typeof value === "number")
        : [],
      branch: row.branch ?? undefined,
      subscribed: row.subscribed,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      mergedAt: row.mergedAt ? row.mergedAt.toISOString() : undefined,
    };
  }

  async function listCLs(filter: Filter = {}, actorUserId?: string | null): Promise<CL[]> {
    const rows = await database.select({ number: megaCls.number }).from(megaCls);
    const cls = await Promise.all(rows.map((row) => loadCL(row.number)));
    const currentUserId = actorUserId?.trim() ?? "";
    return sortCLs(cls.filter((cl) => matchesCLFilter(cl, filter, currentUserId)), filter.sort);
  }

  async function getCL(number: number): Promise<CL> {
    return loadCL(number);
  }

  async function createCL(input: CreateCLInput, actorUserId: string | null | undefined): Promise<CL> {
    const authorId = await assertWorkspaceMember(database, actorUserId);
    const title = input.title.trim();
    const branch = input.branch.trim();
    const packageId = input.packageId?.trim();
    if (!title) throw new MegaBadRequestError("CL title is required");
    if (!branch) throw new MegaBadRequestError("CL branch is required");
    if (!packageId) throw new MegaBadRequestError("CL packageId is required");

    const id = newClId("cl");
    const now = new Date();
    // Mint once — createEmptyMegaDocumentEditorStateJSON() uses a fresh
    // random blockId per call; the body insert and index rebuild must share
    // the same JSON or mega_content_blocks points at a non-existent block.
    const emptyBodyRaw = createEmptyMegaDocumentEditorStateJSON();
    const emptyBody = JSON.parse(emptyBodyRaw) as Record<string, unknown>;
    let number = 0;

    await database.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CL_NUMBER_LOCK_NS})`);
      const [maxRow] = await tx.select({ number: megaCls.number }).from(megaCls).orderBy(desc(megaCls.number)).limit(1);
      number = (maxRow?.number ?? 0) + 1;
      await tx.insert(megaCls).values({
        id,
        number,
        title,
        state: megaClStates.WIP,
        packageId,
        authorId,
        reviewers: [],
        additions: 0,
        deletions: 0,
        files: [],
        revisions: [],
        ci: megaClCiStatuses.QUEUED,
        merge: megaClMergeStates.NEEDS_REVIEW,
        atomic: false,
        crossPackage: [],
        linkedIssues: [],
        branch,
        subscribed: true,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(megaContent).values({
        containerType: megaContentContainerTypes.CL,
        containerId: id,
        bodyJson: emptyBody,
        bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
        createdAt: now,
        updatedAt: now,
      });
      await rebuildDerivedIndexesOnTx(tx, megaContentContainerTypes.CL, id, emptyBodyRaw);
    });

    return loadCL(number);
  }

  async function toggleCLSubscription(number: number, actorUserId: string | null | undefined): Promise<CL> {
    await assertWorkspaceMember(database, actorUserId);
    await database.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: megaCls.id, subscribed: megaCls.subscribed })
        .from(megaCls)
        .where(eq(megaCls.number, number))
        .for("update")
        .limit(1);
      if (!row) throw new MegaNotFoundError("CL", number);
      await tx
        .update(megaCls)
        .set({ subscribed: !(row.subscribed ?? false), updatedAt: new Date() })
        .where(eq(megaCls.id, row.id));
    });
    return loadCL(number);
  }

  async function listCLComments(clNumber: number): Promise<CLComment[]> {
    await loadCL(clNumber);
    const rows = await database
      .select()
      .from(megaClComments)
      .where(eq(megaClComments.clNumber, clNumber))
      .orderBy(asc(megaClComments.createdAt));
    if (rows.length === 0) return [];

    const usersById = await resolveUsers(database, rows.map((row) => row.authorId));
    const contentRows = await database
      .select({ containerId: megaContent.containerId, bodyJson: megaContent.bodyJson })
      .from(megaContent)
      .where(
        and(
          eq(megaContent.containerType, megaContentContainerTypes.CL_COMMENT),
          inArray(
            megaContent.containerId,
            rows.map((row) => row.id),
          ),
        ),
      );
    const bodyByCommentId = new Map(contentRows.map((row) => [row.containerId, row.bodyJson]));

    return rows.map((row) => ({
      id: row.id,
      clNumber: row.clNumber,
      author: usersById.get(row.authorId) ?? fallbackUser(row.authorId),
      body: normalizeCommentBodyJson(bodyByCommentId.get(row.id)),
      createdAt: row.createdAt.toISOString(),
      reactions: parseReactions(row.reactions),
    }));
  }

  async function addCLComment(
    clNumber: number,
    body: string,
    actorUserId: string | null | undefined,
  ): Promise<CLComment> {
    const authorId = await assertWorkspaceMember(database, actorUserId);
    const lexical = normalizeCommentBodyJson(body);
    if (isEmptyCommentBody(lexical)) throw new MegaBadRequestError("CL comment body is required");

    const cl = await loadCL(clNumber);
    const now = new Date();
    const id = newClId("cl_comment");
    const bodyJson = JSON.parse(lexical) as Record<string, unknown>;

    await database.transaction(async (tx) => {
      await tx.insert(megaClComments).values({ id, clNumber, authorId, reactions: [], createdAt: now });
      await tx.insert(megaContent).values({
        containerType: megaContentContainerTypes.CL_COMMENT,
        containerId: id,
        bodyJson,
        bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
        createdAt: now,
        updatedAt: now,
      });
      await rebuildDerivedIndexesOnTx(tx, megaContentContainerTypes.CL_COMMENT, id, lexical);
      await tx.update(megaCls).set({ updatedAt: now }).where(eq(megaCls.id, cl.id));
    });

    const usersById = await resolveUsers(database, [authorId]);
    return {
      id,
      clNumber,
      author: usersById.get(authorId) ?? fallbackUser(authorId),
      body: lexical,
      createdAt: now.toISOString(),
      reactions: [],
    };
  }

  async function loadClContentEnvelope(clId: string): Promise<Record<string, unknown>> {
    const [content] = await database
      .select({ bodyJson: megaContent.bodyJson })
      .from(megaContent)
      .where(and(eq(megaContent.containerType, megaContentContainerTypes.CL), eq(megaContent.containerId, clId)))
      .limit(1);
    return asEnvelope(content?.bodyJson);
  }

  async function getCLDescription(number: number): Promise<CLDescriptionPayload> {
    const cl = await loadCL(number);
    const envelope = await loadClContentEnvelope(cl.id);
    return { body: normalizeCLDescriptionJson(envelope) };
  }

  async function saveCLDescription(
    number: number,
    body: string,
    actorUserId: string | null | undefined,
  ): Promise<CLDescriptionPayload> {
    const actorId = await assertWorkspaceMember(database, actorUserId);
    const cl = await loadCL(number);
    if (actorId !== cl.author.id) {
      throw new MegaForbiddenError("Only the CL author can edit the description");
    }

    const lexicalJson = normalizeCLDescriptionJson(body);
    const nextRoot = (JSON.parse(lexicalJson) as { root: unknown }).root;
    const now = new Date();

    await database.transaction(async (tx) => {
      // ER-05 P1 lost-update fix: lock the CL row first — `checks.ts`/
      // `deps.ts` (EG-06) already take this same `megaCls` `FOR UPDATE`
      // lock before their own checksView/dependencyView read-modify-write,
      // so acquiring it here too serializes against them. Then re-read
      // (and lock) the `megaContent` row *inside* this same transaction —
      // not the `existing` envelope captured by `loadCL` above — so the
      // merge below can never clobber a concurrent envelope writer that
      // committed between this call's entry and its transaction start.
      const [lockedCl] = await tx.select({ id: megaCls.id }).from(megaCls).where(eq(megaCls.id, cl.id)).for("update").limit(1);
      if (!lockedCl) throw new MegaNotFoundError("CL", number);

      const [existing] = await tx
        .select({ bodyJson: megaContent.bodyJson })
        .from(megaContent)
        .where(and(eq(megaContent.containerType, megaContentContainerTypes.CL), eq(megaContent.containerId, lockedCl.id)))
        .for("update")
        .limit(1);
      // Preserve unrecognized envelope keys (e.g. EG-06 `checksView`/
      // `dependencyView`) — this card only ever writes `root`. Drop legacy
      // top-level `text` so `plainSummaryFromDescription` cannot prefer a
      // stale string over the new block-tree root.
      const { text: _legacyText, ...preserved } = asEnvelope(existing?.bodyJson);
      void _legacyText;
      const nextEnvelope = { ...preserved, root: nextRoot };
      await tx
        .insert(megaContent)
        .values({
          containerType: megaContentContainerTypes.CL,
          containerId: cl.id,
          bodyJson: nextEnvelope,
          bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [megaContent.containerType, megaContent.containerId],
          set: { bodyJson: nextEnvelope, bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE, updatedAt: now },
        });
      await rebuildDerivedIndexesOnTx(tx, megaContentContainerTypes.CL, cl.id, lexicalJson);
      await tx.update(megaCls).set({ updatedAt: now }).where(eq(megaCls.id, cl.id));
    });

    return { body: lexicalJson };
  }

  async function transitionCLState(
    number: number,
    target: CLState,
    actorUserId: string | null | undefined,
  ): Promise<CL> {
    // Membership first (unknown actor → MegaForbiddenError), then
    // permission×state under FOR UPDATE so concurrent legal transitions
    // from the same state cannot both commit.
    const actorId = await assertWorkspaceMember(database, actorUserId);
    await database.transaction(async (tx) => {
      const [row] = await tx.select().from(megaCls).where(eq(megaCls.number, number)).for("update").limit(1);
      if (!row) throw new MegaNotFoundError("CL", number);

      const reviewerRows = parseReviewerRows(row.reviewers);
      const reviewers: CLReviewer[] = reviewerRows.map((reviewer) => ({
        user: fallbackUser(reviewer.userId),
        verdict: reviewer.verdict,
        reviewedAt: reviewer.reviewedAt,
      }));
      const lockedCl: Pick<CL, "author" | "state" | "merge" | "reviewers"> = {
        author: fallbackUser(row.authorId),
        state: parseState(row.state),
        merge: parseMerge(row.merge),
        reviewers,
      };
      const decision = decideCLTransition(lockedCl, target, actorId);
      assertCLTransitionAllowed(decision, number, target);
      if (decision.noop) return;

      const now = new Date();
      await tx
        .update(megaCls)
        .set({
          state: target,
          merge: mergeStateForTransition(target, { reviewers }),
          updatedAt: now,
          ...(target === "merged" ? { mergedAt: now } : {}),
        })
        .where(eq(megaCls.id, row.id));
    });

    return loadCL(number);
  }

  return {
    listCLs,
    getCL,
    createCL,
    toggleCLSubscription,
    listCLComments,
    addCLComment,
    getCLDescription,
    saveCLDescription,
    transitionCLState,
    // EG-06 attachments (checks/deps/revisions/inline) — implemented in
    // sibling files, wired into this one service object per the EG-06 card.
    getCLChecks: (number: number): Promise<CLChecksView> => getCLChecks(database, number),
    upsertCLCheckRun: (
      number: number,
      input: CLCheckRunInput,
      actorUserId: string | null | undefined,
    ): Promise<CLChecksView> => upsertCLCheckRun(database, number, input, actorUserId),
    deleteCLCheckRun: (
      number: number,
      checkId: string,
      actorUserId: string | null | undefined,
    ): Promise<CLChecksView> => deleteCLCheckRun(database, number, checkId, actorUserId),
    getCLDependencyGraph: (number: number): Promise<CLDependencyGraphResult> =>
      getCLDependencyGraph(database, number),
    setCLDependencyGraph: (
      number: number,
      input: SetCLDependencyGraphInput,
      actorUserId: string | null | undefined,
    ): Promise<CLDependencyGraphResult> => setCLDependencyGraph(database, number, input, actorUserId),
    listCLRevisions: (number: number) => listCLRevisions(database, number),
    createCLRevision: (number: number, input: CreateCLRevisionInput, actorUserId: string | null | undefined) =>
      createCLRevision(database, number, input, actorUserId),
    listInlineComments: (clNumber: number) => listInlineComments(database, clNumber),
    addInlineComment: (
      clNumber: number,
      input: AddInlineCommentInput,
      actorUserId: string | null | undefined,
    ) => addInlineComment(database, clNumber, input, actorUserId),
    replyInlineComment: (commentId: string, body: string, actorUserId: string | null | undefined) =>
      replyInlineComment(database, commentId, body, actorUserId),
    resolveInlineComment: (commentId: string, actorUserId: string | null | undefined) =>
      resolveInlineComment(database, commentId, actorUserId),
    setCLFileViewed: (number: number, path: string, viewed: boolean, actorUserId: string | null | undefined) =>
      setCLFileViewed(database, number, path, viewed, actorUserId),
  };
}

export type ClsService = ReturnType<typeof createClsService>;
