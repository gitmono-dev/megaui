// megaui-only (FS-36): the PostgreSQL transaction behind OTP consumption.
//
// The auth package supplies the cryptographic verifier and the current
// eligibility port.  This package owns row locking, the cross-resend failure
// budget, the one-time grant write and bounded HMAC cleanup so those writes
// cannot be split across two transactions.
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const ROLE = new Set(["development", "test", "production", "canary"]);
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 600_000;
const RECOVERY_WINDOW_MS = 90_000;

export interface EnterpriseGrantBinding {
  readonly scope: string;
  readonly deploymentRole: "development" | "test" | "production" | "canary";
  readonly tenantKey: string;
  readonly appId: string;
  readonly challengeId: string;
  readonly localUserId: string;
  readonly identityId: string;
  readonly identityVersion: number;
  readonly purpose: "login";
  readonly flowHash: string;
  readonly generation: number;
  readonly expiresAtMs: number;
}

export type EnterpriseGrantCodeVerifier = (
  code: unknown,
  binding: EnterpriseGrantBinding,
  record: unknown,
) => boolean;

export interface EnterpriseGrantQualificationInput {
  readonly localUserId: string;
  readonly identityId: string;
  readonly identityVersion: number;
  readonly authEpoch: number;
  readonly scope: string;
  readonly deploymentRole: "development" | "test" | "production" | "canary";
}

export type EnterpriseGrantQualification = (
  input: EnterpriseGrantQualificationInput,
) => Promise<boolean>;

export interface EnterpriseGrantConsumeInput {
  readonly challengeId: string;
  readonly scope: string;
  readonly deploymentRole: "development" | "test" | "production" | "canary";
  readonly tenantKey: string;
  readonly appId: string;
  readonly flowHash: string;
  readonly code: string;
  readonly now?: Date;
  readonly verifyCode: EnterpriseGrantCodeVerifier;
  readonly qualify: EnterpriseGrantQualification;
}

export type EnterpriseGrantConsumeResult =
  | {
      readonly kind: "accepted";
      readonly grantId: string;
      readonly challengeId: string;
      readonly localUserId: string;
      readonly identityId: string;
      readonly identityVersion: number;
      readonly authEpoch: number;
      readonly flowHash: string;
      readonly recoverUntil: Date;
    }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

export interface EnterpriseGrantStore {
  readonly consume: (input: EnterpriseGrantConsumeInput) => Promise<EnterpriseGrantConsumeResult>;
  readonly cleanupExpiredSecrets: (input?: { readonly now?: Date; readonly limit?: number }) => Promise<number>;
}

interface ChallengeRow {
  id: string;
  scope: string;
  deployment_role: string;
  local_user_id: string;
  identity_id: string;
  identity_version: number;
  flow_hash: string;
  generation: number;
  purpose: string;
  code_hmac: string | null;
  hmac_key_id: string | null;
  state: string;
  failed_attempts: number;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  recover_until: Date | null;
  secret_expires_at: Date;
}

interface IdentityRow {
  identity_id: string;
  local_user_id: string;
  tenant_key: string;
  app_id: string;
  identity_status: string;
  identity_version: number;
}

interface GrantRow {
  id: string;
  challenge_id: string;
  scope: string;
  deployment_role: string;
  local_user_id: string;
  identity_id: string;
  identity_version: number;
  auth_epoch: number;
  flow_hash: string;
  generation: number;
  purpose: string;
  recover_until: Date;
}

interface PolicyRow {
  scope: string;
  deployment_role: string;
  auth_epoch: number;
  activation_state: string;
}

interface BudgetRow {
  used: number;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && /\S/u.test(value)
    && ![...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function failureSubject(scope: string, deploymentRole: string, identityId: string, flowHash: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["megaui:enterprise-otp:verify-failure:v1", scope, deploymentRole, identityId, flowHash]), "utf8")
    .digest("hex");
}

function resultFromGrant(grant: GrantRow): EnterpriseGrantConsumeResult {
  return {
    kind: "accepted",
    grantId: grant.id,
    challengeId: grant.challenge_id,
    localUserId: grant.local_user_id,
    identityId: grant.identity_id,
    identityVersion: grant.identity_version,
    authEpoch: grant.auth_epoch,
    flowHash: grant.flow_hash,
    recoverUntil: grant.recover_until,
  };
}

function validInput(input: EnterpriseGrantConsumeInput): boolean {
  return !!input && typeof input === "object"
    && UUID.test(input.challengeId)
    && safeText(input.scope)
    && ROLE.has(input.deploymentRole)
    && safeText(input.tenantKey)
    && safeText(input.appId)
    && safeHash(input.flowHash)
    && typeof input.code === "string"
    && typeof input.verifyCode === "function"
    && typeof input.qualify === "function"
    && (input.now === undefined || validDate(input.now));
}

function validChallenge(row: ChallengeRow, input: EnterpriseGrantConsumeInput): boolean {
  return UUID.test(row.id)
    && row.id === input.challengeId
    && row.scope === input.scope
    && row.deployment_role === input.deploymentRole
    && row.local_user_id.length > 0
    && row.identity_id.length > 0
    && Number.isSafeInteger(row.identity_version) && row.identity_version > 0
    && safeHash(row.flow_hash)
    && row.flow_hash === input.flowHash
    && Number.isSafeInteger(row.generation) && row.generation > 0
    && row.purpose === "login"
    && Number.isSafeInteger(row.failed_attempts) && row.failed_attempts >= 0 && row.failed_attempts <= MAX_FAILURES
    && validDate(row.created_at) && validDate(row.expires_at)
    && (row.consumed_at === null || validDate(row.consumed_at))
    && (row.recover_until === null || validDate(row.recover_until))
    && validDate(row.secret_expires_at);
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query("rollback"); } catch { /* connection release below is the final guard */ }
}

export function createEnterpriseGrantStore(pool: Pool): EnterpriseGrantStore {
  if (!pool || typeof pool.connect !== "function") throw new Error("INVALID_ENTERPRISE_GRANT_STORE_CONFIG");

  return Object.freeze({
    async consume(input: EnterpriseGrantConsumeInput): Promise<EnterpriseGrantConsumeResult> {
      if (!validInput(input)) return { kind: "unavailable" };
      let client: PoolClient | undefined;
      let committed = false;
      try {
        client = await pool.connect();
        await client.query("begin isolation level read committed");
        await client.query("set local lock_timeout='3s'; set local statement_timeout='3s'; set local idle_in_transaction_session_timeout='5s'");
        const now = input.now ?? new Date();
        if (!validDate(now)) { await rollback(client); return { kind: "unavailable" }; }

        // Fixed lock order: identity/user -> challenge -> grant -> policy/budget.
        const identityResult = await client.query<IdentityRow>(
          `select identity.id as identity_id, identity.local_user_id, identity.tenant_key,
                  identity.app_id, identity.status as identity_status,
                  identity.identity_version
             from enterprise_challenges as challenge
             join enterprise_identity as identity on identity.id = challenge.identity_id
            where challenge.id = $1
            for update of identity`,
          [input.challengeId],
        );
        const identity = identityResult.rows[0];
        if (identityResult.rowCount !== 1 || !identity) {
          await rollback(client); return { kind: "invalid" };
        }

        const challengeResult = await client.query<ChallengeRow>(
          `select id,scope,deployment_role,local_user_id,identity_id,identity_version,
                  flow_hash,generation,purpose,code_hmac,hmac_key_id,state,failed_attempts,
                  created_at,expires_at,consumed_at,recover_until,secret_expires_at
             from enterprise_challenges where id=$1 for update`,
          [input.challengeId],
        );
        const challenge = challengeResult.rows[0];
        if (challengeResult.rowCount !== 1 || !challenge || !validChallenge(challenge, input)
          || identity.identity_id !== challenge.identity_id
          || identity.local_user_id !== challenge.local_user_id
          || identity.identity_version !== challenge.identity_version
          || identity.tenant_key !== input.tenantKey
          || identity.app_id !== input.appId) {
          await rollback(client); return { kind: "invalid" };
        }

        const grantResult = await client.query<GrantRow>(
          `select id,challenge_id,scope,deployment_role,local_user_id,identity_id,
                  identity_version,auth_epoch,flow_hash,generation,purpose,recover_until
             from enterprise_login_grants where challenge_id=$1 for update`,
          [input.challengeId],
        );
        if (grantResult.rows.length > 1) {
          await rollback(client); return { kind: "unavailable" };
        }
        const existingGrant = grantResult.rows[0];

        const policyResult = await client.query<PolicyRow>(
          `select scope,deployment_role,auth_epoch,activation_state
             from enterprise_policy where scope=$1 for share`,
          [input.scope],
        );
        const policy = policyResult.rows[0];
        if (policyResult.rowCount !== 1 || !policy
          || policy.scope !== input.scope || policy.deployment_role !== input.deploymentRole
          || !Number.isSafeInteger(policy.auth_epoch) || policy.auth_epoch < 0
          || policy.activation_state !== "enterprise"
          || identity.identity_status !== "active") {
          await rollback(client); return { kind: "invalid" };
        }

        let eligible = false;
        try {
          eligible = await input.qualify({
            localUserId: challenge.local_user_id,
            identityId: challenge.identity_id,
            identityVersion: challenge.identity_version,
            authEpoch: policy.auth_epoch,
            scope: input.scope,
            deploymentRole: input.deploymentRole,
          });
        } catch {
          eligible = false;
        }
        if (!eligible) {
          await rollback(client); return { kind: "invalid" };
        }

        const binding: EnterpriseGrantBinding = {
          scope: input.scope,
          deploymentRole: input.deploymentRole,
          tenantKey: input.tenantKey,
          appId: input.appId,
          challengeId: challenge.id,
          localUserId: challenge.local_user_id,
          identityId: challenge.identity_id,
          identityVersion: challenge.identity_version,
          purpose: "login",
          flowHash: challenge.flow_hash,
          generation: challenge.generation,
          expiresAtMs: challenge.expires_at.getTime(),
        };
        const record = { codeHmac: challenge.code_hmac, hmacKeyId: challenge.hmac_key_id };

        if (challenge.state === "consumed") {
          if (!existingGrant || existingGrant.flow_hash !== input.flowHash
            || existingGrant.scope !== input.scope
            || existingGrant.deployment_role !== input.deploymentRole
            || existingGrant.identity_id !== challenge.identity_id
            || existingGrant.local_user_id !== challenge.local_user_id
            || existingGrant.identity_version !== challenge.identity_version
            || existingGrant.auth_epoch !== policy.auth_epoch
            || !validDate(existingGrant.recover_until)
            || existingGrant.recover_until.getTime() <= now.getTime()
            || !validDate(challenge.recover_until)
            || challenge.recover_until.getTime() <= now.getTime()
            || challenge.recover_until.getTime() !== existingGrant.recover_until.getTime()
            || !(() => {
              try { return input.verifyCode(input.code, binding, record); } catch { return false; }
            })()) {
            await rollback(client); return { kind: "invalid" };
          }
          committed = true;
          await client.query("commit");
          return resultFromGrant(existingGrant);
        }

        if (challenge.state !== "active" || challenge.expires_at.getTime() <= now.getTime()
          || challenge.secret_expires_at.getTime() <= now.getTime()
          || challenge.code_hmac === null || challenge.hmac_key_id === null
          || challenge.failed_attempts >= MAX_FAILURES) {
          await rollback(client); return { kind: "invalid" };
        }

        const subjectHash = failureSubject(input.scope, input.deploymentRole, challenge.identity_id, challenge.flow_hash);
        const budgetResult = await client.query<BudgetRow>(
          `select used from enterprise_login_budgets
            where scope=$1 and deployment_role=$2 and budget_kind='verify-failure'
              and subject_hash=$3 and window_started_at > $4::timestamptz - interval '600 seconds'
              and window_started_at <= $4::timestamptz
            for update`,
          [input.scope, input.deploymentRole, subjectHash, now],
        );
        const budgetUsed = budgetResult.rows.reduce((total, row) => total + (Number.isSafeInteger(row.used) ? row.used : MAX_FAILURES), 0);
        if (budgetUsed >= MAX_FAILURES) {
          await rollback(client); return { kind: "invalid" };
        }

        let codeMatches = false;
        try { codeMatches = input.verifyCode(input.code, binding, record); } catch { codeMatches = false; }
        if (!codeMatches) {
          await client.query(
            `update enterprise_challenges set failed_attempts=failed_attempts+1 where id=$1`,
            [challenge.id],
          );
          await client.query(
            `insert into enterprise_login_budgets
               (scope,deployment_role,budget_kind,subject_hash,window_started_at,used,expires_at)
             values ($1,$2,'verify-failure',$3,$4,1,$5)
             on conflict (scope,deployment_role,budget_kind,subject_hash,window_started_at)
             do update set used=enterprise_login_budgets.used+1`,
            [input.scope, input.deploymentRole, subjectHash, now, new Date(now.getTime() + FAILURE_WINDOW_MS)],
          );
          committed = true;
          await client.query("commit");
          return { kind: "invalid" };
        }

        const grantId = randomUUID();
        const recoverUntil = new Date(now.getTime() + RECOVERY_WINDOW_MS);
        await client.query(
          `insert into enterprise_login_grants
             (id,challenge_id,scope,deployment_role,local_user_id,identity_id,
              identity_version,auth_epoch,flow_hash,generation,purpose,created_at,recover_until)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'login',$11,$12)`,
          [grantId, challenge.id, input.scope, input.deploymentRole, challenge.local_user_id,
            challenge.identity_id, challenge.identity_version, policy.auth_epoch, challenge.flow_hash,
            challenge.generation, now, recoverUntil],
        );
        await client.query(
          `update enterprise_challenges
              set state='consumed',consumed_at=$2,recover_until=$3,secret_expires_at=$3
            where id=$1 and state='active'`,
          [challenge.id, now, recoverUntil],
        );
        committed = true;
        await client.query("commit");
        return {
          kind: "accepted",
          grantId,
          challengeId: challenge.id,
          localUserId: challenge.local_user_id,
          identityId: challenge.identity_id,
          identityVersion: challenge.identity_version,
          authEpoch: policy.auth_epoch,
          flowHash: challenge.flow_hash,
          recoverUntil,
        };
      } catch {
        if (client && !committed) await rollback(client);
        return { kind: "unavailable" };
      } finally {
        client?.release(!committed);
      }
    },

    async cleanupExpiredSecrets(input: { readonly now?: Date; readonly limit?: number } = {}): Promise<number> {
      const now = input.now ?? new Date();
      const limit = input.limit ?? 100;
      if (!validDate(now) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return 0;
      let client: PoolClient | undefined;
      let committed = false;
      try {
        client = await pool.connect();
        await client.query("begin isolation level read committed");
        await client.query("set local lock_timeout='3s'; set local statement_timeout='3s'; set local idle_in_transaction_session_timeout='5s'");
        const result = await client.query<{ id: string }>(
          `with expired as (
             select id from enterprise_challenges
              where code_hmac is not null and secret_expires_at <= $1
                and (state <> 'active' or expires_at <= $1)
              order by secret_expires_at,id
              for update skip locked
              limit $2
           )
           update enterprise_challenges as challenge
              set code_hmac=null,hmac_key_id=null,secret_cleared_at=$1,
                  state=case when challenge.state='active' then 'expired' else challenge.state end
             from expired where challenge.id=expired.id
           returning challenge.id`,
          [now, limit],
        );
        committed = true;
        await client.query("commit");
        return result.rowCount ?? result.rows.length;
      } catch {
        if (client && !committed) await rollback(client);
        return 0;
      } finally {
        client?.release(!committed);
      }
    },
  });
}
