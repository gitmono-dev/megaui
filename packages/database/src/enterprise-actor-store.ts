// megaui-only (FS-70): durable actor inventory; caller owns the FS-81 transaction.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export interface HistoricalActorSubject {
  id: string;
  name: string;
  email: string;
  frozenBackendUsername: string | null;
  quarantined: boolean;
}

export interface StoredActorReservation {
  actor: string;
  state: "reserved" | "ambiguous" | "unclaimable";
  localUserId: string | null;
  quarantined: boolean;
  sourceDigest: string;
  observedAt: Date | null;
}

export interface StoredActorInventory {
  scope: string;
  operationId: string;
  sourceDigest: string;
  subjectsDigest: string;
  ownershipDigest: string;
  observedAt: Date;
  /** Persisted JSON is untrusted until the service validates its runtime shape. */
  upstreamActors: unknown;
}

export async function readHistoricalActorSubjects(client: PoolClient): Promise<HistoricalActorSubject[]> {
  const result = await client.query<HistoricalActorSubject>(
    'select u.id, u.name, u.email, p.backend_username as "frozenBackendUsername", ' +
    "exists(select 1 from enterprise_quarantine q where q.user_id = u.id and q.state = 'quarantined') as quarantined " +
    'from "user" u left join enterprise_profile p on p.user_id = u.id order by u.id collate "C"');
  return result.rows;
}

export async function readActorReservations(client: PoolClient): Promise<StoredActorReservation[]> {
  const result = await client.query<StoredActorReservation>(
    'select backend_username as actor, actor_state as state, local_user_id as "localUserId", ' +
    'quarantined, source_snapshot_digest as "sourceDigest", source_observed_at as "observedAt" ' +
    'from enterprise_actor_reservations order by backend_username collate "C"');
  return result.rows;
}

export async function readActorInventory(client: PoolClient, scope: string): Promise<StoredActorInventory | undefined> {
  const result = await client.query<StoredActorInventory>(
    'select scope, operation_id as "operationId", source_digest as "sourceDigest", subjects_digest as "subjectsDigest", ' +
    'ownership_digest as "ownershipDigest", observed_at as "observedAt", upstream_actors as "upstreamActors" ' +
    "from enterprise_actor_inventory where scope = $1", [scope]);
  return result.rows[0];
}

/** FS-71: use the FS-81 lock order and retain both locks through the caller's transaction. */
export async function lockActorClaimScope(client: PoolClient, scope: string): Promise<{
  activationState: string; authEpoch: number;
} | undefined> {
  const policy = await client.query<{ activationState: string; authEpoch: number }>(
    'select activation_state as "activationState", auth_epoch as "authEpoch" from enterprise_policy where scope=$1 for update', [scope]);
  await client.query("select scope from enterprise_actor_inventory where scope=$1 for update", [scope]);
  return policy.rows[0];
}

/** One batch per READ COMMITTED transaction, including callers from another factory. */
export async function beginActorClaimBatch(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ allowed: boolean }>(
    "select case when current_setting('transaction_isolation') = 'read committed' " +
    "and coalesce(current_setting('megaui.fs71_claim_started', true), '') <> '1' " +
    "then set_config('megaui.fs71_claim_started', '1', true) = '1' else false end as allowed");
  return result.rows[0]?.allowed === true;
}

/** No provider I/O follows this barrier. Settings and locks last through the outer commit. */
export async function lockActorInventoryInputs(client: PoolClient): Promise<void> {
  await client.query("select set_config(name, least(coalesce(nullif(setting::int, 0), 5000), 5000)::text, true) " +
    "from pg_settings where name in ('lock_timeout','statement_timeout','idle_in_transaction_session_timeout')");
  await client.query('lock table "user", enterprise_profile, enterprise_quarantine, enterprise_actor_reservations in share mode');
}

export interface CreatedActorBinding {
  localUserId: string;
  identityId: string;
  tenantKey: string;
  appId: string;
  openId: string;
  status: string;
  profileTenant: string;
  loginName: string;
  backendUsername: string;
}

/** Return all bindings of the new subject so an unexpected second identity cannot be hidden. */
export async function readCreatedActorBindings(client: PoolClient, localUserIds: readonly string[]): Promise<CreatedActorBinding[]> {
  const result = await client.query<CreatedActorBinding>(
    'select u.id as "localUserId", i.id as "identityId", i.tenant_key as "tenantKey", i.app_id as "appId", i.open_id as "openId", ' +
    'i.status, p.tenant_key as "profileTenant", p.login_name as "loginName", p.backend_username as "backendUsername" ' +
    'from "user" u join enterprise_profile p on p.user_id=u.id join enterprise_identity i on i.local_user_id=u.id where u.id=any($1::text[])',
    [localUserIds]);
  return result.rows;
}

/** A claim never updates or takes over an existing permanent actor row. */
export async function insertClaimedActorReservations(
  client: PoolClient, rows: readonly (StoredActorReservation & { identityId: string })[],
): Promise<void> {
  await client.query("insert into enterprise_actor_reservations " +
    "(id,backend_username,actor_state,local_user_id,identity_id,quarantined,source_snapshot_digest,source_observed_at) " +
    'select id,actor,state,"localUserId","identityId",quarantined,"sourceDigest","observedAt" ' +
    'from jsonb_to_recordset($1::jsonb) as r(id text,actor text,state text,"localUserId" text,"identityId" text,' +
    'quarantined boolean,"sourceDigest" text,"observedAt" timestamptz)',
  [JSON.stringify(rows.map(row => ({ ...row, id: randomUUID() })))]);
}

/** FS-71 updates only local digests, never the approved upstream source or its age. */
export async function updateActorInventoryLocalDigests(
  client: PoolClient, previous: StoredActorInventory,
  next: { subjectsDigest: string; ownershipDigest: string },
): Promise<boolean> {
  const result = await client.query("update enterprise_actor_inventory set subjects_digest=$2,ownership_digest=$3 " +
    "where scope=$1 and subjects_digest=$4 and ownership_digest=$5 and operation_id=$6 and source_digest=$7 " +
    "and observed_at=$8 and upstream_actors=$9::jsonb",
  [previous.scope, next.subjectsDigest, next.ownershipDigest, previous.subjectsDigest, previous.ownershipDigest,
    previous.operationId, previous.sourceDigest, previous.observedAt, JSON.stringify(previous.upstreamActors)]);
  return result.rowCount === 1;
}

/** Every chunk has at most 100 row mutations, with one monotonically numbered checkpoint. */
export async function writeActorInventory(
  client: PoolClient,
  input: {
    inventory: StoredActorInventory;
    reservations: readonly StoredActorReservation[];
    quarantines: readonly { userId: string; reason: "actor_missing" | "actor_conflict" }[];
  },
): Promise<void> {
  const inventory = input.inventory;
  const actions = [
    ...input.quarantines.map((row) => async () => {
      await client.query(
        "insert into enterprise_quarantine (id, user_id, reason, operation_id, manifest_digest) values ($1,$2,$3,$4,$5) " +
        "on conflict (user_id) do update set state = 'quarantined', reason = excluded.reason, " +
        "operation_id = excluded.operation_id, manifest_digest = excluded.manifest_digest, released_at = null, updated_at = now() " +
        "where enterprise_quarantine.state <> 'quarantined'",
        [randomUUID(), row.userId, row.reason, inventory.operationId, inventory.sourceDigest]);
    }),
    ...input.reservations.map((row) => async () => {
      await client.query(
        "insert into enterprise_actor_reservations " +
        "(id, backend_username, actor_state, local_user_id, quarantined, source_snapshot_digest, source_observed_at) " +
        "values ($1,$2,$3,$4,$5,$6,$7) on conflict (backend_username) do update set " +
        "actor_state = excluded.actor_state, local_user_id = excluded.local_user_id, quarantined = excluded.quarantined, " +
        "source_snapshot_digest = excluded.source_snapshot_digest, source_observed_at = excluded.source_observed_at, updated_at = now() " +
        "where (enterprise_actor_reservations.actor_state, enterprise_actor_reservations.local_user_id, " +
        "enterprise_actor_reservations.quarantined, enterprise_actor_reservations.source_snapshot_digest, enterprise_actor_reservations.source_observed_at) " +
        "is distinct from (excluded.actor_state, excluded.local_user_id, excluded.quarantined, excluded.source_snapshot_digest, excluded.source_observed_at)",
        [randomUUID(), row.actor, row.state, row.localUserId, row.quarantined, row.sourceDigest, row.observedAt]);
    }),
  ];
  for (let start = 0; start < actions.length; start += 100) {
    const batch = actions.slice(start, start + 100);
    for (const action of batch) await action();
    await client.query("insert into enterprise_batch_checkpoints (id, operation_id, manifest_digest, batch_number, processed, completed_at) " +
      "values ($1,$2,$3,$4,$5,now())",
    [randomUUID(), inventory.operationId, inventory.sourceDigest, start / 100, start + batch.length]);
  }
  await client.query("insert into enterprise_actor_inventory " +
    "(scope, operation_id, source_digest, subjects_digest, ownership_digest, observed_at, upstream_actors) values ($1,$2,$3,$4,$5,$6,$7::jsonb) " +
    "on conflict (scope) do update set operation_id = excluded.operation_id, source_digest = excluded.source_digest, " +
    "subjects_digest = excluded.subjects_digest, ownership_digest = excluded.ownership_digest, " +
    "observed_at = excluded.observed_at, upstream_actors = excluded.upstream_actors",
  [inventory.scope, inventory.operationId, inventory.sourceDigest, inventory.subjectsDigest,
    inventory.ownershipDigest, inventory.observedAt, JSON.stringify(inventory.upstreamActors)]);
}
