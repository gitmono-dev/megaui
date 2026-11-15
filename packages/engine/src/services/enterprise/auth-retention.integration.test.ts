// megaui-only (FS-84): bounded enterprise retention against one owned PG.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import {
  createAnonymousIpSubjectCache,
} from "./anonymous-budget";
import {
  cleanupEnterpriseRetention,
  createEnterpriseRetentionJobHandler,
} from "./auth-retention";
import {
  ENTERPRISE_RETENTION_QUEUE,
  enterpriseRetentionSlot,
  scheduleEnterpriseRetentionJob,
  type EnterpriseJob,
} from "./jobs";

const NOW = new Date("2026-01-31T12:34:56.000Z");
const SCOPE = "fs84-retention";
const USER = "fs84-retention-user";
const IDENTITY = "fs84-retention-identity";
const CHALLENGE = "11111111-1111-4111-8111-111111111111";
const GRANT = "22222222-2222-4222-8222-222222222222";
const SESSION = "fs84-retention-session";
const FLOW_HASH = "a".repeat(64);
const CODE_HASH = "b".repeat(64);

describe("enterprise retention (FS-84)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1_000, statement_timeout: 5_000 });
    pool.on("error", () => undefined);
    await pool.query(`
      insert into enterprise_policy
        (id,scope,owner_fingerprint,deployment_role,environment,activation_state,auth_epoch)
      values ($1,$1,'megaui','test','test','enterprise',1)
    `, [SCOPE]);
    await pool.query(`
      insert into "user" (id,name,email,email_verified)
      values ($1,'FS84 User','fs84@example.test',false)
    `, [USER]);
    await pool.query(`
      insert into enterprise_identity
        (id,local_user_id,tenant_key,app_id,open_id,identity_version,status)
      values ($1,$2,'tenant','app','open-fs84',1,'active')
    `, [IDENTITY, USER]);
    await pool.query(`
      insert into enterprise_profile
        (user_id,tenant_key,login_name,backend_username,display_name,notification_email)
      values ($1,'tenant','fs84.user','megaui-fs84-user','FS84 User','notify@example.test')
    `, [USER]);
    await pool.query(`
      insert into enterprise_challenges
        (id,scope,deployment_role,local_user_id,identity_id,identity_version,flow_hash,generation,
         code_hmac,hmac_key_id,state,created_at,expires_at,secret_expires_at)
      values ($1,$2,'test',$3,$4,1,$5,1,$6,'fs84-key','expired',$7::timestamptz,$7::timestamptz + interval '300 seconds',$7::timestamptz + interval '300 seconds')
    `, [CHALLENGE, SCOPE, USER, IDENTITY, FLOW_HASH, CODE_HASH, new Date(NOW.getTime() - 86_400_000)]);
  }, 120_000);

  beforeEach(async () => {
    await pool.query("delete from session");
    await pool.query("delete from enterprise_notification_outbox");
    await pool.query("delete from enterprise_login_grants");
    await pool.query("delete from enterprise_jobs");
    await pool.query("delete from enterprise_login_budgets");
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FS-84 fixture teardown failed");
  }, 120_000);

  async function insertGrant(overrides: { recoverUntil?: Date; id?: string; challengeId?: string } = {}): Promise<string> {
    const id = overrides.id ?? GRANT;
    const challengeId = overrides.challengeId ?? CHALLENGE;
    const recoverUntil = overrides.recoverUntil ?? new Date(NOW.getTime() - 1_000);
    const createdAt = new Date(recoverUntil.getTime() - 300_000);
    if (challengeId !== CHALLENGE) {
      await pool.query(`
        insert into enterprise_challenges
          (id,scope,deployment_role,local_user_id,identity_id,identity_version,flow_hash,generation,
           code_hmac,hmac_key_id,state,created_at,expires_at,secret_expires_at)
        values ($1,$2,'test',$3,$4,1,$5,2,$6,'fs84-key','expired',$7::timestamptz,$7::timestamptz + interval '300 seconds',$7::timestamptz + interval '300 seconds')
      `, [challengeId, SCOPE, USER, IDENTITY, `${FLOW_HASH.slice(0, 63)}c`, CODE_HASH, new Date(NOW.getTime() - 86_400_000)]);
    }
    await pool.query(`
      insert into enterprise_login_grants
        (id,challenge_id,scope,deployment_role,local_user_id,identity_id,identity_version,
         auth_epoch,flow_hash,generation,purpose,created_at,recover_until)
      values ($1,$2,$3,'test',$4,$5,1,1,$6,1,'login',$7,$8)
    `, [id, challengeId, SCOPE, USER, IDENTITY, FLOW_HASH, createdAt, recoverUntil]);
    return id;
  }

  async function insertNotification(grantId: string, expiresAt: Date): Promise<void> {
    await pool.query(`
      insert into enterprise_notification_outbox
        (id,grant_id,destination_email,destination_version,recipient_name,login_at,device,source,
         app_name,app_url,locale,state,available_at,expires_at,created_at,updated_at,sent_at)
      values ($1,$2,'notify@example.test','v1','FS84 User',$3,'Browser','192.0.2.*','MegaUI',
        'https://megaui.test','en','sent',$3,$4,$3,$3,$3)
    `, [randomUUID(), grantId, new Date(expiresAt.getTime() - 30 * 24 * 60 * 60 * 1_000), expiresAt]);
  }

  it("removes completed jobs after thirty days, in one bounded page", async () => {
    const old = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1_000);
    await pool.query(`
      insert into enterprise_jobs (id,queue,dedupe_key,payload,state,completed_at,available_at)
      select 'job-' || g::text,'test','dedupe-' || g::text,'{}'::jsonb,'done',$1,$1
        from generate_series(1,101) g
    `, [old]);
    await pool.query(`
      insert into enterprise_jobs (id,queue,dedupe_key,payload,state,completed_at,available_at)
      values ('fresh-job','test','fresh-dedupe','{}'::jsonb,'done',$1,$1)
    `, [NOW]);
    const result = await cleanupEnterpriseRetention(pool, NOW);
    expect(result.jobs).toBe(100);
    expect((await pool.query("select count(*)::int as count from enterprise_jobs where state='done' and completed_at=$1", [old])).rows[0]?.count).toBe(1);
  });

  it("removes expired notifications and anonymous budget buckets", async () => {
    const grantId = await insertGrant();
    await insertNotification(grantId, new Date(NOW.getTime() - 1_000));
    await pool.query(`
      insert into enterprise_login_budgets
        (scope,deployment_role,budget_kind,subject_hash,window_started_at,used,expires_at)
      values ($1,'test','anonymous-ip',$2,$3,1,$4)
    `, [SCOPE, "c".repeat(64), new Date(NOW.getTime() - 61_000), new Date(NOW.getTime() - 1_000)]);
    const result = await cleanupEnterpriseRetention(pool, NOW);
    expect(result.notifications).toBe(1);
    expect(result.budgets).toBe(1);
    expect((await pool.query("select count(*)::int as count from enterprise_notification_outbox")).rows[0]?.count).toBe(0);
    expect((await pool.query("select count(*)::int as count from enterprise_login_budgets")).rows[0]?.count).toBe(0);
  });

  it("removes an orphan grant but preserves a grant referenced by a valid session", async () => {
    const orphan = await insertGrant({ id: GRANT });
    const retainedGrant = await insertGrant({ id: "33333333-3333-4333-8333-333333333333", challengeId: "44444444-4444-4444-8444-444444444444" });
    await pool.query(`
      insert into session
        (id,expires_at,token,created_at,updated_at,user_id,enterprise_grant_id,enterprise_identity_id,auth_epoch,auth_method)
      values ($1,$2,$3,$4,$4,$5,$6,$7,1,'enterprise')
    `, [SESSION, new Date(NOW.getTime() + 60_000), `token-${SESSION}`, NOW, USER, retainedGrant, IDENTITY]);
    const result = await cleanupEnterpriseRetention(pool, NOW);
    expect(result.grants).toBe(1);
    expect((await pool.query("select id from enterprise_login_grants order by id")).rows).toEqual([{ id: retainedGrant }]);
    expect((await pool.query("select enterprise_grant_id from session where id=$1", [SESSION])).rows[0]?.enterprise_grant_id).toBe(retainedGrant);
    expect(orphan).toBe(GRANT);
  });

  it("never removes more than one hundred rows across retention classes", async () => {
    const expired = new Date(NOW.getTime() - 1_000);
    await pool.query(`
      insert into enterprise_login_budgets
        (scope,deployment_role,budget_kind,subject_hash,window_started_at,used,expires_at)
      select $1,'test','anonymous-ip',repeat(md5(g::text),2),$2,1,$3
        from generate_series(1,101) g
    `, [SCOPE, new Date(NOW.getTime() - 61_000), expired]);
    const result = await cleanupEnterpriseRetention(pool, NOW);
    expect(result.total).toBe(100);
    expect((await pool.query("select count(*)::int as count from enterprise_login_budgets")).rows[0]?.count).toBe(1);
  });

  it("rolls back a failed page so the worker can retry the leased task", async () => {
    const grantId = await insertGrant();
    await insertNotification(grantId, new Date(NOW.getTime() - 1_000));
    await pool.query(`
      create function fs84_retention_failure() returns trigger language plpgsql as $$
      begin raise exception 'fs84 synthetic cleanup failure'; end $$;
      create trigger fs84_retention_failure before delete on enterprise_notification_outbox
      for each row execute function fs84_retention_failure()
    `);
    try {
      await expect(cleanupEnterpriseRetention(pool, NOW)).rejects.toThrow("fs84 synthetic cleanup failure");
    } finally {
      await pool.query("drop trigger fs84_retention_failure on enterprise_notification_outbox; drop function fs84_retention_failure()");
    }
    expect((await pool.query("select count(*)::int as count from enterprise_notification_outbox")).rows[0]?.count).toBe(1);
  });

  it("keeps only current and previous UTC day in the derived subject cache", () => {
    const cache = createAnonymousIpSubjectCache(new Uint8Array(32).fill(7));
    const jan31 = NOW.getTime();
    const feb1 = jan31 + 24 * 60 * 60 * 1_000;
    const feb2 = feb1 + 24 * 60 * 60 * 1_000;
    cache(SCOPE, "test", "192.0.2.1", jan31);
    cache(SCOPE, "test", "192.0.2.2", jan31);
    expect(cache.size()).toBe(2);
    cache(SCOPE, "test", "192.0.2.3", feb1);
    expect(cache.size()).toBe(3);
    cache(SCOPE, "test", "192.0.2.4", feb2);
    expect(cache.size()).toBe(2);
  });

  it("schedules one hourly successor through the registered retention handler", async () => {
    const slot = enterpriseRetentionSlot(NOW).toISOString();
    await scheduleEnterpriseRetentionJob(pool, { scheduledFor: slot });
    const job = (await pool.query<EnterpriseJob>(
      "update enterprise_jobs set state='leased',claim_owner='fs84',lease_until=$1 where queue=$2 returning id,queue,payload",
      [new Date(NOW.getTime() + 30_000), ENTERPRISE_RETENTION_QUEUE],
    )).rows[0]!;
    await createEnterpriseRetentionJobHandler({ pool, now: () => NOW })(job);
    const rows = (await pool.query("select queue,payload->>'scheduledFor' as scheduled from enterprise_jobs where queue=$1 order by created_at", [ENTERPRISE_RETENTION_QUEUE])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.some(row => row.scheduled === new Date(NOW.getTime() - (NOW.getTime() % (60 * 60 * 1_000)) + 60 * 60 * 1_000).toISOString())).toBe(true);
  });
});
