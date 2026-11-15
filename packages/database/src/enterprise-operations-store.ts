// megaui-only (FS-81): approved admin mutations have no upstream counterpart.
/**
 * FS-81：管理员写事务与 epoch 幂等。
 *
 * 一个 operation id 只提交一次。重放返回原结果；同一 id 的不同 payload 拒绝。
 * policy epoch 在事务内 `FOR UPDATE` 读回，不符则整笔回滚。
 */
import type { PoolClient } from "pg";

export interface ProvisionedRow { row: number; localUserId: string }

export interface AppliedRow { row: number; localUserId: string }

/** Private ordinary-ledger audit; never part of the public CLI result. */
export interface AffectedRow {
  row: number;
  localUserId: string;
  expectedUserVersion: string;
  expectedIdentityVersion: number | null;
  expectedProfileDigest: string | null;
  quarantineOperationId: string | null;
}

export function validAffectedRows(value: unknown, counts: unknown, verb: "quarantine" | "repair",
  expected?: readonly AffectedRow[]): value is AffectedRow[] {
  const countKey = verb === "quarantine" ? "quarantined" : "repaired";
  if (!Array.isArray(value) || value.length > 100 || (verb === "repair" && value.length === 0) ||
    (expected !== undefined && value.length !== expected.length) ||
    !counts || typeof counts !== "object" || Array.isArray(counts) || Object.keys(counts).length !== 1 ||
    (counts as Record<string, unknown>)[countKey] !== value.length) return false;
  const keys = ["row", "localUserId", "expectedUserVersion", "expectedIdentityVersion", "expectedProfileDigest", "quarantineOperationId"] as const;
  const ids = new Set<string>(), hash = /^[a-f0-9]{64}$/;
  return Array.from(value).every((entry: unknown, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const row = entry as Record<string, unknown>, id = row.localUserId;
    if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) ||
      row.row !== index + 1 || typeof id !== "string" || !id.trim() || [...id].length > 256 || id.includes("\0") ||
      [...id].some(char => { const point = char.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff; }) ||
      ids.has(id) || typeof row.expectedUserVersion !== "string" || !hash.test(row.expectedUserVersion)) return false;
    if (verb === "quarantine" ? row.expectedIdentityVersion !== null || row.expectedProfileDigest !== null || row.quarantineOperationId !== null :
      !Number.isSafeInteger(row.expectedIdentityVersion) || Number(row.expectedIdentityVersion) < 0 || Number(row.expectedIdentityVersion) > 2147483647 ||
      typeof row.expectedProfileDigest !== "string" || !hash.test(row.expectedProfileDigest) ||
      typeof row.quarantineOperationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.quarantineOperationId)) return false;
    if (expected !== undefined && keys.some(key => row[key] !== expected[index]?.[key])) return false;
    ids.add(id);
    return true;
  });
}

/** Fixed global manifest rows and original, case-sensitive text IDs, bounded to one batch. */
export function validAppliedRows(value: unknown, counts: unknown, expected?: readonly AppliedRow[]): value is AppliedRow[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 ||
    (expected !== undefined && value.length !== expected.length) ||
    !counts || typeof counts !== "object" || Array.isArray(counts) ||
    Object.keys(counts).length !== 1 || !("bound" in counts) || counts.bound !== value.length) return false;
  const first = (value[0] as AppliedRow | undefined)?.row;
  if (!Number.isSafeInteger(first) || first! < 1 || first! + value.length - 1 > 10_000 || (first! - 1) % 100 !== 0) return false;
  const ids = new Set<string>();
  return Array.from(value).every((entry: unknown, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const row = entry as Record<string, unknown>, id = row.localUserId;
    if (Object.keys(row).length !== 2 || row.row !== first! + index || typeof id !== "string" ||
      !id.trim() || [...id].length > 256 || id.includes("\0") ||
      [...id].some(char => { const point = char.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff; }) ||
      ids.has(id) || (expected !== undefined && (row.row !== expected[index]?.row || id !== expected[index]?.localUserId))) return false;
    ids.add(id);
    return true;
  });
}

/** A provision result has exactly one entry for every approved manifest row. */
export function validProvisionedRows(value: unknown, counts: unknown, expectedCount?: number): value is ProvisionedRow[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 ||
    (expectedCount !== undefined && value.length !== expectedCount) ||
    !counts || typeof counts !== "object" || Array.isArray(counts) ||
    Object.keys(counts).length !== 1 || !("created" in counts) || counts.created !== value.length) return false;
  const ids = new Set<string>();
  return Array.from(value).every((entry: unknown, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).length !== 2 || row.row !== index + 1 || typeof row.localUserId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.localUserId) ||
      ids.has(row.localUserId.toLowerCase())) return false;
    ids.add(row.localUserId.toLowerCase());
    return true;
  });
}

export interface StoredOperationResult {
  policyEpoch: number;
  resultCounts: Record<string, number>;
  payloadDigest: string;
  provisioned?: ProvisionedRow[];
  applied?: AppliedRow[];
  affected?: AffectedRow[];
}

export type OperationApplyDecision =
  | { kind: "replay"; result: StoredOperationResult }
  | { kind: "ready"; policyEpoch: number }
  | { kind: "payload-mismatch" }
  | { kind: "invalid-operation" }
  | { kind: "epoch-mismatch" }
  | { kind: "missing-policy" };

/** Locks the policy row and decides whether this operation may write. */
export async function beginApprovedOperation(
  client: PoolClient,
  input: {
    scope: string;
    operationId: string;
    expectedPolicyEpoch: number;
    payloadDigest: string;
    verb: string;
    manifestDigest: string | null;
  },
): Promise<OperationApplyDecision> {
  // operation_id is unique across scopes. The advisory lock also serializes
  // first attempts in different scopes; hash collisions only add contention.
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [input.operationId]);
  const policy = await client.query<{ auth_epoch: number }>(
    `select auth_epoch from "enterprise_policy" where scope = $1 for update`,
    [input.scope],
  );
  const epoch = policy.rows[0]?.auth_epoch;
  if (epoch === undefined) return { kind: "missing-policy" };
  const existing = await client.query<{
    state: string;
    verb: string;
    manifest_digest: string;
    result: unknown;
  }>(
    `select state, verb, manifest_digest, result
       from "enterprise_admin_operations" where operation_id = $1 for update`,
    [input.operationId],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.state !== "completed" || !isStoredResult(row.result, row.verb)) {
      return { kind: "invalid-operation" };
    }
    if (
      row.result.payloadDigest !== input.payloadDigest ||
      row.verb !== input.verb ||
      row.manifest_digest !== (input.manifestDigest ?? input.payloadDigest)
    ) {
      return { kind: "payload-mismatch" };
    }
    return { kind: "replay", result: row.result };
  }
  if (epoch !== input.expectedPolicyEpoch) return { kind: "epoch-mismatch" };
  return { kind: "ready", policyEpoch: epoch };
}

function isStoredResult(value: unknown, verb: string): value is StoredOperationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (verb === "quarantine" || verb === "repair") {
    if (Object.keys(result).length !== 4 || !validAffectedRows(result.affected, result.resultCounts, verb)) return false;
  } else if (Object.hasOwn(result, "affected")) return false;
  if (verb === "provision" ? !validProvisionedRows(result.provisioned, result.resultCounts) :
    Object.hasOwn(result, "provisioned")) return false;
  if (verb === "apply" ? !validAppliedRows(result.applied, result.resultCounts) :
    Object.hasOwn(result, "applied")) return false;
  if (
    !Number.isSafeInteger(result.policyEpoch) ||
    (result.policyEpoch as number) < 0 ||
    typeof result.payloadDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(result.payloadDigest) ||
    !result.resultCounts ||
    typeof result.resultCounts !== "object" ||
    Array.isArray(result.resultCounts)
  ) return false;
  return Object.values(result.resultCounts).every(
    (count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
  );
}

/** Records the committed result. The caller owns the surrounding transaction. */
export async function completeApprovedOperation(
  client: PoolClient,
  input: {
    operationId: string;
    verb: string;
    manifestDigest: string | null;
    result: StoredOperationResult;
  },
): Promise<void> {
  if (!isStoredResult(input.result, input.verb)) throw new Error("invalid operation result");
  await client.query(
    `insert into "enterprise_admin_operations"
       (id, operation_id, verb, manifest_digest, state, result, attempts, started_at, finished_at)
     values ($1, $2, $3, $4, 'completed', $5::jsonb, 1, now(), now())`,
    [
      input.operationId,
      input.operationId,
      input.verb,
      input.manifestDigest ?? input.result.payloadDigest,
      JSON.stringify(input.result),
    ],
  );
}

/** FS-61 internal rows never enter the ordinary approved-operation replay channel. */
export interface StoredMigrationRun {
  id: string;
  operation_id: string;
  verb: string;
  manifest_digest: string;
  state: string;
  expected_user_version: number | null;
  expected_identity_version: number | null;
  result: unknown;
}

/** The caller already holds the FS-81 policy lock and owns the transaction. */
export async function lockMigrationRunSources(client: PoolClient, runId: string, scope: string): Promise<StoredMigrationRun[]> {
  const isolation = await client.query<{ isolation: string }>("select current_setting('transaction_isolation') as isolation");
  if (isolation.rows[0]?.isolation !== "read committed") throw new Error("MIGRATION_TRANSACTION_REJECTED");
  await client.query("select set_config(name,least(coalesce(nullif(setting::int,0),5000),5000)::text,true) " +
    "from pg_settings where name in ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout')");
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [runId]);
  const rows = await client.query<StoredMigrationRun>("select id,operation_id,verb,manifest_digest,state," +
    "expected_user_version,expected_identity_version,result from enterprise_admin_operations " +
    "where id=$1 or operation_id=$1 for update", [runId]);
  const inventory = await client.query("select scope from enterprise_actor_inventory where scope=$1 for update", [scope]);
  // A missing row cannot be protected by a row lock; never accept a later insertion.
  if (inventory.rowCount !== 1) throw new Error("MIGRATION_INVENTORY_REJECTED");
  await client.query('lock table "user",enterprise_profile,enterprise_quarantine,enterprise_actor_reservations,enterprise_identity in share mode');
  return rows.rows;
}

export async function insertMigrationRun(client: PoolClient, runId: string, manifestDigest: string, result: unknown): Promise<void> {
  await client.query("insert into enterprise_admin_operations(id,operation_id,verb,manifest_digest,state,result,attempts,started_at) " +
    "values ($1,$1,'internal:migration-run:v1',$2,'running',$3::jsonb,1,now())", [runId, manifestDigest, JSON.stringify(result)]);
}

/** Compare the loaded JSON as well, so a callback cannot silently rewrite the initial approval. */
export async function updateMigrationRun(client: PoolClient, input: {
  runId: string; manifestDigest: string; previous: unknown; result: unknown; completed: boolean;
}): Promise<void> {
  const result = await client.query("update enterprise_admin_operations set result=$4::jsonb,state=$5,updated_at=now()," +
    "finished_at=case when $5='completed' then now() else null end " +
    "where id=$1 and operation_id=$1 and verb='internal:migration-run:v1' and manifest_digest=$2 " +
    "and result=$3::jsonb and expected_user_version is null and expected_identity_version is null",
  [input.runId, input.manifestDigest, JSON.stringify(input.previous), JSON.stringify(input.result), input.completed ? "completed" : "running"]);
  if (result.rowCount !== 1) throw new Error("MIGRATION_LEDGER_CHANGED");
}

export async function recordMigrationCheckpoint(client: PoolClient, input: {
  operationId: string; manifestDigest: string; batchNumber: number; processed: number;
}): Promise<void> {
  await client.query("insert into enterprise_batch_checkpoints(id,operation_id,manifest_digest,batch_number,processed,completed_at) " +
    "values ($1,$2,$3,$4,$5,now())", [input.operationId + ":" + input.batchNumber, input.operationId,
    input.manifestDigest, input.batchNumber, input.processed]);
}
