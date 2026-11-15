// megaui-only (FS-84): bounded retention for enterprise authentication metadata.
//
// Pairings, verified-event inbox rows, and encrypted DM deliveries retain their
// own leases and cleanup contracts. This service owns the remaining durable
// rows and performs one small transaction so a failure rolls the page back and
// leaves the leased job available to the worker's retry path.
import type { Pool, PoolClient } from "pg";

import {
  ENTERPRISE_RETENTION_BATCH_LIMIT,
  ENTERPRISE_RETENTION_QUEUE,
  nextEnterpriseRetentionSchedule,
  parseEnterpriseRetentionJobPayload,
  scheduleEnterpriseRetentionJob,
  type EnterpriseJob,
  type EnterpriseJobHandler,
} from "./jobs";

export const ENTERPRISE_RETENTION_DAYS = 30;

export interface EnterpriseRetentionResult {
  readonly jobs: number;
  readonly notifications: number;
  readonly budgets: number;
  readonly grants: number;
  readonly total: number;
}

export interface EnterpriseRetentionOptions {
  readonly pool: Pool;
  readonly now?: () => Date;
}

export interface EnterpriseRetentionService {
  readonly cleanup: () => Promise<EnterpriseRetentionResult>;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function invalidClock(): Error {
  return new Error("INVALID_ENTERPRISE_RETENTION_CLOCK");
}

function validateOptions(options: EnterpriseRetentionOptions): void {
  if (!options || typeof options.pool?.connect !== "function") {
    throw new Error("INVALID_ENTERPRISE_RETENTION_CONFIG");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new Error("INVALID_ENTERPRISE_RETENTION_CLOCK");
  }
}

function readClock(options: EnterpriseRetentionOptions): Date {
  const value = options.now?.() ?? new Date();
  if (!validDate(value)) throw invalidClock();
  return new Date(value.getTime());
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query("rollback"); } catch { /* preserve the original error */ }
}

async function deletePage(
  client: PoolClient,
  table: "enterprise_jobs" | "enterprise_notification_outbox" | "enterprise_login_budgets" | "enterprise_login_grants",
  now: Date,
  limit: number,
): Promise<number> {
  if (limit <= 0) return 0;
  const queries: Record<typeof table, string> = {
    enterprise_jobs: `with expired as (
       select id
         from enterprise_jobs
        where state = 'done' and completed_at <= $1
        order by completed_at, id
        limit $2
        for update skip locked
     )
     delete from enterprise_jobs as job using expired
      where job.id = expired.id`,
    enterprise_notification_outbox: `with expired as (
       select id
         from enterprise_notification_outbox
        where expires_at <= $1
        order by expires_at, id
        limit $2
        for update skip locked
     )
     delete from enterprise_notification_outbox as outbox using expired
      where outbox.id = expired.id`,
    enterprise_login_budgets: `with expired as (
       select scope, deployment_role, budget_kind, subject_hash, window_started_at
         from enterprise_login_budgets
        where expires_at <= $1
        order by expires_at, scope, deployment_role, budget_kind, subject_hash, window_started_at
        limit $2
        for update skip locked
     )
     delete from enterprise_login_budgets as budget using expired
      where budget.scope = expired.scope
        and budget.deployment_role = expired.deployment_role
        and budget.budget_kind = expired.budget_kind
        and budget.subject_hash = expired.subject_hash
        and budget.window_started_at = expired.window_started_at`,
    enterprise_login_grants: `with expired as (
       select grant_row.id
         from enterprise_login_grants as grant_row
        where grant_row.recover_until <= $1
          and not exists (
            select 1 from session where session.enterprise_grant_id = grant_row.id
          )
          and not exists (
            select 1 from enterprise_notification_outbox
             where enterprise_notification_outbox.grant_id = grant_row.id
          )
        order by grant_row.recover_until, grant_row.id
        limit $2
        for update of grant_row skip locked
     )
     delete from enterprise_login_grants as grant_row using expired
      where grant_row.id = expired.id`,
  };
  const result = await client.query(queries[table], [now, limit]);
  return result.rowCount ?? 0;
}

/** Deletes one total page across all FS-84-owned retention classes. */
export async function cleanupEnterpriseRetention(
  pool: Pool,
  now: Date = new Date(),
  limit = ENTERPRISE_RETENTION_BATCH_LIMIT,
): Promise<EnterpriseRetentionResult> {
  if (!pool || typeof pool.connect !== "function" || !validDate(now)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > ENTERPRISE_RETENTION_BATCH_LIMIT) {
    throw new Error("INVALID_ENTERPRISE_RETENTION_INPUT");
  }
  const client = await pool.connect();
  const cutoff = new Date(now.getTime() - ENTERPRISE_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
  const counts = { jobs: 0, notifications: 0, budgets: 0, grants: 0 };
  try {
    await client.query("begin isolation level read committed");
    await client.query("set local lock_timeout='1s'; set local statement_timeout='5s'; set local idle_in_transaction_session_timeout='6s'");
    let remaining = limit;
    counts.jobs = await deletePage(client, "enterprise_jobs", cutoff, remaining);
    remaining -= counts.jobs;
    counts.notifications = await deletePage(client, "enterprise_notification_outbox", now, remaining);
    remaining -= counts.notifications;
    counts.budgets = await deletePage(client, "enterprise_login_budgets", now, remaining);
    remaining -= counts.budgets;
    counts.grants = await deletePage(client, "enterprise_login_grants", now, remaining);
    await client.query("commit");
    return { ...counts, total: counts.jobs + counts.notifications + counts.budgets + counts.grants };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export function createEnterpriseRetentionService(
  options: EnterpriseRetentionOptions,
): EnterpriseRetentionService {
  validateOptions(options);
  return Object.freeze({
    cleanup: () => cleanupEnterpriseRetention(options.pool, readClock(options)),
  });
}

/** Registers the recurring bounded retention handler. */
export function createEnterpriseRetentionJobHandler(options: {
  readonly pool: Pool;
  readonly now?: () => Date;
}): EnterpriseJobHandler {
  const service = createEnterpriseRetentionService(options);
  return async (job: EnterpriseJob) => {
    if (job.queue !== ENTERPRISE_RETENTION_QUEUE) {
      throw new Error("INVALID_ENTERPRISE_RETENTION_JOB");
    }
    const payload = parseEnterpriseRetentionJobPayload(job.payload);
    await service.cleanup();
    await scheduleEnterpriseRetentionJob(options.pool, {
      scheduledFor: nextEnterpriseRetentionSchedule(payload.scheduledFor).toISOString(),
    });
  };
}
