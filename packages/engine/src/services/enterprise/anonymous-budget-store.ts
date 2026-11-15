// megaui-only (FS-74): one transaction owns anonymous charges and pending capacity.
import { assertEnterpriseScope, type EnterpriseScopeExpectation } from "@megaui/database";
import type { AnonymousBudgetClient, AnonymousPendingContext } from "./anonymous-budget-types";

export function anonymousBudgetLockKey(scope: string, role: string): string {
  return JSON.stringify(["megaui:anonymous-budget:v1", scope, role, "login"]);
}

/** The global budget lock precedes flow locks and the authoritative database clock. */
export async function lockAnonymousBudget(client: AnonymousBudgetClient, expectation: EnterpriseScopeExpectation): Promise<number> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [anonymousBudgetLockKey(expectation.instanceId, expectation.environment)]);
  const result = await client.query<{
    scope: string; owner_fingerprint: string; environment: string; activation_state: string; auth_epoch: number;
    role_name: string; can_ddl: boolean; can_create_db: boolean;
  }>(`select scope,owner_fingerprint,environment,activation_state,auth_epoch,current_user as role_name,
    has_schema_privilege(current_user,'public','CREATE') as can_ddl,
    has_database_privilege(current_user,current_database(),'CREATE') as can_create_db
    from enterprise_policy where scope=$1 for share`, [expectation.instanceId]);
  const row = result.rows[0];
  if (!row) throw new Error("ANONYMOUS_BUDGET_UNAVAILABLE");
  assertEnterpriseScope({ expectation, marker: { scope: row.scope, ownerFingerprint: row.owner_fingerprint,
    environment: row.environment, activationState: row.activation_state, authEpoch: row.auth_epoch },
  privileges: { roleName: row.role_name, canDdl: row.can_ddl, canCreateDatabase: row.can_create_db } });
  const clock = await client.query<{ now_ms: number }>("select floor(extract(epoch from clock_timestamp())*1000)::double precision as now_ms");
  const nowMs = clock.rows[0]?.now_ms;
  if (!Number.isSafeInteger(nowMs) || nowMs! < 0 || nowMs! > 8_639_999_999_400_000) {
    throw new Error("ANONYMOUS_BUDGET_UNAVAILABLE");
  }
  return nowMs!;
}

export async function expireAnonymousFlow(context: AnonymousPendingContext): Promise<void> {
  const { client, scope, deploymentRole, flowHash, nowMs } = context;
  await client.query(`select id from enterprise_pairings where scope=$1 and deployment_role=$2
    and purpose='login' and flow_hash=$3 and state='pending' for update`, [scope, deploymentRole, flowHash]);
  await client.query(`update enterprise_pairings set state='expired' where scope=$1 and deployment_role=$2
    and purpose='login' and flow_hash=$3 and state='pending' and expires_at <= $4`,
  [scope, deploymentRole, flowHash, new Date(nowMs)]);
}

/** The same implementation is used by production and explicit-time real-PG tests. */
export async function chargeAnonymousIp(context: AnonymousPendingContext, subjects: readonly [string, string]): Promise<boolean> {
  const { client, scope, deploymentRole, nowMs } = context;
  const at = new Date(nowMs);
  const result = await client.query<{ exhausted: boolean }>(`select coalesce(sum(used),0) >= 30 as exhausted
    from enterprise_login_budgets where scope=$1 and deployment_role=$2 and budget_kind='anonymous-ip'
    and subject_hash=any($3::text[]) and window_started_at > $4::timestamptz-interval '600 seconds'
    and window_started_at <= $4::timestamptz`, [scope, deploymentRole, [...subjects], at]);
  if (result.rows[0]?.exhausted !== false) return false;
  await client.query(`insert into enterprise_login_budgets as budget
    (scope,deployment_role,budget_kind,subject_hash,window_started_at,used,expires_at)
    values ($1,$2,'anonymous-ip',$3,$4,1,$5)
    on conflict (scope,deployment_role,budget_kind,subject_hash,window_started_at)
    do update set used=budget.used+1`, [scope, deploymentRole, subjects[0], at, new Date(nowMs+600_000)]);
  return true;
}

export async function anonymousCapacity(context: AnonymousPendingContext): Promise<"capacity" | "flow" | null> {
  const { client, scope, deploymentRole, flowHash } = context;
  const result = await client.query<{ full: boolean; occupied: boolean }>(`select count(*) >= 10000 as full,
    coalesce(bool_or(flow_hash=$3),false) as occupied from enterprise_pairings
    where scope=$1 and deployment_role=$2 and state='pending'`, [scope, deploymentRole, flowHash]);
  const row = result.rows[0];
  if (!row || typeof row.full !== "boolean" || typeof row.occupied !== "boolean") throw new Error("ANONYMOUS_BUDGET_UNAVAILABLE");
  return row.full ? "capacity" : row.occupied ? "flow" : null;
}

export async function verifyAnonymousPending(context: AnonymousPendingContext, id: string): Promise<void> {
  const { client, scope, deploymentRole, flowHash, nowMs } = context;
  if (typeof id !== "string" || id.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new Error("ANONYMOUS_BUDGET_UNAVAILABLE");
  }
  const result = await client.query<{ valid: boolean }>(`select
    (scope=$2 and deployment_role=$3 and flow_hash=$4 and purpose='login' and state='pending'
      and created_at=$5::timestamptz and expires_at=$5::timestamptz+interval '120 seconds'
      and retain_until=expires_at) as valid from enterprise_pairings where id=$1`,
  [id, scope, deploymentRole, flowHash, new Date(nowMs)]);
  if (result.rows.length !== 1 || result.rows[0]?.valid !== true) throw new Error("ANONYMOUS_BUDGET_UNAVAILABLE");
  const capacity = await client.query<{ allowed: boolean }>(`select count(*) <= 10000 as allowed
    from enterprise_pairings where scope=$1 and deployment_role=$2 and state='pending'`, [scope, deploymentRole]);
  if (capacity.rows[0]?.allowed !== true) throw new Error("ANONYMOUS_BUDGET_UNAVAILABLE");
}
