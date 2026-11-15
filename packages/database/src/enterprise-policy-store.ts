// megaui-only (FS-79): persistent maintenance policy updates have no upstream counterpart.
/**
 * FS-79：企业策略的 maintenance 转换。
 *
 * 调用方已在同一事务中通过 operation 账本锁住 policy 行。本模块仍只接受
 * 该事务的 client，避免创建脱离审批/epoch CAS 的第二条写路径。
 */
import type { PoolClient } from "pg";

export interface MaintenanceTransition {
  /** The persisted epoch after the transition. */
  policyEpoch: number;
  /** True only when this call changed a non-maintenance policy to maintenance. */
  changed: boolean;
}

export interface EnterpriseActivationTransition {
  /** The persisted epoch after the transition. */
  policyEpoch: number;
  /** True when the policy moved from maintenance to enterprise. */
  changed: boolean;
  /** Sessions invalidated by the activation transaction. */
  sessionsRevoked: number;
}

/**
 * Enters maintenance without clearing the existing activation marker.
 *
 * A repeated maintenance operation intentionally does not touch the policy
 * row: the ledger still records the approved operation, while the epoch and
 * activation timestamp remain stable.
 */
export async function enterEnterpriseMaintenance(
  client: PoolClient,
  scope: string,
): Promise<MaintenanceTransition> {
  const transitioned = await client.query<{ auth_epoch: number }>(
    `update "enterprise_policy"
        set activation_state = 'maintenance',
            auth_epoch = auth_epoch + 1,
            updated_at = now()
      where scope = $1
        and activation_state <> 'maintenance'
      returning auth_epoch`,
    [scope],
  );
  const transitionedEpoch = transitioned.rows[0]?.auth_epoch;
  if (transitionedEpoch !== undefined) {
    if (!Number.isSafeInteger(transitionedEpoch) || transitionedEpoch < 0) {
      throw new Error("[@megaui/database] maintenance transition returned an invalid policy epoch.");
    }
    return { policyEpoch: transitionedEpoch, changed: true };
  }

  const existing = await client.query<{ auth_epoch: number; activation_state: string }>(
    `select auth_epoch, activation_state
       from "enterprise_policy"
      where scope = $1`,
    [scope],
  );
  const row = existing.rows[0];
  if (!row || row.activation_state !== "maintenance" ||
    !Number.isSafeInteger(row.auth_epoch) || row.auth_epoch < 0) {
    throw new Error("[@megaui/database] maintenance transition lost its policy row.");
  }
  return { policyEpoch: row.auth_epoch, changed: false };
}

/**
 * Completes a sticky activation. The caller has already passed the approval,
 * scope and epoch-CAS guards; this port owns the final state transition and
 * invalidates every pre-activation Better Auth session in the same transaction.
 */
export async function activateEnterprise(
  client: PoolClient,
  scope: string,
  now = new Date(),
): Promise<EnterpriseActivationTransition> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("[@megaui/database] activation requires a valid clock.");
  }
  const policy = await client.query<{
    auth_epoch: number;
    activation_state: string;
    activated_at: Date | null;
  }>(
    `select auth_epoch, activation_state, activated_at
       from "enterprise_policy"
      where scope = $1
      for update`,
    [scope],
  );
  const current = policy.rows[0];
  if (!current || !Number.isSafeInteger(current.auth_epoch) || current.auth_epoch < 0 ||
    current.activation_state !== "maintenance") {
    throw new Error("ACTIVATION_PHASE_REJECTED");
  }
  const nextEpoch = current.auth_epoch + 1;
  if (!Number.isSafeInteger(nextEpoch)) {
    throw new Error("ACTIVATION_EPOCH_OVERFLOW");
  }
  const transitioned = await client.query<{ auth_epoch: number }>(
    `update "enterprise_policy"
        set activation_state = 'enterprise',
            auth_epoch = $2,
            activated_at = coalesce(activated_at, $3),
            updated_at = $3
      where scope = $1
        and activation_state = 'maintenance'
        and auth_epoch = $4
      returning auth_epoch`,
    [scope, nextEpoch, now, current.auth_epoch],
  );
  const epoch = transitioned.rows[0]?.auth_epoch;
  if (epoch !== nextEpoch) {
    throw new Error("ACTIVATION_PHASE_REJECTED");
  }
  const sessions = await client.query(`delete from "session"`);
  return {
    policyEpoch: epoch,
    changed: true,
    sessionsRevoked: sessions.rowCount ?? 0,
  };
}
