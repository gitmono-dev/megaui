// megaui:libs/mega/services/repos/cls-repo.ts@0ff3a9d (CLChecksView / getCLChecks / designChecksSnapshot)
//
// Diff vs upstream (registered on the EG-06 task card):
// - Upstream serves checks/pipeline data from a single process-global
//   fixture snapshot (`designChecksSnapshot()` off `store.ts`) the first
//   time a CL is read, then persists that snapshot into `mega_content`.
//   megaui has no fixture/mock backend (DEBT-04, already registered on the
//   EG-05 task card) — `getCLChecks` returns an empty view until a check
//   run is recorded through `upsertCLCheckRun`.
// - Upstream never writes checks (mock/fixture-only, read-only surface).
//   This module adds `upsertCLCheckRun` / `deleteCLCheckRun` (EG-06 AC1
//   "checks CRUD") plus `aggregateCheckStatus`, which also drives
//   `mega_cls.ci` so the CL list/detail CI badge (EG-05's `loadCL`) stays
//   consistent with the checks table without a second write path.
// - `TypeError` (upstream has none here — read-only) becomes
//   `MegaBadRequestError` / `MegaNotFoundError` (GC-11); every mutation is
//   gated by `assertWorkspaceMember` (GC-07 fail-closed).
import { eq } from "drizzle-orm";
import { megaCls, type Database } from "@megaui/database";
import type { BenchTile, CheckRun, CIStatus, LogLine, PipelineStage } from "@megaui/core";
import { MegaBadRequestError, MegaNotFoundError } from "../../errors";
import { assertWorkspaceMember } from "./authz";
import { loadClEnvelope, writeClEnvelope } from "./envelope";
import { newClId } from "./ids";

/** Persisted under mega_content (container=cl) as body_json.checksView. */
export interface CLChecksView {
  pipeline: readonly PipelineStage[];
  runner: string;
  queuedAt?: string;
  checks: readonly CheckRun[];
  logTail: readonly LogLine[];
  benchmarks: readonly BenchTile[];
}

export interface CLCheckRunInput {
  /** Omit to create a new check run; pass an existing id to update it in place. */
  id?: string;
  name: string;
  status: CIStatus;
  matrix?: string;
  durationSeconds?: number;
  logId?: string;
  startedAt?: string;
  completedAt?: string;
  logCount?: number;
  note?: string;
  passedCount?: number;
}

function emptyChecksView(): CLChecksView {
  return { pipeline: [], runner: "", checks: [], logTail: [], benchmarks: [] };
}

function parseCheckStatus(value: unknown): CIStatus {
  return value === "passing" ||
    value === "failing" ||
    value === "queued" ||
    value === "running" ||
    value === "skipped"
    ? value
    : "queued";
}

function parseCheckRuns(raw: unknown): CheckRun[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string") return [];
    return [
      {
        id: record.id,
        name: record.name,
        status: parseCheckStatus(record.status),
        matrix: typeof record.matrix === "string" ? record.matrix : undefined,
        durationSeconds: typeof record.durationSeconds === "number" ? record.durationSeconds : undefined,
        logId: typeof record.logId === "string" ? record.logId : undefined,
        startedAt: typeof record.startedAt === "string" ? record.startedAt : undefined,
        completedAt: typeof record.completedAt === "string" ? record.completedAt : undefined,
        logCount: typeof record.logCount === "number" ? record.logCount : undefined,
        note: typeof record.note === "string" ? record.note : undefined,
        passedCount: typeof record.passedCount === "number" ? record.passedCount : undefined,
      },
    ];
  });
}

/**
 * `pipeline` / `logTail` / `benchmarks` are opaque display data (no CRUD
 * surface on this card) — passed through as stored rather than field-by-
 * field validated, same rigor upstream's mock backend applies to them.
 */
function parseChecksView(raw: unknown): CLChecksView | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (!("checks" in record)) return undefined;
  return {
    pipeline: Array.isArray(record.pipeline) ? (record.pipeline as PipelineStage[]) : [],
    runner: typeof record.runner === "string" ? record.runner : "",
    queuedAt: typeof record.queuedAt === "string" ? record.queuedAt : undefined,
    checks: parseCheckRuns(record.checks),
    logTail: Array.isArray(record.logTail) ? (record.logTail as LogLine[]) : [],
    benchmarks: Array.isArray(record.benchmarks) ? (record.benchmarks as BenchTile[]) : [],
  };
}

/**
 * Aggregate CI status across a check-run list (EG-06 AC1 status
 * aggregation). Pure so the full precedence order is unit-testable without
 * a database: failing > running > queued > (all-skipped ? skipped :
 * passing). Empty list defaults to `queued` (no runs recorded yet).
 */
export function aggregateCheckStatus(checks: readonly CheckRun[]): CIStatus {
  if (checks.length === 0) return "queued";
  if (checks.some((check) => check.status === "failing")) return "failing";
  if (checks.some((check) => check.status === "running")) return "running";
  if (checks.some((check) => check.status === "queued")) return "queued";
  if (checks.every((check) => check.status === "skipped")) return "skipped";
  return "passing";
}

async function requireClId(database: Database, number: number): Promise<string> {
  const [row] = await database.select({ id: megaCls.id }).from(megaCls).where(eq(megaCls.number, number)).limit(1);
  if (!row) throw new MegaNotFoundError("CL", number);
  return row.id;
}

export async function getCLChecks(database: Database, number: number): Promise<CLChecksView> {
  const clId = await requireClId(database, number);
  const envelope = await loadClEnvelope(database, clId);
  return parseChecksView(envelope.checksView) ?? emptyChecksView();
}

/** Creates a check run when `input.id` is omitted/unknown, otherwise updates it in place. */
export async function upsertCLCheckRun(
  database: Database,
  number: number,
  input: CLCheckRunInput,
  actorUserId: string | null | undefined,
): Promise<CLChecksView> {
  await assertWorkspaceMember(database, actorUserId);
  const name = input.name.trim();
  if (!name) throw new MegaBadRequestError("Check run name is required");

  let nextView: CLChecksView = emptyChecksView();
  await database.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: megaCls.id })
      .from(megaCls)
      .where(eq(megaCls.number, number))
      .for("update")
      .limit(1);
    if (!row) throw new MegaNotFoundError("CL", number);
    const envelope = await loadClEnvelope(tx, row.id);
    const current = parseChecksView(envelope.checksView) ?? emptyChecksView();
    const id = input.id?.trim() || newClId("check");
    const nextRun: CheckRun = {
      id,
      name,
      status: input.status,
      matrix: input.matrix,
      durationSeconds: input.durationSeconds,
      logId: input.logId,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      logCount: input.logCount,
      note: input.note,
      passedCount: input.passedCount,
    };
    const nextChecks = current.checks.some((check) => check.id === id)
      ? current.checks.map((check) => (check.id === id ? nextRun : check))
      : [...current.checks, nextRun];
    nextView = { ...current, checks: nextChecks };
    const now = new Date();
    await writeClEnvelope(tx, row.id, { ...envelope, checksView: nextView }, now);
    await tx.update(megaCls).set({ ci: aggregateCheckStatus(nextChecks), updatedAt: now }).where(eq(megaCls.id, row.id));
  });
  return nextView;
}

export async function deleteCLCheckRun(
  database: Database,
  number: number,
  checkId: string,
  actorUserId: string | null | undefined,
): Promise<CLChecksView> {
  await assertWorkspaceMember(database, actorUserId);
  let nextView: CLChecksView = emptyChecksView();
  await database.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: megaCls.id })
      .from(megaCls)
      .where(eq(megaCls.number, number))
      .for("update")
      .limit(1);
    if (!row) throw new MegaNotFoundError("CL", number);
    const envelope = await loadClEnvelope(tx, row.id);
    const current = parseChecksView(envelope.checksView) ?? emptyChecksView();
    if (!current.checks.some((check) => check.id === checkId)) {
      throw new MegaNotFoundError("Check run", checkId);
    }
    const nextChecks = current.checks.filter((check) => check.id !== checkId);
    nextView = { ...current, checks: nextChecks };
    const now = new Date();
    await writeClEnvelope(tx, row.id, { ...envelope, checksView: nextView }, now);
    await tx.update(megaCls).set({ ci: aggregateCheckStatus(nextChecks), updatedAt: now }).where(eq(megaCls.id, row.id));
  });
  return nextView;
}
