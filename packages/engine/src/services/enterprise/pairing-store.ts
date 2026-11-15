// megaui-only (FS-11): pairing persistence stays inside the caller's budget transaction.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolveEffectiveAuthMode, type AuthMode, type EffectiveAuthMode } from "@megaui/core";
import { assertEnterpriseScope, type EnterpriseScopeExpectation } from "@megaui/database";
import type { AnonymousBudgetClient, AnonymousPendingContext } from "./anonymous-budget-types";

const unavailable = () => new Error("ENTERPRISE_PAIRING_UNAVAILABLE");

/** Recheck the fixed target and persistent mode on the connection doing the work. */
export async function readPairingTarget(
  client: AnonymousBudgetClient, expectation: EnterpriseScopeExpectation, configuredMode: AuthMode,
): Promise<EffectiveAuthMode> {
  const result = await client.query<{
    scope: string; owner_fingerprint: string; environment: string; activation_state: string; auth_epoch: number;
    role_name: string; can_ddl: boolean; can_create_db: boolean;
  }>(`select scope,owner_fingerprint,environment,activation_state,auth_epoch,current_user as role_name,
    has_schema_privilege(current_user,'public','CREATE') as can_ddl,
    has_database_privilege(current_user,current_database(),'CREATE') as can_create_db
    from enterprise_policy where scope=$1 for share`, [expectation.instanceId]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || !Number.isSafeInteger(row.auth_epoch) || row.auth_epoch < 0) throw unavailable();
  assertEnterpriseScope({ expectation,
    marker: { scope: row.scope, ownerFingerprint: row.owner_fingerprint, environment: row.environment,
      activationState: row.activation_state, authEpoch: row.auth_epoch },
    privileges: { roleName: row.role_name, canDdl: row.can_ddl, canCreateDatabase: row.can_create_db } });
  const mode = resolveEffectiveAuthMode(configuredMode, row.activation_state);
  if (mode === "reject") throw unavailable();
  return mode;
}

/** No provider, session, challenge or sender budget is touched by anonymous creation. */
export async function insertPendingPairing(
  context: Readonly<AnonymousPendingContext>,
  authority: Readonly<{ expectation: EnterpriseScopeExpectation; tenantKey: string; appId: string }>,
  loginName: string,
): Promise<{ pairingId: string; pairingToken: string }> {
  const { client, scope, deploymentRole, flowHash, nowMs } = context;
  if (scope !== authority.expectation.instanceId || deploymentRole !== authority.expectation.environment
    || await readPairingTarget(client, authority.expectation, "enterprise") !== "enterprise") throw unavailable();
  const identity = await client.query<{ id: string }>(`select identity.id from enterprise_profile as profile
    join enterprise_identity as identity on identity.local_user_id=profile.user_id and identity.tenant_key=profile.tenant_key
    where profile.tenant_key=$1 and identity.app_id=$2 and profile.login_name=$3
    for share of profile,identity`, [authority.tenantKey, authority.appId, loginName]);
  if (identity.rows.length > 1) throw unavailable();
  const generations = await client.query<{ generation: number }>(`select greatest(
    coalesce((select max(generation) from enterprise_pairings
      where scope=$1 and deployment_role=$2 and purpose='login' and flow_hash=$3),0),
    coalesce((select max(generation) from enterprise_challenges
      where scope=$1 and deployment_role=$2 and purpose='login' and flow_hash=$3),0))::double precision as generation`,
  [scope, deploymentRole, flowHash]);
  const previous = generations.rows[0]?.generation;
  if (!Number.isSafeInteger(previous) || previous! < 0 || previous! >= 2_147_483_647) throw unavailable();
  const pairingId = randomUUID();
  const pairingToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(pairingToken, "utf8").digest("hex");
  await client.query(`insert into enterprise_pairings
    (id,scope,deployment_role,tenant_key,app_id,flow_hash,generation,token_hash,intended_identity_id,created_at,expires_at,retain_until)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
  [pairingId, scope, deploymentRole, authority.tenantKey, authority.appId, flowHash, previous! + 1,
    tokenHash, identity.rows[0]?.id ?? null, new Date(nowMs), new Date(nowMs + 120_000)]);
  return { pairingId, pairingToken };
}
