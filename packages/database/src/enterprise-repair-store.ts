// megaui-only (FS-38): bounded writes in the caller's approved transaction.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export class EnterpriseRepairStoreRejected extends Error {
  constructor() { super("REPAIR_SOURCE_REJECTED"); this.name = "EnterpriseRepairStoreRejected"; }
}

/** FS-81 already owns the policy lock. Provider I/O must finish before this barrier. */
export async function lockEnterpriseRepairSources(client: PoolClient, scope: string, requireInventory: boolean): Promise<void> {
  const isolation = await client.query<{ isolation: string }>("select current_setting('transaction_isolation') as isolation");
  if (isolation.rows[0]?.isolation !== "read committed") throw new EnterpriseRepairStoreRejected();
  await client.query("select set_config(name,least(coalesce(nullif(setting::int,0),5000),5000)::text,true) " +
    "from pg_settings where name in ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout')");
  const inventory = await client.query("select scope from enterprise_actor_inventory where scope=$1 for update", [scope]);
  if (requireInventory && inventory.rowCount !== 1) throw new EnterpriseRepairStoreRejected();
  await client.query('lock table "user",enterprise_profile,enterprise_quarantine,enterprise_actor_reservations,enterprise_identity in share mode');
}

export async function readCurrentQuarantines(client: PoolClient, ids: readonly string[]): Promise<{
  user_id: string; state: string; operation_id: string | null;
}[]> {
  return (await client.query("select user_id,state,operation_id from enterprise_quarantine where user_id=any($1::text[])", [ids])).rows;
}

/** Lock the current generation and its exact snapshot through the outer commit. */
export async function lockRepairDirectorySnapshot(client: PoolClient, scopeHash: string): Promise<{
  generation: number; complete: boolean; observedAt: Date;
} | undefined> {
  const result = await client.query<{ generation: number; complete: boolean; observedAt: Date }>(
    'select w.generation,s.complete,s.observed_at as "observedAt" from enterprise_directory_watermarks w ' +
    "join enterprise_directory_snapshots s on s.scope_hash=w.scope_hash and s.generation=w.generation " +
    "where w.scope_hash=$1 for share of w,s", [scopeHash]);
  return result.rowCount === 1 ? result.rows[0] : undefined;
}

export async function quarantineEnterpriseUser(client: PoolClient, input: {
  localUserId: string; reason: string; operationId: string; manifestDigest: string;
}): Promise<void> {
  const quarantine = await client.query("insert into enterprise_quarantine(id,user_id,reason,state,operation_id,manifest_digest,released_at) " +
    "values ($1,$2,$3,'quarantined',$4,$5,null) on conflict(user_id) do update set reason=excluded.reason," +
    "state='quarantined',operation_id=excluded.operation_id,manifest_digest=excluded.manifest_digest,released_at=null,updated_at=now()",
  [randomUUID(), input.localUserId, input.reason, input.operationId, input.manifestDigest]);
  if (quarantine.rowCount !== 1) throw new EnterpriseRepairStoreRejected();
  await client.query("update enterprise_actor_reservations set quarantined=true,updated_at=now() " +
    "where local_user_id=$1 and actor_state='reserved' and quarantined=false", [input.localUserId]);
}

/** Validated sources remain protected by the fixed table barrier and row locks. */
export async function repairEnterpriseUser(client: PoolClient, input: {
  localUserId: string; identityId: string; identityExists: boolean; expectedIdentityVersion: number;
  tenantKey: string; appId: string; openId: string; loginName: string; backendUsername: string;
  profileExists: boolean; displayName: string; quarantineOperationId: string;
}): Promise<void> {
  const identity = input.identityExists ? await client.query(
    "update enterprise_identity set union_id=case when open_id=$4 then union_id else null end,open_id=$4," +
    "status='active',identity_version=identity_version+1,updated_at=now() " +
    "where id=$1 and local_user_id=$2 and identity_version=$3 and tenant_key=$5 and app_id=$6",
    [input.identityId, input.localUserId, input.expectedIdentityVersion, input.openId, input.tenantKey, input.appId]) :
    await client.query("insert into enterprise_identity(id,local_user_id,tenant_key,app_id,open_id,status,identity_version) " +
      "values ($1,$2,$3,$4,$5,'active',1)", [input.identityId, input.localUserId, input.tenantKey, input.appId, input.openId]);
  if (identity.rowCount !== 1) throw new EnterpriseRepairStoreRejected();
  const profile = input.profileExists ? await client.query("update enterprise_profile set login_name=$2,updated_at=now() " +
    "where user_id=$1 and tenant_key=$3 and backend_username=$4", [input.localUserId, input.loginName, input.tenantKey, input.backendUsername]) :
    await client.query("insert into enterprise_profile(user_id,tenant_key,login_name,backend_username,display_name,notification_email) " +
      "values ($1,$2,$3,$4,$5,null)", [input.localUserId, input.tenantKey, input.loginName, input.backendUsername, input.displayName]);
  if (profile.rowCount !== 1) throw new EnterpriseRepairStoreRejected();
  await client.query("delete from enterprise_directory_identity_watermarks where identity_id=$1", [input.identityId]);
  const quarantine = await client.query("update enterprise_quarantine set state='released',released_at=now(),updated_at=now() " +
    "where user_id=$1 and state='quarantined' and operation_id=$2", [input.localUserId, input.quarantineOperationId]);
  const actor = await client.query("update enterprise_actor_reservations set quarantined=false,updated_at=now() " +
    "where local_user_id=$1 and backend_username=$2 and actor_state='reserved'", [input.localUserId, input.backendUsername]);
  if (quarantine.rowCount !== 1 || actor.rowCount !== 1) throw new EnterpriseRepairStoreRejected();
}
