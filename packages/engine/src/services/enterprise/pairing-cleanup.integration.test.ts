// megaui-only (FS-11): leased retention cleanup uses only this suite's owned PostgreSQL.
import { createHash, randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { createPairingCleanup } from "./pairing-cleanup";
import type { EnterpriseJob } from "./jobs";

const expectation = { processRole: "test", ownerFingerprint: "megaui", instanceId: "fs11-cleanup", environment: "test" } as const;
const context = () => ({ claimOwner: "fs11-cleaner", signal: new AbortController().signal });
const hash = () => createHash("sha256").update(randomUUID()).digest("hex");
async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("FS-11 fixture cleanup deadline")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

describe("leased pairing retention cleanup (FS-11)", () => {
  let isolated: IsolatedPostgres; let pool: Pool;
  const cancelBackend = async (pid: number) => {
    const control = new Client({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000, statement_timeout: 1000 });
    control.on("error", () => {});
    try { await control.connect(); await control.query("select pg_cancel_backend($1::int)", [pid]); }
    finally { await control.end(); }
  };
  const cleanup = () => createPairingCleanup({ pool, expectation, authMode: "enterprise", cancelBackend });
  async function leasedJob(): Promise<EnterpriseJob> {
    const handler = cleanup(); await handler.schedule();
    return (await pool.query<EnterpriseJob>(`update enterprise_jobs set state='leased',claim_owner=$1,lease_until=clock_timestamp()+interval '30 seconds'
      where queue=$2 and state='pending' returning id,queue,payload`, [context().claimOwner, handler.queue])).rows[0]!;
  }
  async function expired(count: number, role = "test"): Promise<void> {
    await pool.query(`with clock as materialized (select clock_timestamp() as t)
      insert into enterprise_pairings (id,scope,deployment_role,tenant_key,app_id,flow_hash,generation,token_hash,created_at,expires_at,retain_until)
      select gen_random_uuid(),$1,$2,'tenant','app',repeat(md5($3||g::text),2),1,repeat(md5($4||g::text),2),
        clock.t-interval '121 seconds',clock.t-interval '1 second',clock.t-interval '1 second'
      from generate_series(1,$5::int) g cross join clock`, [expectation.instanceId, role, hash(), hash(), count]);
  }
  const counts = async () => (await pool.query(`select
    (select count(*)::int from enterprise_pairings where deployment_role='test') as own,
    (select count(*)::int from enterprise_pairings where deployment_role='canary') as other,
    (select count(*)::int from enterprise_jobs) as jobs`)).rows[0];
  beforeAll(async () => {
    isolated = await createIsolatedPostgres(); await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000, statement_timeout: 3000, query_timeout: 3000 });
    pool.on("error", () => {});
    await pool.query(`insert into enterprise_policy (id,scope,owner_fingerprint,deployment_role,environment,activation_state,auth_epoch)
      values ('fs11-cleanup','fs11-cleanup','megaui','test','test','enterprise',1);
      insert into "user" (id,name,email,email_verified) values ('fs11-cleanup-user','Synthetic','fs11-cleanup@example.test',false);
      insert into enterprise_identity (id,local_user_id,tenant_key,app_id,open_id)
      values ('fs11-cleanup-identity','fs11-cleanup-user','tenant','app','open-cleanup')`);
  }, 120_000);
  beforeEach(async () => { await pool.query("delete from enterprise_jobs; delete from enterprise_challenges; delete from enterprise_pairings"); });
  afterAll(async () => {
    const errors: unknown[] = [];
    // A leaked borrower must fail teardown without preventing destruction of the owned database.
    try { if (pool) await bounded(pool.end(), 5000); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FS-11 cleanup fixture teardown failed");
  }, 120_000);

  it("creates one durable root across restarts and deletes only one ordered page in its fixed role", async () => {
    await expired(150); await expired(20, "canary"); const handler = cleanup();
    await Promise.all([handler.schedule(), cleanup().schedule()]);
    const firstPage = (await pool.query(`select id from enterprise_pairings where deployment_role='test' order by retain_until,id limit 100`)).rows.map(row => row.id);
    const job = await leasedJob(); await handler.handle(job, context());
    expect(await counts()).toEqual({ own: 50, other: 20, jobs: 2 });
    expect((await pool.query("select count(*)::int as count from enterprise_pairings where id=any($1::uuid[])", [firstPage])).rows[0]?.count).toBe(0);
    const successor = (await pool.query("select available_at <= clock_timestamp() as due from enterprise_jobs where id<>$1", [job.id])).rows[0];
    expect(successor?.due).toBe(true);
    await handler.schedule(); expect((await counts()).jobs).toBe(2);
  });

  it("uses a single atomic successor and does not delete a second page on replay", async () => {
    await expired(150); const job = await leasedJob(); const handler = cleanup();
    await handler.handle(job, context()); await handler.handle(job, context());
    expect(await counts()).toEqual({ own: 50, other: 0, jobs: 2 });
  });

  it("schedules a partial page from current DB time instead of catching up old empty slots", async () => {
    await expired(2); const job = await leasedJob();
    await pool.query("update enterprise_jobs set available_at='2000-01-01' where id=$1", [job.id]);
    await cleanup().handle(job, context());
    const row = (await pool.query("select extract(epoch from available_at-clock_timestamp())::double precision as delay from enterprise_jobs where id<>$1", [job.id])).rows[0];
    expect(row.delay).toBeGreaterThan(58); expect(row.delay).toBeLessThanOrEqual(60);
    expect(await counts()).toEqual({ own: 0, other: 0, jobs: 2 });
  });

  it("requires the live lease owner and refuses absent, expired or aborted contexts", async () => {
    await expired(2); const job = await leasedJob(); const handler = cleanup();
    await expect(handler.handle(job)).rejects.toThrow("ENTERPRISE_PAIRING_CLEANUP_UNAVAILABLE");
    await expect(handler.handle(job, { ...context(), claimOwner: "other" })).rejects.toThrow("ENTERPRISE_PAIRING_CLEANUP_UNAVAILABLE");
    await expect(handler.handle(job, { ...context(), signal: AbortSignal.abort() })).rejects.toThrow("ENTERPRISE_PAIRING_CLEANUP_UNAVAILABLE");
    await pool.query("update enterprise_jobs set lease_until=clock_timestamp()-interval '1 second'");
    await expect(handler.handle(job, context())).rejects.toThrow("ENTERPRISE_PAIRING_CLEANUP_UNAVAILABLE");
    expect(await counts()).toEqual({ own: 2, other: 0, jobs: 1 });
  });

  it("rejects malformed payload or another fixed target before deleting", async () => {
    await expired(2); const job = await leasedJob();
    for (const payload of [{ ...job.payload, scope: "other" }, { ...job.payload, deploymentRole: "production" },
      { ...job.payload, scheduledFor: "not-a-date" }, { ...job.payload, token: "must-not-enter" }]) {
      await expect(cleanup().handle({ ...job, payload }, context())).rejects.toThrow("ENTERPRISE_PAIRING_CLEANUP_UNAVAILABLE");
    }
    await pool.query("update enterprise_policy set owner_fingerprint='other'");
    try { await expect(cleanup().handle(job, context())).rejects.toThrow("ENTERPRISE_PAIRING_CLEANUP_UNAVAILABLE"); }
    finally { await pool.query("update enterprise_policy set owner_fingerprint='megaui'"); }
    expect(await counts()).toEqual({ own: 2, other: 0, jobs: 1 });
  });

  it("rolls back deleted rows when successor insertion fails", async () => {
    await expired(2); const job = await leasedJob();
    await pool.query(`create function fs11_successor_failure() returns trigger language plpgsql as $$begin raise exception 'synthetic successor failure'; end$$;
      create trigger fs11_successor_failure before insert on enterprise_jobs for each row execute function fs11_successor_failure()`);
    try { await expect(cleanup().handle(job, context())).rejects.toThrow("ENTERPRISE_PAIRING_CLEANUP_UNAVAILABLE"); }
    finally { await pool.query("drop trigger fs11_successor_failure on enterprise_jobs; drop function fs11_successor_failure()"); }
    expect(await counts()).toEqual({ own: 2, other: 0, jobs: 1 });
    await cleanup().handle(job, context()); expect(await counts()).toEqual({ own: 0, other: 0, jobs: 2 });
  });

  it("keeps confirmed rows through their 390-second retention and only nulls the challenge FK afterward", async () => {
    const oldId = randomUUID(); const retainedId = randomUUID(); const challengeId = randomUUID();
    await pool.query(`with clock as materialized (select clock_timestamp() as t), rows(id,age) as (values ($1::uuid,500),($2::uuid,200))
      insert into enterprise_pairings (id,scope,deployment_role,tenant_key,app_id,flow_hash,generation,token_hash,
        intended_identity_id,state,confirmed_identity_version,confirmed_message_id,confirmed_at,created_at,expires_at,retain_until)
      select id,'fs11-cleanup','test','tenant','app',repeat(md5(id::text),2),1,repeat(md5('token'||id::text),2),
        'fs11-cleanup-identity','confirmed',1,id::text,clock.t-((age-1)*interval '1 second'),clock.t-(age*interval '1 second'),
        clock.t-((age-120)*interval '1 second'),clock.t-((age-391)*interval '1 second') from rows cross join clock`, [oldId, retainedId]);
    await pool.query(`insert into enterprise_challenges
      (id,scope,deployment_role,local_user_id,identity_id,identity_version,flow_hash,generation,pairing_id,code_hmac,hmac_key_id,created_at,expires_at,secret_expires_at)
      select $1,scope,deployment_role,'fs11-cleanup-user',intended_identity_id,1,flow_hash,1,id,$3,'synthetic-key',
        confirmed_at,confirmed_at+interval '300 seconds',confirmed_at+interval '300 seconds' from enterprise_pairings where id=$2`,
    [challengeId, oldId, hash()]);
    const before = (await pool.query("select * from enterprise_challenges where id=$1", [challengeId])).rows[0];
    const job = await leasedJob(); await cleanup().handle(job, context());
    expect((await pool.query("select id from enterprise_pairings")).rows).toEqual([{ id: retainedId }]);
    expect((await pool.query("select * from enterprise_challenges where id=$1", [challengeId])).rows[0]).toEqual({ ...before, pairing_id: null });
  });

  it("makes concurrent delivery of the same lease idempotent across handler instances", async () => {
    await expired(150); const job = await leasedJob();
    await Promise.all([cleanup().handle(job, context()), cleanup().handle(job, context())]);
    expect(await counts()).toEqual({ own: 50, other: 0, jobs: 2 });
  });

  it("skips externally locked rows and lets the successor recover them", async () => {
    await expired(150); const job = await leasedJob(); const blocker = await pool.connect();
    try {
      await blocker.query("begin");
      const held = (await blocker.query("select id from enterprise_pairings order by retain_until,id limit 20 for update")).rows.map(row => row.id);
      await cleanup().handle(job, context());
      expect((await pool.query("select count(*)::int as count from enterprise_pairings where id=any($1::uuid[])", [held])).rows[0]?.count).toBe(20);
      expect((await counts()).own).toBe(50);
      await blocker.query("rollback");
      const next = await leasedJob(); await cleanup().handle(next, context());
      expect((await counts()).own).toBe(0);
    } finally { await blocker.query("rollback"); blocker.release(); }
  });

  it("rechecks lease time after a slow delete and rolls the page back when it expired", async () => {
    await expired(2); const job = await leasedJob();
    await pool.query(`create function fs11_slow_delete() returns trigger language plpgsql as $$begin perform pg_sleep(0.7); return null; end$$;
      create trigger fs11_slow_delete after delete on enterprise_pairings for each statement execute function fs11_slow_delete()`);
    try {
      await pool.query("update enterprise_jobs set lease_until=clock_timestamp()+interval '500 milliseconds' where id=$1", [job.id]);
      const pending = cleanup().handle(job, context()).then(() => null, error => error);
      await vi.waitFor(async () => expect((await pool.query("select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event='PgSleep'")).rows[0]?.count).toBe(1));
      expect(await pending).toEqual(Error("ENTERPRISE_PAIRING_CLEANUP_UNAVAILABLE"));
      expect(await counts()).toEqual({ own: 2, other: 0, jobs: 1 });
    } finally { await pool.query("drop trigger fs11_slow_delete on enterprise_pairings; drop function fs11_slow_delete()"); }
  });

  it("aborts a blocked single-connection page using an independent cancellation connection", async () => {
    await expired(2); const job = await leasedJob();
    const url = new URL(isolated.databaseUrl);
    url.searchParams.set("options", "-c statement_timeout=0 -c lock_timeout=0"); url.searchParams.set("query_timeout", "0");
    const candidate = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 1000 }); candidate.on("error", () => {});
    const controller = new AbortController();
    const errors: unknown[] = [];
    let blocker: PoolClient | undefined; let pending: Promise<unknown> | undefined;
    try {
      // URL query_timeout is a string: "0" starts a near-zero timer in pg. Bound only
      // this fixture probe; the production handler still receives the hostile URL.
      const probe = { text: "select pg_backend_pid()::int as pid", query_timeout: 3000 };
      const pid = (await candidate.query(probe)).rows[0]?.pid;
      blocker = await pool.connect();
      await blocker.query("begin"); await blocker.query("lock table enterprise_pairings in access exclusive mode");
      const started = performance.now();
      pending = createPairingCleanup({ pool: candidate, expectation, authMode: "enterprise", cancelBackend })
        .handle(job, { claimOwner: context().claimOwner, signal: controller.signal }).then(() => null, error => error);
      await vi.waitFor(async () => expect((await pool.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type).toBe("Lock"), { interval: 10 });
      controller.abort();
      expect(await pending).toEqual(Error("ENTERPRISE_PAIRING_CLEANUP_UNAVAILABLE"));
      await vi.waitFor(async () => expect((await pool.query("select count(*)::int as count from pg_stat_activity where pid=$1", [pid])).rows[0]?.count).toBe(0));
      expect(performance.now() - started).toBeLessThan(5000);
      await blocker.query("rollback"); expect(await counts()).toEqual({ own: 2, other: 0, jobs: 1 });
    } catch (error) { errors.push(error); }
    finally {
      controller.abort();
      // Keep the external lock until the aborted operation settles, including assertion failures.
      try { if (pending) await bounded(pending, 6000); } catch (error) { errors.push(error); }
      if (blocker) {
        try { await blocker.query("rollback"); } catch (error) { errors.push(error); }
        try { blocker.release(true); } catch (error) { errors.push(error); }
      }
      try { await bounded(candidate.end(), 5000); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "FS-11 blocked cleanup test failed");
  }, 20_000);
});
