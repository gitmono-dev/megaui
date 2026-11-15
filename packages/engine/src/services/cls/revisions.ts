// megaui:libs/mega/services/repos/cls-repo.ts@0ff3a9d (parseRevisions)
//
// Diff vs upstream (registered on the EG-06 task card):
// - Upstream only ever *reads* `mega_cls.revisions` (fixture-seeded JSON —
//   no revision-creation API). `cls.ts`'s EG-05 header calls this out
//   explicitly: "CL.revisions is always [] here — EG-06 owns revision
//   creation/parsing." This module adds `createCLRevision`, fail-closed on
//   a blank `sha` with `MegaBadRequestError` instead of a raw `TypeError`
//   (GC-11), gated by `assertWorkspaceMember` (GC-07).
// - `commitList` / `reviewerState` on a freshly created revision are
//   always `[]` — the EG-11 mega2 commit chain and the EG-05 reviewer
//   matrix are not wired into revision creation (registered omission; a
//   revision created here reflects only sha/label/summary/base metadata,
//   same as `mega_cls.reviewers`/`files` staying server-authored-only).
import { eq } from "drizzle-orm";
import { megaCls, type Database } from "@megaui/database";
import type { CIStatus, Revision, RevisionCommit, RevisionRebase, User } from "@megaui/core";
import { MegaBadRequestError, MegaNotFoundError } from "../../errors";
import { assertWorkspaceMember } from "./authz";
import { newClId } from "./ids";
import { fallbackUser } from "./users";

export interface CreateCLRevisionInput {
  sha: string;
  label?: string;
  summary?: string;
  base?: string;
}

function parseCi(value: unknown): CIStatus {
  return value === "passing" ||
    value === "failing" ||
    value === "queued" ||
    value === "running" ||
    value === "skipped"
    ? value
    : "queued";
}

function parseUser(raw: unknown): User {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const id = (raw as { id?: unknown }).id;
    if (typeof id === "string") return fallbackUser(id);
  }
  return fallbackUser("unknown");
}

function parseReviewerStateRows(raw: unknown): Revision["reviewerState"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const verdict = record.verdict;
    if (verdict !== "approved" && verdict !== "commented" && verdict !== "requested" && verdict !== "pending") {
      return [];
    }
    const userId = typeof record.userId === "string" ? record.userId : undefined;
    if (!userId) return [];
    return [
      {
        user: fallbackUser(userId),
        verdict,
        reviewedAt: typeof record.reviewedAt === "string" ? record.reviewedAt : undefined,
      },
    ];
  });
}

function parseCommitList(raw: unknown): readonly RevisionCommit[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.sha !== "string" || typeof record.message !== "string") return [];
    return [
      {
        sha: record.sha,
        message: record.message,
        author: parseUser(record.author),
        createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
        filesChanged: typeof record.filesChanged === "number" ? record.filesChanged : 0,
        additions: typeof record.additions === "number" ? record.additions : 0,
        deletions: typeof record.deletions === "number" ? record.deletions : 0,
      },
    ];
  });
}

function parseRebase(raw: unknown): RevisionRebase | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.from !== "string" || typeof record.to !== "string") return undefined;
  return {
    from: record.from,
    to: record.to,
    upstreamCommits: typeof record.upstreamCommits === "number" ? record.upstreamCommits : 0,
  };
}

/** Parses `mega_cls.revisions` JSON into the domain `Revision[]` (EG-06 owns this — see cls.ts header). */
export function parseRevisions(raw: unknown): Revision[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.number !== "number" || typeof record.sha !== "string") {
      return [];
    }
    const rebase = parseRebase(record.rebase);
    return [
      {
        id: record.id,
        number: record.number,
        sha: record.sha,
        label: typeof record.label === "string" ? record.label : `revision ${record.number}`,
        createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
        rebased: Boolean(record.rebased),
        forcePushed: Boolean(record.forcePushed),
        commitList: parseCommitList(record.commitList),
        reviewerState: parseReviewerStateRows(record.reviewerState),
        summary: typeof record.summary === "string" ? record.summary : "",
        base: typeof record.base === "string" ? record.base : "",
        ci: parseCi(record.ci),
        additions: typeof record.additions === "number" ? record.additions : 0,
        deletions: typeof record.deletions === "number" ? record.deletions : 0,
        filesChanged: typeof record.filesChanged === "number" ? record.filesChanged : 0,
        ...(rebase ? { rebase } : {}),
      },
    ];
  });
}

function serializeRevision(revision: Revision): Record<string, unknown> {
  return {
    id: revision.id,
    number: revision.number,
    sha: revision.sha,
    label: revision.label,
    createdAt: revision.createdAt,
    rebased: revision.rebased,
    forcePushed: revision.forcePushed,
    commitList: revision.commitList,
    reviewerState: revision.reviewerState.map((reviewer) => ({
      userId: reviewer.user.id,
      verdict: reviewer.verdict,
      reviewedAt: reviewer.reviewedAt,
    })),
    summary: revision.summary,
    base: revision.base,
    ci: revision.ci,
    additions: revision.additions,
    deletions: revision.deletions,
    filesChanged: revision.filesChanged,
    rebase: revision.rebase,
  };
}

export async function listCLRevisions(database: Database, number: number): Promise<Revision[]> {
  const [row] = await database
    .select({ revisions: megaCls.revisions })
    .from(megaCls)
    .where(eq(megaCls.number, number))
    .limit(1);
  if (!row) throw new MegaNotFoundError("CL", number);
  return parseRevisions(row.revisions);
}

/**
 * Appends a new revision, newest-first (index 0) — the ordering
 * `replyInlineComment`'s "latest revision" convention
 * (`cl.revisions[0]?.number`, ported from upstream) relies on. See inline.ts.
 */
export async function createCLRevision(
  database: Database,
  number: number,
  input: CreateCLRevisionInput,
  actorUserId: string | null | undefined,
): Promise<Revision> {
  await assertWorkspaceMember(database, actorUserId);
  const sha = input.sha.trim();
  if (!sha) throw new MegaBadRequestError("Revision sha is required");

  let created: Revision | undefined;
  await database.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: megaCls.id, revisions: megaCls.revisions })
      .from(megaCls)
      .where(eq(megaCls.number, number))
      .for("update")
      .limit(1);
    if (!row) throw new MegaNotFoundError("CL", number);
    const existing = parseRevisions(row.revisions);
    const nextNumber = existing.reduce((max, revision) => Math.max(max, revision.number), 0) + 1;
    const now = new Date();
    const revision: Revision = {
      id: newClId("rev"),
      number: nextNumber,
      sha,
      label: input.label?.trim() || `revision ${nextNumber}`,
      createdAt: now.toISOString(),
      rebased: false,
      forcePushed: false,
      commitList: [],
      reviewerState: [],
      summary: input.summary?.trim() ?? "",
      base: input.base?.trim() ?? "",
      ci: "queued",
      additions: 0,
      deletions: 0,
      filesChanged: 0,
    };
    created = revision;
    const nextRevisions = [serializeRevision(revision), ...existing.map(serializeRevision)];
    await tx.update(megaCls).set({ revisions: nextRevisions, updatedAt: now }).where(eq(megaCls.id, row.id));
  });
  if (!created) throw new MegaNotFoundError("CL", number);
  return created;
}
