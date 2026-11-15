// megaui-only (FS-21): successful-login notification reconciliation.
//
// The service is deliberately separate from OTP verification.  It discovers
// committed enterprise sessions, writes one durable outbox row per grant, and
// only then attempts the FS-31 email.  A provider failure changes the outbox
// state, never the session or the grant.
import { randomUUID } from "node:crypto";

import type {
  EnterpriseLoginNotificationParams,
  EmailSender,
} from "@megaui/email";
import type { Pool, PoolClient } from "pg";

import {
  ENTERPRISE_NOTIFICATION_BATCH_LIMIT,
  ENTERPRISE_NOTIFICATION_QUEUE,
  nextEnterpriseNotificationSchedule,
  parseEnterpriseNotificationReconciliationJobPayload,
  scheduleEnterpriseNotificationReconciliationJob,
  type EnterpriseJob,
  type EnterpriseJobHandler,
  type EnterpriseJobWriter,
} from "./jobs";

const RETENTION_DAYS = 30;
const DELIVERY_RETRY_DELAY_MS = 60_000;

export interface EnterpriseNotificationSender {
  sendEnterpriseLoginNotificationEmail: EmailSender["sendEnterpriseLoginNotificationEmail"];
}

export interface EnterpriseNotificationsOptions {
  readonly pool: Pool;
  readonly sender: EnterpriseNotificationSender;
  readonly appName: string;
  readonly appUrl: string;
  readonly locale?: "en" | "zh-CN";
  readonly now?: () => Date;
}

export interface EnterpriseNotificationReconcileResult {
  readonly candidates: number;
  readonly inserted: number;
  readonly invalidated: number;
  readonly skipped: number;
  readonly sent: number;
  readonly failed: number;
}

export interface EnterpriseNotificationsService {
  readonly reconcile: () => Promise<{
    candidates: number;
    inserted: number;
    invalidated: number;
    skipped: number;
  }>;
  readonly deliver: () => Promise<{ sent: number; failed: number }>;
  readonly reconcileAndDeliver: () => Promise<EnterpriseNotificationReconcileResult>;
}

interface CandidateRow {
  grantId: string;
  destinationEmail: string | null;
  destinationVersion: string;
  recipientName: string;
  loginAt: Date;
  device: string | null;
  source: string | null;
}

interface PendingRow {
  id: string;
  grantId: string;
  destinationEmail: string;
  destinationVersion: string;
  recipientName: string;
  loginAt: Date;
  device: string;
  source: string;
  appName: string;
  appUrl: string;
  locale: "en" | "zh-CN";
  attempts: number;
}

function requireText(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new Error(`INVALID_ENTERPRISE_NOTIFICATION_${field.toUpperCase()}`);
  }
  return value;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function maskSource(value: string | null): string {
  if (!value || value.trim() === "") return "unknown source";
  const source = value.trim();
  const ipv4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/u.exec(source);
  if (ipv4?.[1]) return `${ipv4[1]}.*`;
  if (source.includes(":")) return "IPv6 source";
  return source.slice(0, 512);
}

function deviceText(value: string | null): string {
  if (!value || value.trim() === "") return "Unknown device";
  return value.trim().slice(0, 512);
}

function validateOptions(options: EnterpriseNotificationsOptions): void {
  if (!options || !options.pool || typeof options.pool.connect !== "function"
    || !options.sender || typeof options.sender.sendEnterpriseLoginNotificationEmail !== "function") {
    throw new Error("INVALID_ENTERPRISE_NOTIFICATION_CONFIG");
  }
  requireText(options.appName, "APP_NAME");
  if (typeof options.appUrl !== "string" || !/^https?:\/\/[^?#\s]+$/u.test(options.appUrl)) {
    throw new Error("INVALID_ENTERPRISE_NOTIFICATION_APP_URL");
  }
  if (options.locale !== undefined && options.locale !== "en" && options.locale !== "zh-CN") {
    throw new Error("INVALID_ENTERPRISE_NOTIFICATION_LOCALE");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new Error("INVALID_ENTERPRISE_NOTIFICATION_CLOCK");
  }
}

function clock(options: EnterpriseNotificationsOptions): Date {
  const now = options.now?.() ?? new Date();
  if (!validDate(now)) throw new Error("INVALID_ENTERPRISE_NOTIFICATION_CLOCK");
  return new Date(now.getTime());
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query("rollback"); } catch { /* preserve the original error */ }
}

async function readCandidates(client: PoolClient, now: Date): Promise<CandidateRow[]> {
  const result = await client.query<CandidateRow>(
    `select g.id as "grantId",
            profile.notification_email as "destinationEmail",
            coalesce(to_char(profile.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'missing-profile') as "destinationVersion",
            coalesce(profile.display_name, account.name) as "recipientName",
            session.created_at as "loginAt",
            session.user_agent as "device",
            session.ip_address as "source"
       from "session" as session
       join enterprise_login_grants as g on g.id = session.enterprise_grant_id
       join enterprise_identity as identity on identity.id = g.identity_id
       join enterprise_policy as policy on policy.scope = g.scope
       join "user" as account on account.id = g.local_user_id
       left join enterprise_profile as profile on profile.user_id = g.local_user_id
      where session.auth_method = 'enterprise'
        and session.expires_at > $1
        and identity.status = 'active'
        and policy.activation_state = 'enterprise'
        and policy.deployment_role = g.deployment_role
      order by g.created_at, g.id
      limit $2`,
    [now, ENTERPRISE_NOTIFICATION_BATCH_LIMIT],
  );
  return result.rows.filter((row) => row
    && typeof row.grantId === "string"
    && (row.destinationEmail === null || typeof row.destinationEmail === "string")
    && typeof row.destinationVersion === "string"
    && typeof row.recipientName === "string"
    && validDate(row.loginAt));
}

async function invalidateInactive(client: PoolClient, now: Date): Promise<number> {
  const result = await client.query(
    `update enterprise_notification_outbox as outbox
        set state = 'skipped', skipped_at = $1, available_at = $1, updated_at = $1
      where outbox.state in ('pending', 'sending', 'failed')
        and not exists (
          select 1
            from "session" as session
            join enterprise_login_grants as grant_row on grant_row.id = session.enterprise_grant_id
            join enterprise_identity as identity on identity.id = grant_row.identity_id
            join enterprise_policy as policy on policy.scope = grant_row.scope
           where grant_row.id = outbox.grant_id
             and session.auth_method = 'enterprise'
             and session.expires_at > $1
             and identity.status = 'active'
             and policy.activation_state = 'enterprise'
             and policy.deployment_role = grant_row.deployment_role
        )`,
    [now],
  );
  return result.rowCount ?? 0;
}

async function reconcileRows(
  client: PoolClient,
  candidates: readonly CandidateRow[],
  options: EnterpriseNotificationsOptions,
  now: Date,
): Promise<{ inserted: number; invalidated: number; skipped: number }> {
  let inserted = 0;
  let invalidated = 0;
  let skipped = 0;
  const locale = options.locale ?? "en";
  for (const candidate of candidates) {
    const stale = await client.query(
      `update enterprise_notification_outbox
          set state = 'skipped', skipped_at = $2, available_at = $2, updated_at = $2
        where grant_id = $1
          and destination_version is distinct from $3
          and state in ('pending', 'sending', 'failed')`,
      [candidate.grantId, now, candidate.destinationVersion],
    );
    invalidated += stale.rowCount ?? 0;

    const result = await client.query(
      `insert into enterprise_notification_outbox
         (id, grant_id, destination_email, destination_version, recipient_name,
          login_at, device, source, app_name, app_url, locale, state,
          available_at, skipped_at, expires_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          case when $3::text is null then 'skipped' else 'pending' end,
          $12,
          case when $3::text is null then $13::timestamptz else null end,
          $13::timestamptz + interval '${RETENTION_DAYS} days', $13::timestamptz, $13::timestamptz)
       on conflict (grant_id) do nothing`,
      [
        randomUUID(),
        candidate.grantId,
        candidate.destinationEmail,
        candidate.destinationVersion,
        requireText(candidate.recipientName, "RECIPIENT_NAME"),
        candidate.loginAt,
        deviceText(candidate.device),
        maskSource(candidate.source),
        options.appName,
        options.appUrl,
        locale,
        now,
        now,
      ],
    );
    const count = result.rowCount ?? 0;
    inserted += count;
    if (candidate.destinationEmail === null && count > 0) skipped += 1;
  }
  return { inserted, invalidated, skipped };
}

async function currentIdentityIsActive(pool: Pool, grantId: string, now: Date): Promise<boolean> {
  const result = await pool.query<{ active: boolean }>(
    `select exists (
       select 1
         from "session" as session
         join enterprise_login_grants as grant_row on grant_row.id = session.enterprise_grant_id
         join enterprise_identity as identity on identity.id = grant_row.identity_id
         join enterprise_policy as policy on policy.scope = grant_row.scope
        where grant_row.id = $1
          and session.auth_method = 'enterprise'
          and session.expires_at > $2
          and identity.status = 'active'
          and policy.activation_state = 'enterprise'
          and policy.deployment_role = grant_row.deployment_role
     ) as active`,
    [grantId, now],
  );
  return result.rows[0]?.active === true;
}

async function claimPending(pool: Pool, now: Date): Promise<PendingRow[]> {
  const result = await pool.query<PendingRow>(
    `with candidates as (
       select id
         from enterprise_notification_outbox
        where state in ('pending', 'failed')
          and available_at <= $1
          and expires_at > $1
        order by available_at, id
        limit $2
        for update skip locked
     )
     update enterprise_notification_outbox as outbox
        set state = 'sending', updated_at = $1
       from candidates
      where outbox.id = candidates.id
      returning outbox.id,
                outbox.grant_id as "grantId",
                outbox.destination_email as "destinationEmail",
                outbox.destination_version as "destinationVersion",
                outbox.recipient_name as "recipientName",
                outbox.login_at as "loginAt",
                outbox.device as "device",
                outbox.source as "source",
                outbox.app_name as "appName",
                outbox.app_url as "appUrl",
                outbox.locale,
                outbox.attempts`,
    [now, ENTERPRISE_NOTIFICATION_BATCH_LIMIT],
  );
  return result.rows;
}

export function createEnterpriseNotificationsService(
  options: EnterpriseNotificationsOptions,
): EnterpriseNotificationsService {
  validateOptions(options);

  const reconcile = async () => {
    const now = clock(options);
    const client = await options.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local statement_timeout='5s'; set local lock_timeout='1s';");
      const invalidated = await invalidateInactive(client, now);
      const candidates = await readCandidates(client, now);
      const result = await reconcileRows(client, candidates, options, now);
      await client.query("commit");
      return {
        candidates: candidates.length,
        inserted: result.inserted,
        invalidated: invalidated + result.invalidated,
        skipped: result.skipped,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  };

  const deliver = async () => {
    const now = clock(options);
    const claimed = await claimPending(options.pool, now);
    let sent = 0;
    let failed = 0;
    for (const row of claimed) {
      if (!(await currentIdentityIsActive(options.pool, row.grantId, now))) {
        await options.pool.query(
          `update enterprise_notification_outbox
              set state = 'skipped', skipped_at = $2, available_at = $2, updated_at = $2
            where id = $1 and state = 'sending'`,
          [row.id, now],
        );
        continue;
      }
      if (!row.destinationEmail) continue;
      const params: EnterpriseLoginNotificationParams = {
        recipientName: row.recipientName,
        loginAt: row.loginAt.toISOString(),
        device: row.device,
        source: row.source,
        appName: row.appName,
        appUrl: row.appUrl,
        locale: row.locale,
      };
      try {
        await options.sender.sendEnterpriseLoginNotificationEmail(row.destinationEmail, params);
        const result = await options.pool.query(
          `update enterprise_notification_outbox
              set state = 'sent', sent_at = $2, available_at = $2, updated_at = $2
            where id = $1 and state = 'sending'`,
          [row.id, now],
        );
        sent += result.rowCount ?? 0;
      } catch {
        const result = await options.pool.query(
          `update enterprise_notification_outbox
              set state = 'failed', attempts = attempts + 1,
                  available_at = $2::timestamptz + interval '${DELIVERY_RETRY_DELAY_MS / 1000} seconds', updated_at = $2::timestamptz,
                  last_error_code = 'DELIVERY_FAILED'
            where id = $1 and state = 'sending'`,
          [row.id, now],
        );
        failed += result.rowCount ?? 0;
      }
    }
    return { sent, failed };
  };

  return Object.freeze({
    reconcile,
    deliver,
    async reconcileAndDeliver(): Promise<EnterpriseNotificationReconcileResult> {
      const reconciliation = await reconcile();
      const delivery = await deliver();
      return { ...reconciliation, ...delivery };
    },
  });
}

/** Registers the recurring durable worker handler for FS-21. */
export function createEnterpriseNotificationJobHandler(options: {
  service: EnterpriseNotificationsService;
  writer: EnterpriseJobWriter;
}): EnterpriseJobHandler {
  if (!options?.service || !options.writer || typeof options.writer.query !== "function") {
    throw new Error("INVALID_ENTERPRISE_NOTIFICATION_HANDLER_CONFIG");
  }
  return async (job: EnterpriseJob) => {
    if (job.queue !== ENTERPRISE_NOTIFICATION_QUEUE) {
      throw new Error("[@megaui/engine] enterprise notification received another queue");
    }
    const payload = parseEnterpriseNotificationReconciliationJobPayload(job.payload);
    await options.service.reconcileAndDeliver();
    await scheduleEnterpriseNotificationReconciliationJob(options.writer, {
      scheduledFor: nextEnterpriseNotificationSchedule(payload.scheduledFor).toISOString(),
    });
  };
}
