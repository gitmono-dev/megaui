// megaui-only (FS-13): encrypted enterprise login delivery and bounded cleanup.
/**
 * Delivers the already-created challenge payload exactly once-or-unknown.
 *
 * The worker never creates a code. It first verifies the leased durable job,
 * reads the challenge and its identity binding, checks the current database
 * qualification, and only then opens the opaque delivery envelope. A
 * provider result that cannot be classified is retried with the same delivery
 * UUID; no email or replacement challenge exists on this path.
 */
import type { AuthMode } from "@megaui/core";
import type { EnterpriseScopeExpectation } from "@megaui/database";
import type { Pool } from "pg";

import {
  createEnterpriseEligibilityService,
  createPostgresAuthenticationEligibilityReader,
} from "./eligibility";
import {
  ENTERPRISE_DM_CLEANUP_BATCH_LIMIT,
  ENTERPRISE_DM_CLEANUP_QUEUE,
  ENTERPRISE_DM_DELIVERY_QUEUE,
  ENTERPRISE_DM_RETRY_WINDOW_MS,
  ENTERPRISE_DM_MAX_ATTEMPTS,
  nextEnterpriseDmCleanupSchedule,
  parseEnterpriseDmDeliveryJobPayload,
  parseEnterpriseDmCleanupJobPayload,
  scheduleEnterpriseDmCleanupJob,
  type EnterpriseJob,
  type EnterpriseJobContext,
  type EnterpriseJobHandler,
  type EnterpriseJobWriter,
} from "./jobs";
import type { DirectoryScope } from "./feishu/directory";
import type { FeishuMessageResult } from "./feishu/message";

/** The five-minute operational bound for deleting expired ciphertext. */
export const ENTERPRISE_DM_CIPHERTEXT_CLEANUP_GRACE_MS = 5 * 60 * 1_000;

/** A structural crypto port keeps delivery independent from auth key ownership. */
export interface EnterpriseDeliveryCryptoPort {
  readonly open: (
    record: unknown,
    binding: EnterpriseOtpDeliveryBinding,
  ) => string | null;
}
/** The binding reconstructed from the trusted challenge row. */
export interface EnterpriseOtpDeliveryBinding {
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

/** The only provider operation delivery is allowed to call. */
export interface EnterpriseDeliveryMessageClient {
  readonly send: (input: {
    readonly boundOpenId: string;
    readonly code: string;
    readonly uuid: string;
  }) => Promise<FeishuMessageResult>;
}

export interface EnterpriseDeliverySqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount?: number | null }>;
}

export interface EnterpriseDeliveryOptions {
  readonly pool: Pool | EnterpriseDeliverySqlClient;
  readonly expectation: EnterpriseScopeExpectation;
  readonly tenantKey: string;
  readonly appId: string;
  readonly directoryScope: DirectoryScope;
  readonly authMode: AuthMode;
  readonly crypto: EnterpriseDeliveryCryptoPort;
  readonly messageClient: EnterpriseDeliveryMessageClient;
  readonly now?: () => Date;
  /** Kept injectable so the simulator can exercise the provider window. */
  readonly retryWindowMs?: number;
  readonly maxAttempts?: number;
}

interface JobLeaseRow extends Record<string, unknown> {
  id: string;
  queue: string;
  state: string;
  claimOwner: string | null;
  leaseUntil: Date | null;
  attempts: number;
  payload: unknown;
}

interface DeliveryRow extends Record<string, unknown> {
  deliveryId: string;
  challengeId: string;
  deliveryKeyId: string;
  encryptedPayload: string;
  deliveryExpiresAt: Date;
  firstAttemptAt: Date | null;
  sentAt: Date | null;
  challengeState: string;
  challengeExpiresAt: Date;
  scope: string;
  deploymentRole: "development" | "test" | "production" | "canary";
  localUserId: string;
  identityId: string;
  identityVersion: number;
  currentIdentityVersion: number;
  flowHash: string;
  generation: number;
  purpose: string;
  openId: string;
  authEpoch: number;
  policyScope: string;
  nowAt: Date;
}

const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);

const finiteDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());

const retryFailure = (): Error => new Error("ENTERPRISE_DM_DELIVERY_RETRY");
const unavailableFailure = (): Error => new Error("ENTERPRISE_DM_DELIVERY_UNAVAILABLE");

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /\S/u.test(value);
}

function validRole(value: unknown): value is EnterpriseOtpDeliveryBinding["deploymentRole"] {
  return value === "development" || value === "test" || value === "production" || value === "canary";
}

function validOptions(options: EnterpriseDeliveryOptions): void {
  if (!options || !options.pool || typeof options.pool.query !== "function"
    || !options.expectation || options.expectation.processRole !== "worker" && options.expectation.processRole !== "test"
    || !validText(options.expectation.instanceId) || !validText(options.expectation.ownerFingerprint)
    || !validRole(options.expectation.environment) || !validText(options.tenantKey) || !validText(options.appId)
    || !options.directoryScope || !validText(options.directoryScope.tenantKey)
    || !validText(options.directoryScope.appId) || !Array.isArray(options.directoryScope.departmentIds)
    || options.directoryScope.departmentIds.length === 0
    || !options.directoryScope.departmentIds.every(validText)
    || options.directoryScope.tenantKey !== options.tenantKey
    || options.directoryScope.appId !== options.appId
    || !["legacy", "enterprise", "maintenance"].includes(options.authMode)
    || typeof options.crypto?.open !== "function" || typeof options.messageClient?.send !== "function") {
    throw new Error("INVALID_ENTERPRISE_DM_DELIVERY_CONFIG");
  }
  const retryWindowMs = options.retryWindowMs ?? ENTERPRISE_DM_RETRY_WINDOW_MS;
  const maxAttempts = options.maxAttempts ?? ENTERPRISE_DM_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(retryWindowMs) || retryWindowMs <= 0 || retryWindowMs > ENTERPRISE_DM_RETRY_WINDOW_MS
    || !Number.isSafeInteger(maxAttempts) || maxAttempts !== ENTERPRISE_DM_MAX_ATTEMPTS) {
    throw new Error("INVALID_ENTERPRISE_DM_DELIVERY_CONFIG");
  }
}

async function readLease(
  pool: EnterpriseDeliverySqlClient,
  job: EnterpriseJob,
  claimOwner: string,
  deliveryId: string,
): Promise<JobLeaseRow | undefined> {
  const result = await pool.query<JobLeaseRow>(
    `select id, queue, state, claim_owner as "claimOwner", lease_until as "leaseUntil",
            attempts, payload
       from enterprise_jobs
      where id = $1 and queue = $2 and state = 'leased'
        and claim_owner = $3 and lease_until > clock_timestamp()`,
    [job.id, ENTERPRISE_DM_DELIVERY_QUEUE, claimOwner],
  );
  if (result.rows.length !== 1) return undefined;
  const row = result.rows[0];
  if (!row || row.id !== job.id || row.queue !== ENTERPRISE_DM_DELIVERY_QUEUE
    || row.state !== "leased" || row.claimOwner !== claimOwner
    || !finiteDate(row.leaseUntil) || row.leaseUntil.getTime() <= Date.now()
    || !Number.isSafeInteger(row.attempts) || row.attempts < 1) return undefined;
  try {
    if (parseEnterpriseDmDeliveryJobPayload(row.payload).deliveryId !== deliveryId) return undefined;
  } catch {
    return undefined;
  }
  return row;
}

async function readDelivery(
  pool: EnterpriseDeliverySqlClient,
  deliveryId: string,
  options: EnterpriseDeliveryOptions,
): Promise<DeliveryRow | undefined> {
  const result = await pool.query<DeliveryRow>(
    `select delivery.id as "deliveryId",
            delivery.challenge_id as "challengeId",
            delivery.delivery_key_id as "deliveryKeyId",
            delivery.encrypted_payload as "encryptedPayload",
            delivery.expires_at as "deliveryExpiresAt",
            delivery.first_attempt_at as "firstAttemptAt",
            delivery.sent_at as "sentAt",
            challenge.state as "challengeState",
            challenge.expires_at as "challengeExpiresAt",
            challenge.scope,
            challenge.deployment_role as "deploymentRole",
            challenge.local_user_id as "localUserId",
            challenge.identity_id as "identityId",
            challenge.identity_version as "identityVersion",
            challenge.flow_hash as "flowHash",
            challenge.generation,
            challenge.purpose,
            identity.open_id as "openId",
            identity.identity_version as "currentIdentityVersion",
            policy.auth_epoch as "authEpoch",
            policy.scope as "policyScope",
            clock_timestamp() as "nowAt"
       from enterprise_dm_deliveries as delivery
       join enterprise_challenges as challenge
         on challenge.id = delivery.challenge_id
        and challenge.expires_at = delivery.expires_at
       join enterprise_identity as identity
         on identity.id = challenge.identity_id
        and identity.local_user_id = challenge.local_user_id
        and identity.tenant_key = $2
        and identity.app_id = $3
       join enterprise_policy as policy
         on policy.scope = challenge.scope
        and policy.deployment_role = challenge.deployment_role
        and policy.environment = $5
      where delivery.id = $1
        and challenge.scope = $4
        and challenge.deployment_role = $5
        and delivery.expires_at = challenge.expires_at`,
    [deliveryId, options.tenantKey, options.appId, options.expectation.instanceId, options.expectation.environment],
  );
  if (result.rows.length !== 1) return undefined;
  return result.rows[0];
}

function validDeliveryRow(row: DeliveryRow): boolean {
  return uuid(row.deliveryId) && uuid(row.challengeId) && validText(row.deliveryKeyId)
    && typeof row.encryptedPayload === "string" && row.encryptedPayload.length >= 48
    && finiteDate(row.deliveryExpiresAt) && (row.firstAttemptAt === null || finiteDate(row.firstAttemptAt))
    && (row.sentAt === null || finiteDate(row.sentAt)) && validRole(row.deploymentRole)
    && validText(row.scope) && validText(row.localUserId) && validText(row.identityId)
    && Number.isSafeInteger(row.identityVersion) && row.identityVersion >= 1
    && Number.isSafeInteger(row.currentIdentityVersion) && row.currentIdentityVersion >= 1
    && /^[0-9a-f]{64}$/u.test(row.flowHash) && Number.isSafeInteger(row.generation) && row.generation >= 1
    && row.purpose === "login" && validText(row.openId) && Number.isSafeInteger(row.authEpoch) && row.authEpoch >= 0
    && validText(row.policyScope) && finiteDate(row.challengeExpiresAt) && finiteDate(row.nowAt);
}

function bindingOf(
  row: DeliveryRow,
  tenantKey: string,
  appId: string,
): EnterpriseOtpDeliveryBinding {
  return {
    scope: row.scope,
    deploymentRole: row.deploymentRole,
    tenantKey,
    appId,
    challengeId: row.challengeId,
    localUserId: row.localUserId,
    identityId: row.identityId,
    identityVersion: row.identityVersion,
    purpose: "login",
    flowHash: row.flowHash,
    generation: row.generation,
    expiresAtMs: row.challengeExpiresAt.getTime(),
  };
}

/**
 * Creates the worker handler for the durable delivery queue.
 *
 * Unknown provider results are the only retryable outcome. The handler throws
 * a stable internal error for the generic worker backoff; permanent provider
 * failures and all invalid/expired/consumed/maintenance states complete the
 * job without an Email fallback.
 */
export function createEnterpriseDmDeliveryJobHandler(
  options: EnterpriseDeliveryOptions,
): EnterpriseJobHandler {
  validOptions(options);
  const pool = options.pool as EnterpriseDeliverySqlClient;
  const now = options.now ?? (() => new Date());
  const retryWindowMs = options.retryWindowMs ?? ENTERPRISE_DM_RETRY_WINDOW_MS;
  const maxAttempts = options.maxAttempts ?? ENTERPRISE_DM_MAX_ATTEMPTS;
  const expectation = Object.freeze({ ...options.expectation });

  return async (job: EnterpriseJob, context?: EnterpriseJobContext): Promise<void> => {
    if (!job || job.queue !== ENTERPRISE_DM_DELIVERY_QUEUE || !context
      || typeof context.claimOwner !== "string" || context.claimOwner.length < 1
      || context.claimOwner.length > 256 || !(context.signal instanceof AbortSignal) || context.signal.aborted) {
      throw unavailableFailure();
    }
    const payload = parseEnterpriseDmDeliveryJobPayload(job.payload);
    if (context.signal.aborted) throw unavailableFailure();
    const lease = await readLease(pool, job, context.claimOwner, payload.deliveryId);
    if (!lease) throw unavailableFailure();
    const attempts = Math.min(lease.attempts, Number.MAX_SAFE_INTEGER);
    if (attempts > maxAttempts) return;

    const row = await readDelivery(pool, payload.deliveryId, options);
    if (!row || !validDeliveryRow(row) || row.sentAt !== null) return;
    const at = now();
    if (!finiteDate(at)) throw unavailableFailure();
    const nowMs = at.getTime();
    if (row.challengeState !== "active" || row.challengeExpiresAt.getTime() <= nowMs
      || row.deliveryExpiresAt.getTime() <= nowMs || row.currentIdentityVersion !== row.identityVersion) return;
    const firstAttemptMs = row.firstAttemptAt?.getTime();
    if (firstAttemptMs !== undefined && nowMs - firstAttemptMs >= retryWindowMs) return;

    // The qualification resolver is database-authoritative and deliberately
    // receives a provider reader that can never be called from this worker.
    const eligibility = createEnterpriseEligibilityService({
      directoryScope: options.directoryScope,
      policyScope: expectation.instanceId,
      authMode: options.authMode,
      databaseReader: createPostgresAuthenticationEligibilityReader(pool),
      directoryReader: {
        tenantKey: options.tenantKey,
        appId: options.appId,
        read: async () => Promise.reject(new Error("enterprise delivery must not call provider")),
      },
      now: () => at,
    });
    if (!(await eligibility.authenticationEligibility(row.localUserId, row.identityId, row.authEpoch))) return;

    const binding = bindingOf(row, options.tenantKey, options.appId);
    let code: string | null;
    try {
      code = options.crypto.open({
        encryptedPayload: row.encryptedPayload,
        deliveryKeyId: row.deliveryKeyId,
      }, binding);
    } catch {
      return;
    }
    if (typeof code !== "string" || code.length === 0) return;

    // Reserve the first-attempt timestamp only after all fail-closed checks.
    // The timestamp is shared by every retry and bounds the provider window.
    if (row.firstAttemptAt === null) {
      const reserved = await pool.query<{ firstAttemptAt: Date }>(
        `update enterprise_dm_deliveries
            set first_attempt_at = clock_timestamp()
          where id = $1 and sent_at is null and expires_at > clock_timestamp()
        returning first_attempt_at as "firstAttemptAt"`,
        [row.deliveryId],
      );
      if (reserved.rows.length !== 1 || !finiteDate(reserved.rows[0]?.firstAttemptAt)) return;
      row.firstAttemptAt = reserved.rows[0]!.firstAttemptAt;
    }
    const first = row.firstAttemptAt.getTime();
    if (nowMs - first >= retryWindowMs) return;
    if (!(await readLease(pool, job, context.claimOwner, payload.deliveryId)) || context.signal.aborted) {
      throw unavailableFailure();
    }

    const result = await options.messageClient.send({
      boundOpenId: row.openId,
      code,
      uuid: row.deliveryId,
    });
    if (!result || result.uuid !== row.deliveryId) return;
    if (result.kind === "accepted") {
      const marked = await pool.query(
        `update enterprise_dm_deliveries
            set sent_at = clock_timestamp()
          where id = $1 and sent_at is null`,
        [row.deliveryId],
      );
      if ((marked.rowCount ?? 0) !== 1) throw unavailableFailure();
      return;
    }
    if (result.kind === "unknown" && attempts < maxAttempts) {
      const after = now();
      if (finiteDate(after) && after.getTime() - first < retryWindowMs) throw retryFailure();
    }
    // Permanent rejection, malformed provider response, exhausted attempts,
    // and an expired idempotency window all complete without another channel.
  };
}

/** Deletes one bounded page of expired encrypted DM payloads. */
export async function cleanupExpiredEnterpriseDmDeliveries(
  writer: EnterpriseJobWriter,
  now: Date = new Date(),
): Promise<number> {
  if (!finiteDate(now)) throw new Error("INVALID_ENTERPRISE_DM_CLEANUP_CLOCK");
  const result = await writer.query(
    `with expired as (
       select delivery.id
         from enterprise_dm_deliveries as delivery
        where delivery.expires_at <= $1
        order by delivery.expires_at, delivery.id
        limit $2
        for update of delivery skip locked
     )
     delete from enterprise_dm_deliveries as delivery
      using expired
      where delivery.id = expired.id`,
    [now, ENTERPRISE_DM_CLEANUP_BATCH_LIMIT],
  );
  return result.rowCount ?? 0;
}

/** The recurring cleanup handler is intentionally separate from delivery. */
export function createEnterpriseDmCleanupJobHandler(options: {
  readonly writer: EnterpriseJobWriter;
  readonly now?: () => Date;
}): EnterpriseJobHandler {
  return async (job) => {
    if (!job || job.queue !== ENTERPRISE_DM_CLEANUP_QUEUE) throw new Error("INVALID_ENTERPRISE_DM_CLEANUP_JOB");
    const payload = parseEnterpriseDmCleanupJobPayload(job.payload);
    await cleanupExpiredEnterpriseDmDeliveries(options.writer, options.now?.() ?? new Date());
    await scheduleEnterpriseDmCleanupJob(options.writer, {
      scheduledFor: nextEnterpriseDmCleanupSchedule(payload.scheduledFor).toISOString(),
    });
  };
}
