// megaui-only (FS-18): one transaction for identity offboarding and revoke outbox.
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export interface EnterpriseOffboardingInput {
  readonly localUserId: string;
  readonly scope: string;
  readonly identityId?: string;
  readonly reason: string;
  readonly expectedIdentityVersion?: number;
  readonly now?: Date;
}

export interface EnterpriseOffboardingResult {
  readonly localUserId: string;
  readonly identityId: string;
  readonly identityVersion: number;
  readonly authEpoch: number;
  readonly revocationId: string;
  readonly sessionsRevoked: number;
  readonly challengesRevoked: number;
  readonly grantsRevoked: number;
  readonly pairingFlowsExpired: number;
  readonly changed: boolean;
}

export interface EnterpriseOffboardingStore {
  readonly offboard: (input: EnterpriseOffboardingInput) => Promise<EnterpriseOffboardingResult>;
}

class EnterpriseOffboardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnterpriseOffboardingError";
  }
}

function safeText(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /\S/u.test(value) &&
    ![...value].some((character) => (character.codePointAt(0) ?? 0) <= 31 || character === "\u007f");
}

function validateInput(input: EnterpriseOffboardingInput): void {
  if (!input || typeof input !== "object" || !safeText(input.localUserId) || !safeText(input.scope) ||
    !safeText(input.reason, 128) || (input.identityId !== undefined && !safeText(input.identityId)) ||
    (input.expectedIdentityVersion !== undefined &&
      (!Number.isSafeInteger(input.expectedIdentityVersion) || input.expectedIdentityVersion < 1)) ||
    (input.now !== undefined && (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())))) {
    throw new EnterpriseOffboardingError("INVALID_ENTERPRISE_OFFBOARDING_INPUT");
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("rollback");
  } catch {
    // Preserve the original failure while still attempting to release the transaction.
  }
}

function resultFromRow(row: {
  local_user_id: string;
  identity_id: string;
  identity_version: number;
  auth_epoch: number;
  revocation_id: string;
  sessions_revoked: number;
  challenges_revoked: number;
  grants_revoked: number;
  pairing_flows_expired: number;
  changed: boolean;
}): EnterpriseOffboardingResult {
  return {
    localUserId: row.local_user_id,
    identityId: row.identity_id,
    identityVersion: row.identity_version,
    authEpoch: row.auth_epoch,
    revocationId: row.revocation_id,
    sessionsRevoked: row.sessions_revoked,
    challengesRevoked: row.challenges_revoked,
    grantsRevoked: row.grants_revoked,
    pairingFlowsExpired: row.pairing_flows_expired,
    changed: row.changed,
  };
}

/** Creates the transaction-owned offboarding store over a caller-owned pool. */
export function createEnterpriseOffboardingStore(pool: Pool): EnterpriseOffboardingStore {
  if (!pool || typeof pool.connect !== "function") {
    throw new EnterpriseOffboardingError("INVALID_ENTERPRISE_OFFBOARDING_STORE_CONFIG");
  }

  return Object.freeze({
    async offboard(input: EnterpriseOffboardingInput): Promise<EnterpriseOffboardingResult> {
      validateInput(input);
      const client = await pool.connect();
      let committed = false;
      try {
        await client.query("begin isolation level read committed");
        await client.query("set local lock_timeout='5s'; set local statement_timeout='5s'; set local idle_in_transaction_session_timeout='5s'");

        const policy = await client.query<{ auth_epoch: number }>(
          `select auth_epoch from "enterprise_policy" where scope = $1 for update`,
          [input.scope],
        );
        const policyRow = policy.rows[0];
        if (policy.rowCount !== 1 || !policyRow || !Number.isSafeInteger(policyRow.auth_epoch) || policyRow.auth_epoch < 0) {
          throw new EnterpriseOffboardingError("ENTERPRISE_POLICY_UNAVAILABLE");
        }

        const identity = await client.query<{
          id: string;
          local_user_id: string;
          status: string;
          identity_version: number;
        }>(
          `select id, local_user_id, status, identity_version
             from "enterprise_identity"
            where local_user_id = $1
              and ($2::text is null or id = $2)
            for update`,
          [input.localUserId, input.identityId ?? null],
        );
        const identityRow = identity.rows[0];
        if (identity.rowCount !== 1 || !identityRow || identityRow.local_user_id !== input.localUserId ||
          !Number.isSafeInteger(identityRow.identity_version) || identityRow.identity_version < 1 ||
          (input.expectedIdentityVersion !== undefined && identityRow.identity_version !== input.expectedIdentityVersion)) {
          throw new EnterpriseOffboardingError("ENTERPRISE_IDENTITY_CONFLICT");
        }

        const existing = await client.query<{
          id: string;
          auth_epoch: number;
          reason: string;
        }>(
          `select id, auth_epoch, reason
             from enterprise_revocations
            where user_id = $1
            order by auth_epoch desc, created_at desc, id desc
            limit 1
            for update`,
          [input.localUserId],
        );
        const alreadyOffboarded = identityRow.status === "resigned" && existing.rows[0];
        const now = input.now ?? new Date();
        let authEpoch = policyRow.auth_epoch;
        let identityVersion = identityRow.identity_version;
        let changed = false;

        if (!alreadyOffboarded) {
          const identityUpdate = await client.query<{ identity_version: number }>(
            `update enterprise_identity
                set status = 'resigned', identity_version = identity_version + 1, updated_at = $3
              where id = $1 and local_user_id = $2
            returning identity_version`,
            [identityRow.id, input.localUserId, now],
          );
          const updatedIdentity = identityUpdate.rows[0];
          if (identityUpdate.rowCount !== 1 || !updatedIdentity) {
            throw new EnterpriseOffboardingError("ENTERPRISE_IDENTITY_CONFLICT");
          }
          identityVersion = updatedIdentity.identity_version;

          const policyUpdate = await client.query<{ auth_epoch: number }>(
            `update "enterprise_policy"
                set auth_epoch = auth_epoch + 1, updated_at = $2
              where scope = $1
            returning auth_epoch`,
            [input.scope, now],
          );
          const updatedPolicy = policyUpdate.rows[0];
          if (policyUpdate.rowCount !== 1 || !updatedPolicy || !Number.isSafeInteger(updatedPolicy.auth_epoch)) {
            throw new EnterpriseOffboardingError("ENTERPRISE_POLICY_CONFLICT");
          }
          authEpoch = updatedPolicy.auth_epoch;
          changed = true;
        } else {
          authEpoch = existing.rows[0]?.auth_epoch ?? policyRow.auth_epoch;
        }

        const sessions = await client.query(
          `delete from "session" where user_id = $1`,
          [input.localUserId],
        );
        const grants = await client.query(
          `delete from enterprise_login_grants where local_user_id = $1`,
          [input.localUserId],
        );
        const challenges = await client.query(
          `update enterprise_challenges
              set state = case when state in ('active', 'consumed') then 'revoked' else state end,
                  code_hmac = null, hmac_key_id = null,
                  secret_cleared_at = greatest(coalesce(secret_cleared_at, $2), secret_expires_at)
            where local_user_id = $1 or identity_id = $3`,
          [input.localUserId, now, identityRow.id],
        );
        const pairings = await client.query(
          `update enterprise_pairings
              set state = 'expired'
            where intended_identity_id = $1 and state <> 'expired'`,
          [identityRow.id],
        );

        const revocationId = existing.rows[0]?.id ?? randomUUID();
        const revocation = await client.query<{ id: string }>(
          `insert into enterprise_revocations
             (id, user_id, auth_epoch, reason, payload, state, attempts, created_at, updated_at)
           values ($1, $2, $3, $4, '{}'::jsonb, 'pending', 0, $5, $5)
           on conflict (user_id, auth_epoch) do nothing
           returning id`,
          [revocationId, input.localUserId, authEpoch, input.reason, now],
        );
        const storedRevocationId = revocation.rows[0]?.id ?? revocationId;

        await client.query("commit");
        committed = true;
        return resultFromRow({
          local_user_id: input.localUserId,
          identity_id: identityRow.id,
          identity_version: identityVersion,
          auth_epoch: authEpoch,
          revocation_id: storedRevocationId,
          sessions_revoked: sessions.rowCount ?? 0,
          challenges_revoked: challenges.rowCount ?? 0,
          grants_revoked: grants.rowCount ?? 0,
          pairing_flows_expired: pairings.rowCount ?? 0,
          changed,
        });
      } catch (error) {
        if (!committed) await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

export { EnterpriseOffboardingError };
