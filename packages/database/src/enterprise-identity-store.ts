// megaui-only (FS-05): creation participates in the caller's approved transaction.
import type { PoolClient } from "pg";

/** FS-06: the migration ledger holds source locks and has validated existing rows. */
export async function bindHistoricalIdentity(client: PoolClient, input: {
  localUserId: string; identityId: string; tenantKey: string; appId: string; openId: string;
  loginName: string; backendUsername: string;
}): Promise<void> {
  await client.query("insert into enterprise_identity(id,local_user_id,tenant_key,app_id,open_id,status,identity_version) " +
    "select $1,$2,$3,$4,$5,'active',1 where not exists " +
    "(select 1 from enterprise_identity where local_user_id=$2)",
  [input.identityId, input.localUserId, input.tenantKey, input.appId, input.openId]);
  await client.query("insert into enterprise_profile(user_id,tenant_key,login_name,backend_username,display_name,notification_email) " +
    'select id,$2,$3,$4,name,null from "user" where id=$1 and not exists ' +
    "(select 1 from enterprise_profile where user_id=$1)",
  [input.localUserId, input.tenantKey, input.loginName, input.backendUsername]);
}

export async function createProvisionedIdentity(client: PoolClient, input: {
  localUserId: string; identityId: string; tenantKey: string; appId: string; openId: string;
  loginName: string; backendUsername: string; displayName: string;
  compatibilityEmail: string; notificationEmail: string | null;
}): Promise<void> {
  await client.query(
    'insert into "user" (id, name, email, email_verified, role) values ($1,$2,$3,false,\'user\')',
    [input.localUserId, input.displayName, input.compatibilityEmail],
  );
  await client.query(
    'insert into enterprise_identity (id, local_user_id, tenant_key, app_id, open_id, status, identity_version) ' +
    'values ($1,$2,$3,$4,$5,\'active\',1)',
    [input.identityId, input.localUserId, input.tenantKey, input.appId, input.openId],
  );
  await client.query(
    'insert into enterprise_profile (user_id, tenant_key, login_name, backend_username, display_name, notification_email) ' +
    'values ($1,$2,$3,$4,$5,$6)',
    [input.localUserId, input.tenantKey, input.loginName, input.backendUsername, input.displayName, input.notificationEmail],
  );
}

export async function recordProvisionCheckpoint(client: PoolClient, input: {
  operationId: string; manifestDigest: string; processed: number;
}): Promise<void> {
  await client.query(
    'insert into enterprise_batch_checkpoints (id, operation_id, manifest_digest, batch_number, processed, completed_at) ' +
    'values ($1,$1,$2,0,$3,now())',
    [input.operationId, input.manifestDigest, input.processed],
  );
}
