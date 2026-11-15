// megaui-only (FS-52): read-only migration readiness has no upstream counterpart.
/**
 * FS-52：ready-check审批前置合同。
 *
 * The check is deliberately a separate read-only service. It uses one
 * repeatable-read, read-only PostgreSQL transaction, validates the target and
 * all persisted migration prerequisites, then rolls the transaction back. It
 * never calls a provider, enters maintenance, or advances an operation ledger.
 */
import { Pool, type PoolClient } from "pg";

import {
  assertEnterpriseScope,
  readSqlRolePrivileges,
  targetFingerprint,
  type EnterpriseScopeExpectation,
  type EnterpriseTargetMarker,
} from "@megaui/database";

import { DIRECTORY_FRESHNESS_LIMIT_MS, isDirectoryFresh } from "./directory-sync";
import {
  deriveHistoricalActor,
  inspectActorReservationCoverage,
  readActorInventoryState,
} from "./actor-reservations";
import {
  evaluateRows,
  readMigrationSources,
} from "./migration-preview";
import {
  buildMigrationEnvelope,
  migrationManifestDigest,
  parseMigrationManifest,
  type MigrationAuthority,
} from "./manifest";

export type ReadinessFailure =
  | "UNQUARANTINED_SUBJECT"
  | "ACTIVE_ACTOR_CONFLICT"
  | "ACTOR_INVENTORY_INCOMPLETE"
  | "DIRECTORY_MISSING"
  | "DIRECTORY_INCOMPLETE"
  | "DIRECTORY_STALE"
  | "DIRECTORY_GENERATION_MISMATCH"
  | "WORKER_NOT_READY"
  | "COLLAB_EPOCH_MISMATCH"
  | "MIGRATION_CONFLICT";

export interface ReadinessReport {
  schemaVersion: 1;
  targetFingerprint: string;
  policyEpoch: number;
  status: "ready" | "conflict";
  manifestDigest: string | null;
  counts: {
    total: number;
    ready: number;
    conflicts: number;
    unquarantinedSubjects: number;
    activeActorConflicts: number;
  };
  checks: {
    actorInventory: "ready" | "conflict";
    directory: "ready" | "conflict";
    worker: "ready" | "conflict";
    collab: "ready" | "conflict";
    database: "read-only";
  };
  failures: ReadinessFailure[];
}

export class ReadinessError extends Error {
  constructor(readonly exitCode: 2 | 3 | 4, key: string) {
    super(key);
    this.name = "ReadinessError";
  }
}

export interface ReadinessOptions {
  bytes: Uint8Array;
  databaseUrl: string;
  expectation: EnterpriseScopeExpectation;
  authority: MigrationAuthority;
  directoryScopeHash: string;
  workerReady: boolean;
  collabPolicyEpochs: readonly number[];
  now?: () => Date;
  onQuery?: (sql: string) => void;
}

interface DirectoryState {
  watermarkGeneration: number | null;
  snapshotGeneration: number | null;
  complete: boolean;
  observedAt: Date | null;
}

function boundedConnectionString(value: string): string {
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length <= 1) {
      throw new Error("connection");
    }
    let budget = 5000;
    for (const supplied of url.searchParams.getAll("query_timeout")) {
      if (!/^\d+$/.test(supplied) || !Number.isSafeInteger(Number(supplied))) throw new Error("timeout");
      budget = Math.min(budget, Number(supplied) || budget);
    }
    url.searchParams.set("query_timeout", String(budget));
    return url.toString();
  } catch {
    throw new ReadinessError(2, "INVALID_CONFIG");
  }
}

function traceClient(client: PoolClient, onQuery: ((sql: string) => void) | undefined): PoolClient {
  if (!onQuery) return client;
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "query") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const statement = args[0];
        if (typeof statement === "string") onQuery(statement);
        else if (statement !== null && typeof statement === "object" &&
          "text" in statement && typeof statement.text === "string") onQuery(statement.text);
        return Reflect.apply(target.query as unknown as (...input: unknown[]) => unknown, target, args);
      };
    },
  }) as PoolClient;
}

function uniqueFailures(failures: ReadinessFailure[]): ReadinessFailure[] {
  return [...new Set(failures)].sort();
}

function validEpochs(values: readonly number[], policyEpoch: number): boolean {
  return values.length === 2 && values.every((value) => Number.isSafeInteger(value) && value === policyEpoch);
}

async function readDirectoryState(client: PoolClient, scopeHash: string): Promise<DirectoryState> {
  const result = await client.query<{
    watermark_generation: number | null;
    snapshot_generation: number | null;
    complete: boolean | null;
    observed_at: Date | null;
  }>(
    `select watermark.generation as watermark_generation,
            snapshot.generation as snapshot_generation,
            snapshot.complete,
            snapshot.observed_at
       from "enterprise_directory_watermarks" as watermark
       left join "enterprise_directory_snapshots" as snapshot
         on snapshot.scope_hash = watermark.scope_hash
        and snapshot.generation = watermark.generation
      where watermark.scope_hash = $1`,
    [scopeHash],
  );
  const row = result.rows[0];
  return {
    watermarkGeneration: row?.watermark_generation ?? null,
    snapshotGeneration: row?.snapshot_generation ?? null,
    complete: row?.complete === true,
    observedAt: row?.observed_at ?? null,
  };
}

/** Runs the complete ready-check without committing any database statement. */
export async function runReadinessCheck(options: ReadinessOptions): Promise<ReadinessReport> {
  if (options.expectation.processRole !== "admin" && options.expectation.processRole !== "test") {
    throw new ReadinessError(2, "INVALID_CONFIG");
  }
  if (!["development", "test"].includes(options.expectation.environment)) {
    throw new ReadinessError(3, "TARGET_ENVIRONMENT_REJECTED");
  }
  const members = parseMigrationManifest(options.bytes, options.authority);
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new ReadinessError(2, "INVALID_CONFIG");

  const pool = new Pool({
    connectionString: boundedConnectionString(options.databaseUrl),
    max: 1,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
  });
  pool.on("error", () => {});
  let client: PoolClient | undefined;
  let transactionOpen = false;
  try {
    client = traceClient(await pool.connect(), options.onQuery);
    await client.query("begin isolation level repeatable read read only");
    transactionOpen = true;
    await client.query(
      "select set_config(name, least(coalesce(nullif(setting::int,0),5000),5000)::text, true) " +
        "from pg_settings where name in ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout')",
    );

    const policy = await client.query<EnterpriseTargetMarker & { deploymentRole: string }>(
      'select scope, owner_fingerprint as "ownerFingerprint", environment, activation_state as "activationState", ' +
        'auth_epoch as "authEpoch", deployment_role as "deploymentRole" from "enterprise_policy" order by created_at limit 2',
    );
    const marker = policy.rows[0];
    if (policy.rows.length !== 1 || !marker || !Number.isSafeInteger(marker.authEpoch) || marker.authEpoch < 0) {
      throw new ReadinessError(3, "SCOPE_REJECTED");
    }
    try {
      const privileges = await readSqlRolePrivileges(client as unknown as Pool);
      assertEnterpriseScope({ marker, expectation: options.expectation, privileges });
    } catch (error) {
      if (error instanceof ReadinessError) throw error;
      throw new ReadinessError(3, "SCOPE_REJECTED");
    }

    const actorState = await readActorInventoryState(client, options.expectation.instanceId);
    const coverage = inspectActorReservationCoverage(actorState, { now });
    const activeActorConflicts = actorState.rows.filter((row) => row.state === "ambiguous" && actorState.subjects.some((subject) => {
      const actor = deriveHistoricalActor({
        name: subject.name,
        email: subject.email,
        frozenBackendUsername: subject.frozenBackendUsername,
      });
      return actor === row.actor && !subject.quarantined;
    })).length;
    const directory = await readDirectoryState(client, options.directoryScopeHash);
    const sources = await readMigrationSources(
      client,
      members,
      options.expectation.instanceId,
      options.authority,
    );
    const evaluated = evaluateRows(members, sources, options.authority);

    const failures: ReadinessFailure[] = [];
    if (coverage.missingUserIds.length > 0) failures.push("UNQUARANTINED_SUBJECT");
    if (activeActorConflicts > 0) failures.push("ACTIVE_ACTOR_CONFLICT");
    if (!coverage.complete) failures.push("ACTOR_INVENTORY_INCOMPLETE");
    if (directory.watermarkGeneration === null) failures.push("DIRECTORY_MISSING");
    else if (directory.snapshotGeneration === null || directory.snapshotGeneration !== directory.watermarkGeneration) {
      failures.push("DIRECTORY_GENERATION_MISMATCH");
    } else if (!directory.complete) failures.push("DIRECTORY_INCOMPLETE");
    else if (
      directory.observedAt === null ||
      !Number.isFinite(directory.observedAt.getTime()) ||
      directory.observedAt.getTime() > now.getTime() ||
      !isDirectoryFresh(directory.observedAt.getTime(), now.getTime()) ||
      now.getTime() - directory.observedAt.getTime() > DIRECTORY_FRESHNESS_LIMIT_MS
    ) {
      failures.push("DIRECTORY_STALE");
    }
    if (!options.workerReady) failures.push("WORKER_NOT_READY");
    if (!validEpochs(options.collabPolicyEpochs, marker.authEpoch)) failures.push("COLLAB_EPOCH_MISMATCH");
    if (evaluated.rows.some((row) => row.status !== "ready")) failures.push("MIGRATION_CONFLICT");

    let manifestDigest: string | null = null;
    if (failures.length === 0) {
      const envelope = buildMigrationEnvelope({
        targetFingerprint: targetFingerprint(options.expectation),
        ...options.authority,
        ownershipDigest: coverage.ownershipDigest,
        members: evaluated.envelopeMembers,
      });
      manifestDigest = migrationManifestDigest(envelope);
    }
    const unique = uniqueFailures(failures);
    await client.query("rollback");
    transactionOpen = false;
    return {
      schemaVersion: 1,
      targetFingerprint: targetFingerprint(options.expectation),
      policyEpoch: marker.authEpoch,
      status: unique.length === 0 ? "ready" : "conflict",
      manifestDigest,
      counts: {
        total: members.length,
        ready: evaluated.rows.filter((row) => row.status === "ready").length,
        conflicts: evaluated.rows.filter((row) => row.status !== "ready").length,
        unquarantinedSubjects: coverage.missingUserIds.length,
        activeActorConflicts,
      },
      checks: {
        actorInventory: coverage.complete && coverage.missingUserIds.length === 0 && activeActorConflicts === 0 ? "ready" : "conflict",
        directory: !unique.some((failure) => failure.startsWith("DIRECTORY_")) ? "ready" : "conflict",
        worker: options.workerReady ? "ready" : "conflict",
        collab: validEpochs(options.collabPolicyEpochs, marker.authEpoch) ? "ready" : "conflict",
        database: "read-only",
      },
      failures: unique,
    };
  } catch (error) {
    if (transactionOpen) {
      try { await client?.query("rollback"); } catch { /* Preserve the original failure. */ }
    }
    if (error instanceof ReadinessError) throw error;
    throw new ReadinessError(4, "DEPENDENCY_FAILED");
  } finally {
    if (client) client.release(true);
    await pool.end();
  }
}
