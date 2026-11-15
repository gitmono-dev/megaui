// megaui-only (FS-61): immutable migration approval and transactional phase poststates.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { lockMigrationRunSources, insertMigrationRun, updateMigrationRun, recordMigrationCheckpoint,
  targetFingerprint, type EnterpriseScopeExpectation, type StoredMigrationRun } from "@megaui/database";
import type { GuardedWriteContext } from "../../cli/admin-approval";
import { canonicalizeJson } from "../../cli/admin-payload";
import { deriveHistoricalActor, inspectActorReservationCoverage } from "./actor-reservations";
import { compatibilityEmail } from "./identity-key";
import { readMigrationSources, type MigrationSources } from "./migration-preview";
import { parseMigrationManifest, buildMigrationEnvelope, validateMigrationEnvelope, migrationManifestDigest,
  migrationUserVersion, migrationIdentityDigest, migrationProfileDigest, validMigrationIdentifier,
  type MigrationAuthority, type MigrationMember, type MigrationEnvelope, type MigrationEnvelopeMember,
  type MigrationIdentitySource } from "./manifest";

export class MigrationLedgerRejected extends Error {
  constructor(readonly key: "MIGRATION_INPUT_REJECTED" | "MIGRATION_LEDGER_REJECTED" | "MIGRATION_SOURCE_CHANGED" |
    "MIGRATION_PHASE_REJECTED" | "MIGRATION_POSTSTATE_REJECTED") { super(key); this.name = "MigrationLedgerRejected"; }
}
function reject(key: MigrationLedgerRejected["key"]): never { throw new MigrationLedgerRejected(key); }
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const rowSchema = z.object({ row: z.number().int().positive(), stage: z.enum(["pending", "bound", "converted"]),
  userVersion: hash, identityDigest: hash, profileDigest: hash, lastOperationId: z.string().uuid().nullable() }).strict();
type LedgerRow = z.infer<typeof rowSchema>;
const runSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("migration-run"),
  migrationRunId: z.string().regex(/^migration-run:[a-f0-9]{64}$/), targetFingerprint: z.string().min(1),
  manifestDigest: hash, initialEnvelope: z.unknown(), rows: z.array(rowSchema).min(1).max(10_000) }).strict();
interface MigrationRun extends Omit<z.infer<typeof runSchema>, "initialEnvelope"> { initialEnvelope: MigrationEnvelope }

export function migrationRunId(fingerprint: string, manifestDigest: string): string {
  if (typeof fingerprint !== "string" || !fingerprint || !hash.safeParse(manifestDigest).success) reject("MIGRATION_INPUT_REJECTED");
  return "migration-run:" + createHash("sha256").update(canonicalizeJson({ schemaVersion: 1,
    targetFingerprint: fingerprint, manifestDigest })).digest("hex");
}
function initialRow(member: MigrationEnvelopeMember, index: number): LedgerRow {
  return { row: index + 1, stage: "pending", userVersion: member.source_user_version,
    identityDigest: member.source_identity_digest, profileDigest: member.source_profile_digest, lastOperationId: null };
}
function sameSource(a: Pick<LedgerRow, "userVersion" | "identityDigest" | "profileDigest">, b: typeof a): boolean {
  return a.userVersion === b.userVersion && a.identityDigest === b.identityDigest && a.profileDigest === b.profileDigest;
}
function manifestInput(member: MigrationEnvelopeMember): MigrationMember {
  const { local_user_id, tenant_key, app_id, open_id, login_name, expected_user_version, expected_identity_version } = member;
  return { local_user_id, tenant_key, app_id, open_id, login_name, expected_user_version, expected_identity_version };
}
function loadRun(stored: StoredMigrationRun, runId: string, fingerprint: string, digest: string): MigrationRun {
  try {
    const parsed = runSchema.parse(stored.result), initialEnvelope = validateMigrationEnvelope(parsed.initialEnvelope);
    const run: MigrationRun = { ...parsed, initialEnvelope };
    if (stored.id !== runId || stored.operation_id !== runId || stored.verb !== "internal:migration-run:v1" ||
      stored.manifest_digest !== digest || stored.expected_user_version !== null || stored.expected_identity_version !== null ||
      run.migrationRunId !== runId || run.targetFingerprint !== fingerprint || run.manifestDigest !== digest ||
      initialEnvelope.targetFingerprint !== fingerprint || migrationManifestDigest(initialEnvelope) !== digest ||
      migrationRunId(fingerprint, digest) !== runId || run.rows.length !== initialEnvelope.members.length) reject("MIGRATION_LEDGER_REJECTED");
    for (const [index, row] of run.rows.entries()) {
      if (row.row !== index + 1 || (row.stage === "pending" ? row.lastOperationId !== null ||
        !sameSource(row, initialRow(initialEnvelope.members[index]!, index)) : row.lastOperationId === null)) reject("MIGRATION_LEDGER_REJECTED");
      // Every legal transition commits one fixed, complete batch atomically.
      const first = run.rows[Math.floor(index / 100) * 100]!;
      if (row.stage !== first.stage || row.lastOperationId !== first.lastOperationId) reject("MIGRATION_LEDGER_REJECTED");
    }
    if (stored.state !== (run.rows.every(row => row.stage === "converted") ? "completed" : "running")) reject("MIGRATION_LEDGER_REJECTED");
    return run;
  } catch { return reject("MIGRATION_LEDGER_REJECTED"); }
}

function capture(sources: MigrationSources, members: readonly MigrationMember[], authority: MigrationAuthority) {
  const users = new Map(sources.users.map(row => [row.id, row])), profiles = new Map(sources.profiles.map(row => [row.user_id, row]));
  const bindings = new Map<string, MigrationIdentitySource[]>();
  const external = new Map<string, string>(), aliases = new Map<string, string>();
  for (const row of sources.identities) {
    const values = bindings.get(row.local_user_id) ?? []; values.push(row); bindings.set(row.local_user_id, values);
    if (row.tenant_key === authority.tenantKey && row.app_id === authority.appId) external.set(row.open_id, row.local_user_id);
  }
  for (const row of sources.profiles) if (row.tenant_key === authority.tenantKey) aliases.set(row.login_name, row.user_id);
  const subjects = new Map(sources.actorState.subjects.map(row => [row.id, row]));
  const reservations = new Map(sources.actorState.rows.map(row => [row.actor, row]));
  const emails = new Map(sources.actorState.subjects.map(row => [row.email, row.id]));
  return members.map(member => {
    const user = users.get(member.local_user_id), profile = profiles.get(member.local_user_id) ?? null;
    const identities = bindings.get(member.local_user_id) ?? [], identity = identities[0];
    if (!user || identities.length > 1 || identities.some(row => row.tenant_key !== authority.tenantKey || row.app_id !== authority.appId ||
      row.open_id !== member.open_id || row.status !== "active") ||
      (profile && (profile.tenant_key !== authority.tenantKey || profile.login_name !== member.login_name)) ||
      (external.has(member.open_id) && external.get(member.open_id) !== member.local_user_id) ||
      (aliases.has(member.login_name) && aliases.get(member.login_name) !== member.local_user_id)) reject("MIGRATION_SOURCE_CHANGED");
    const actor = deriveHistoricalActor({ name: user.name, email: user.email, frozenBackendUsername: profile?.backend_username });
    const reservation = actor === undefined ? undefined : reservations.get(actor), subject = subjects.get(user.id);
    const key = compatibilityEmail(user.id), owner = emails.get(key);
    if (!actor || !/\P{White_Space}/u.test(actor) || !subject || subject.quarantined || !reservation ||
      reservation.state !== "reserved" || reservation.localUserId !== user.id || reservation.quarantined ||
      (owner !== undefined && owner !== user.id) || (user.email.toLowerCase().endsWith("@identity.invalid") &&
      (user.email !== key || !identity || !profile))) reject("MIGRATION_SOURCE_CHANGED");
    return { user, profile, identities, actor, userVersion: migrationUserVersion(user),
      identityDigest: migrationIdentityDigest(identities), profileDigest: migrationProfileDigest(profile) };
  });
}
type Captured = ReturnType<typeof capture>[number];
function bound(current: Captured, member: MigrationEnvelopeMember): void {
  if (current.identities.length !== 1 || !current.profile || current.profile.backend_username !== member.backend_username ||
    current.profile.user_id !== member.local_user_id) reject("MIGRATION_POSTSTATE_REJECTED");
}
function currentMatches(run: MigrationRun, current: readonly Captured[]): void {
  for (const [index, row] of run.rows.entries()) {
    const actual = current[index]!, member = run.initialEnvelope.members[index]!;
    if (!sameSource(row, actual) || actual.actor !== member.backend_username) reject("MIGRATION_SOURCE_CHANGED");
    if (row.stage !== "pending") bound(actual, member);
    if (row.stage === "converted" && (actual.user.email !== compatibilityEmail(member.local_user_id) || actual.user.emailVerified)) {
      reject("MIGRATION_SOURCE_CHANGED");
    }
  }
}
function legalPoststate(phase: "bound" | "converted", before: Captured, after: Captured, member: MigrationEnvelopeMember): void {
  bound(after, member);
  if (after.actor !== member.backend_username) reject("MIGRATION_POSTSTATE_REJECTED");
  if (phase === "bound") {
    if (before.userVersion !== after.userVersion || (before.profile && before.profileDigest !== after.profileDigest) ||
      (before.identities.length ? before.identityDigest !== after.identityDigest : after.identities[0]?.identity_version !== 1)) {
      reject("MIGRATION_POSTSTATE_REJECTED");
    }
  } else {
    const old = before.profile, next = after.profile;
    if (!old || !next || after.user.email !== compatibilityEmail(member.local_user_id) || after.user.emailVerified ||
      before.user.id !== after.user.id || before.user.name !== after.user.name || before.user.banned !== after.user.banned ||
      before.identityDigest !== after.identityDigest) reject("MIGRATION_POSTSTATE_REJECTED");
    const notification = old.notification_email ?? (before.user.email === compatibilityEmail(member.local_user_id) ? null : before.user.email);
    if (migrationProfileDigest({ ...old, notification_email: notification, updated_at: next.updated_at }) !== after.profileDigest) {
      reject("MIGRATION_POSTSTATE_REJECTED");
    }
  }
}

export interface MigrationBatchResult {
  migrationRunId: string; batchNumber: number; phase: "bound" | "converted"; processed: number;
  replayed: boolean; localUserIds: readonly string[];
}
type Mutation = (client: PoolClient, members: readonly MigrationEnvelopeMember[]) => Promise<void>;

/**
 * Trusted bootstrap binds authority. Only an FS-81 approved handler supplies the
 * context/client; the structural context is not a standalone authorization token.
 * The consumer completes provider admission before calling this SQL-only port.
 */
export function createMigrationLedger(options: {
  expectation: EnterpriseScopeExpectation; authority: MigrationAuthority; now?: () => Date;
}) {
  const expectation = Object.freeze({ ...options.expectation }), authority = Object.freeze({ ...options.authority });
  const fingerprint = targetFingerprint(expectation), now = options.now ?? (() => new Date());
  if (!["admin", "test"].includes(expectation.processRole) ||
    ![expectation.instanceId, expectation.ownerFingerprint, expectation.environment, authority.tenantKey, authority.appId].every(validMigrationIdentifier)) {
    reject("MIGRATION_INPUT_REJECTED");
  }
  async function transact(context: GuardedWriteContext, client: PoolClient, mutate?: Mutation): Promise<MigrationBatchResult | undefined> {
    const verb = context.verb, operationId = context.operationId, digest = context.args.digest;
    const activate = mutate === undefined, batchNumber = context.args["batch-number"];
    if ((activate ? verb !== "activate" : !["apply", "convert"].includes(verb)) ||
      context.args.target !== expectation.instanceId || context.args["operation-id"] !== operationId ||
      !z.string().uuid().safeParse(operationId).success || !hash.safeParse(digest).success ||
      !Number.isSafeInteger(context.args["expect-policy-epoch"]) || Number(context.args["expect-policy-epoch"]) < 0) reject("MIGRATION_INPUT_REJECTED");
    const manifestDigest = digest as string;
    const bytes = context.files.bytes("manifest");
    if (!bytes) reject("MIGRATION_INPUT_REJECTED");
    const members = parseMigrationManifest(bytes, authority);
    if (!activate && (!Number.isSafeInteger(batchNumber) || Number(batchNumber) < 0 || Number(batchNumber) >= Math.ceil(members.length / 100))) {
      reject("MIGRATION_INPUT_REJECTED");
    }
    const runId = migrationRunId(fingerprint, manifestDigest), epoch = context.args["expect-policy-epoch"];
    // SAVEPOINT fails before any write when the supplied client has no outer transaction.
    await client.query("savepoint fs61_migration");
    try {
      const stored = await lockMigrationRunSources(client, runId, expectation.instanceId);
      if (stored.length > 1) reject("MIGRATION_LEDGER_REJECTED");
      const policy = await client.query<{ auth_epoch: number; activation_state: string; owner_fingerprint: string; environment: string; deployment_role: string }>(
        "select auth_epoch,activation_state,owner_fingerprint,environment,deployment_role from enterprise_policy where scope=$1", [expectation.instanceId]);
      const marker = policy.rows[0];
      if (policy.rowCount !== 1 || !marker || marker.auth_epoch !== epoch || marker.owner_fingerprint !== expectation.ownerFingerprint ||
        marker.environment !== expectation.environment || marker.deployment_role !== expectation.environment ||
        (verb === "convert" && marker.activation_state !== "maintenance")) reject("MIGRATION_PHASE_REJECTED");
      const sources = await readMigrationSources(client, members, expectation.instanceId, authority);
      const coverage = inspectActorReservationCoverage(sources.actorState, { now: now() });
      if (!coverage.complete) reject("MIGRATION_SOURCE_CHANGED");
      const before = capture(sources, members, authority);
      let run: MigrationRun;
      if (stored[0]) run = loadRun(stored[0], runId, fingerprint, manifestDigest);
      else {
        if (verb !== "apply") reject("MIGRATION_PHASE_REJECTED");
        const initialEnvelope = buildMigrationEnvelope({ targetFingerprint: fingerprint, ...authority,
          ownershipDigest: coverage.ownershipDigest, members: members.map((member, index) => {
            const current = before[index]!;
            if (member.expected_user_version !== current.userVersion ||
              member.expected_identity_version !== (current.identities[0]?.identity_version ?? 0)) reject("MIGRATION_SOURCE_CHANGED");
            return { ...member, backend_username: current.actor, source_user_version: current.userVersion,
              source_identity_digest: current.identityDigest, source_profile_digest: current.profileDigest };
          }) });
        if (migrationManifestDigest(initialEnvelope) !== manifestDigest) reject("MIGRATION_SOURCE_CHANGED");
        run = { schemaVersion: 1, kind: "migration-run", migrationRunId: runId, targetFingerprint: fingerprint,
          manifestDigest, initialEnvelope, rows: initialEnvelope.members.map(initialRow) };
        await insertMigrationRun(client, runId, manifestDigest, run);
      }
      if (run.initialEnvelope.tenantKey !== authority.tenantKey || run.initialEnvelope.appId !== authority.appId ||
        canonicalizeJson(run.initialEnvelope.members.map(manifestInput)) !== canonicalizeJson(members) ||
        run.initialEnvelope.ownershipDigest !== coverage.ownershipDigest) reject("MIGRATION_SOURCE_CHANGED");
      currentMatches(run, before);
      if (activate) {
        if (run.rows.some(row => row.stage !== "converted")) reject("MIGRATION_PHASE_REJECTED");
        if (!inspectActorReservationCoverage(sources.actorState, { now: now(), expectedOwnershipDigest: run.initialEnvelope.ownershipDigest }).complete) {
          reject("MIGRATION_SOURCE_CHANGED");
        }
        await client.query("release savepoint fs61_migration");
        return;
      }
      const number = batchNumber as number, start = number * 100, end = Math.min(start + 100, members.length);
      const phase = verb === "apply" ? "bound" : "converted";
      if (phase === "converted" && run.rows.some(row => row.stage === "pending")) reject("MIGRATION_PHASE_REJECTED");
      const replayed = run.rows.slice(start, end).every(row => phase === "bound" ? row.stage !== "pending" : row.stage === "converted");
      let finalInventory = sources.actorState;
      if (!replayed) {
        if (run.rows.slice(start, end).some(row => row.stage !== (phase === "bound" ? "pending" : "bound"))) reject("MIGRATION_PHASE_REJECTED");
        const batch = Object.freeze(run.initialEnvelope.members.slice(start, end).map(member => Object.freeze({ ...member })));
        await mutate!(client, batch);
        const afterSources = await readMigrationSources(client, members, expectation.instanceId, authority);
        finalInventory = afterSources.actorState;
        if (!inspectActorReservationCoverage(afterSources.actorState, { now: now(), expectedOwnershipDigest: run.initialEnvelope.ownershipDigest }).complete) {
          reject("MIGRATION_SOURCE_CHANGED");
        }
        const after = capture(afterSources, members, authority), rows = run.rows.map((row, index): LedgerRow => {
          if (index < start || index >= end) {
            if (!sameSource(before[index]!, after[index]!)) reject("MIGRATION_POSTSTATE_REJECTED");
            return row;
          }
          legalPoststate(phase, before[index]!, after[index]!, run.initialEnvelope.members[index]!);
          return { row: index + 1, stage: phase, userVersion: after[index]!.userVersion,
            identityDigest: after[index]!.identityDigest, profileDigest: after[index]!.profileDigest, lastOperationId: operationId };
        });
        await updateMigrationRun(client, { runId, manifestDigest, previous: run, result: { ...run, rows },
          completed: rows.every(row => row.stage === "converted") });
      } else if (!inspectActorReservationCoverage(sources.actorState, { now: now(), expectedOwnershipDigest: run.initialEnvelope.ownershipDigest }).complete) {
        reject("MIGRATION_SOURCE_CHANGED");
      }
      const finalPolicy = await client.query<{ auth_epoch: number }>("select auth_epoch from enterprise_policy where scope=$1", [expectation.instanceId]);
      if (finalPolicy.rows[0]?.auth_epoch !== epoch) reject("MIGRATION_PHASE_REJECTED");
      await recordMigrationCheckpoint(client, { operationId, manifestDigest, batchNumber: number, processed: end - start });
      if (!inspectActorReservationCoverage(finalInventory, { now: now(), expectedOwnershipDigest: run.initialEnvelope.ownershipDigest }).complete) {
        reject("MIGRATION_SOURCE_CHANGED");
      }
      await client.query("release savepoint fs61_migration");
      return { migrationRunId: runId, batchNumber: number, phase, processed: end - start, replayed,
        localUserIds: Object.freeze(members.slice(start, end).map(member => member.local_user_id)) };
    } catch (error) {
      try { await client.query("rollback to savepoint fs61_migration"); await client.query("release savepoint fs61_migration"); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "MIGRATION_ROLLBACK_FAILED", { cause: cleanup }); }
      throw error;
    }
  }
  return Object.freeze({
    async executeBatch(context: GuardedWriteContext, client: PoolClient, mutate: Mutation): Promise<MigrationBatchResult> {
      if (typeof mutate !== "function") reject("MIGRATION_INPUT_REJECTED");
      return (await transact(context, client, mutate))!;
    },
    async assertConverted(context: GuardedWriteContext, client: PoolClient): Promise<void> { await transact(context, client); },
  });
}
