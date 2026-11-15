// megaui-only (FS-11): actual standard worker processes, owned DML role, real clock and backlog.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { createOwnedWorkerDatabase } from "./enterprise-pairing";

const root = resolve(__dirname, "../../../..");
const scope = "fs11-process";
const pause = (ms: number) => new Promise<void>(resolveWait => setTimeout(resolveWait, ms));
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("FS-11 process deadline")), ms); })]); }
  finally { clearTimeout(timer); }
}
interface WorkerRun {
  child: ChildProcess;
  output: string;
  pid?: number;
  closed: boolean;
  exited: Promise<number>;
}

describe("standard scoped pairing worker (FS-11)", () => {
  let isolated: IsolatedPostgres; let admin: Pool; let workerUrl: string; let role: string;
  const workers = new Set<WorkerRun>();
  function launch(overrides: Record<string, string | undefined> = {}, scoped = true): WorkerRun {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", DATABASE_URL: workerUrl, AUTH_MODE: scoped ? "enterprise" : "legacy" };
    for (const name of ["ENTERPRISE_PROCESS_ROLE", "ENTERPRISE_OWNER_FINGERPRINT", "ENTERPRISE_DB_INSTANCE_ID", "ENTERPRISE_DEPLOYMENT_ROLE", "ENTERPRISE_APPROVED_TARGETS"]) delete env[name];
    if (scoped) Object.assign(env, { ENTERPRISE_PROCESS_ROLE: "worker", ENTERPRISE_OWNER_FINGERPRINT: "megaui",
      ENTERPRISE_DB_INSTANCE_ID: scope, ENTERPRISE_DEPLOYMENT_ROLE: "test" });
    for (const [name, value] of Object.entries(overrides)) { if (value === undefined) delete env[name]; else env[name] = value; }
    const child = spawn("pnpm", ["--filter", "@megaui/engine", "run", "enterprise:worker"], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    const run: WorkerRun = { child, output: "", closed: false, exited: Promise.resolve(-1) };
    const collect = (chunk: Buffer) => {
      run.output += chunk.toString();
      const match = /enterprise worker \S+ pid (\d+) (?:starting|started)/.exec(run.output);
      if (match) run.pid = Number(match[1]);
    };
    child.stdout?.on("data", collect); child.stderr?.on("data", collect);
    run.exited = new Promise(resolveExit => {
      child.once("error", () => { run.output += "\nFS11_CHILD_SPAWN_FAILED\n"; });
      child.once("close", code => { run.closed = true; resolveExit(code ?? -1); });
    });
    workers.add(run); return run;
  }
  async function started(run: WorkerRun): Promise<void> {
    await vi.waitFor(() => { expect(run.closed, run.output).toBe(false); expect(run.output, run.output).toMatch(/ pid \d+ started\n/); }, { timeout: 20_000, interval: 25 });
  }
  async function noBackends(): Promise<void> {
    await vi.waitFor(async () => expect((await admin.query("select count(*)::int as count from pg_stat_activity where usename=$1", [role])).rows[0]?.count).toBe(0), { timeout: 5000, interval: 25 });
  }
  async function stop(run: WorkerRun): Promise<void> {
    expect(run.pid, run.output).toBeTypeOf("number");
    const at = performance.now(); process.kill(run.pid!, "SIGTERM");
    expect(await within(run.exited, 10_000), run.output).toBe(0);
    expect(performance.now() - at).toBeLessThan(10_000);
    expect(run.output).toContain("stopped"); await noBackends();
  }
  async function seedExpired(count: number, target = scope, deploymentRole = "test"): Promise<void> {
    const nonce = randomBytes(8).toString("hex");
    await admin.query(`with clock as materialized (select clock_timestamp() as t)
      insert into enterprise_pairings (id,scope,deployment_role,tenant_key,app_id,flow_hash,generation,token_hash,created_at,expires_at,retain_until)
      select gen_random_uuid(),$1,$2,'tenant','app',repeat(md5($3||g::text),2),1,repeat(md5('token'||$3||g::text),2),
        clock.t-interval '120.2 seconds',clock.t-interval '0.2 seconds',clock.t-interval '0.2 seconds'
      from generate_series(1,$4::int) g cross join clock`, [target, deploymentRole, nonce, count]);
  }
  beforeAll(async () => {
    isolated = await createIsolatedPostgres(); await isolated.migrate();
    admin = new Pool({ connectionString: isolated.databaseUrl }); admin.on("error", () => {});
    expect((await admin.query("select current_database() as db")).rows[0]?.db).toBe(isolated.databaseName);
    role = `fs11_worker_${randomBytes(6).toString("hex")}`; const password = randomBytes(20).toString("hex");
    await admin.query(`create role "${role}" login password '${password}'; grant usage on schema public to "${role}";
      grant select,insert,update,delete on all tables in schema public to "${role}"`);
    const url = new URL(isolated.databaseUrl); url.username = role; url.password = password; workerUrl = url.toString();
    expect(url.hostname).toBe("127.0.0.1");
    await admin.query(`insert into enterprise_policy (id,scope,owner_fingerprint,deployment_role,environment,activation_state,auth_epoch)
      values ($1,$1,'megaui','worker','test','enterprise',1),('fs11-other','fs11-other','megaui','worker','test','legacy',0)`, [scope]);
  }, 120_000);
  beforeEach(async () => {
    await admin.query("delete from enterprise_jobs; delete from enterprise_event_inbox; delete from enterprise_pairings");
    await admin.query("update enterprise_policy set activation_state='enterprise',auth_epoch=1,owner_fingerprint='megaui' where scope=$1", [scope]);
  });
  afterEach(async () => {
    let forced = false;
    for (const run of workers) {
      if (!run.closed) {
        try { if (run.pid) process.kill(run.pid, "SIGTERM"); await within(run.exited, 10_000); }
        catch {
          forced = true;
          if (run.child.pid) { try { process.kill(-run.child.pid, "SIGKILL"); } catch { /* Already gone. */ } }
          await within(run.exited, 5000);
        }
      }
    }
    workers.clear(); await noBackends();
    if (forced) throw Error("FS-11 worker required forced fixture cleanup");
  }, 20_000);
  afterAll(async () => {
    const errors: unknown[] = [];
    try { await admin?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FS-11 process fixture cleanup failed");
  }, 120_000);

  it.each([
    { ENTERPRISE_PROCESS_ROLE: undefined }, { ENTERPRISE_PROCESS_ROLE: "web" },
    { ENTERPRISE_OWNER_FINGERPRINT: undefined }, { ENTERPRISE_DB_INSTANCE_ID: undefined },
    { ENTERPRISE_DEPLOYMENT_ROLE: undefined }, { ENTERPRISE_DEPLOYMENT_ROLE: "unknown" },
    { ENTERPRISE_APPROVED_TARGETS: "" }, { AUTH_MODE: "maintenance", ENTERPRISE_DB_INSTANCE_ID: undefined },
    { ENTERPRISE_OWNER_FINGERPRINT: "foreign" }, { ENTERPRISE_DB_INSTANCE_ID: "unknown-target" },
  ])("rejects missing/foreign worker authority %s before queue writes", async overrides => {
    const run = launch(overrides); expect(await within(run.exited, 15_000), run.output).toBe(1);
    expect(run.output).not.toMatch(/ pid \d+ started\n/);
    expect((await admin.query("select count(*)::int as count from enterprise_jobs")).rows[0]?.count).toBe(0);
  }, 20_000);

  it("refuses a DDL-capable role and an activated target without a scope", async () => {
    const elevated = launch({ DATABASE_URL: isolated.databaseUrl }); expect(await within(elevated.exited, 15_000), elevated.output).toBe(1);
    const unscoped = launch({}, false); expect(await within(unscoped.exited, 15_000), unscoped.output).toBe(1);
    expect((await admin.query("select count(*)::int as count from enterprise_jobs")).rows[0]?.count).toBe(0);
  }, 35_000);

  it("preserves unscoped legacy operation and supports explicit maintenance without provider config", async () => {
    await admin.query("update enterprise_policy set activation_state='legacy',auth_epoch=0 where scope=$1", [scope]);
    const legacy = launch({}, false); await started(legacy); await stop(legacy);
    expect((await admin.query("select count(*)::int as count from enterprise_jobs where queue like 'enterprise.pairing-cleanup:%'")).rows[0]?.count).toBe(0);
    await seedExpired(3);
    const maintenance = launch({ AUTH_MODE: "maintenance" }); await started(maintenance);
    await vi.waitFor(async () => expect((await admin.query("select count(*)::int as count from enterprise_pairings")).rows[0]?.count).toBe(0), { timeout: 5000 });
    await stop(maintenance);
  }, 35_000);

  it("closes the other pool when one of the two startup connections fails", async () => {
    await admin.query(`alter role "${role}" connection limit 1`);
    try {
      const run = launch(); expect(await within(run.exited, 15_000), run.output).toBe(1); await noBackends();
      expect((await admin.query("select count(*)::int as count from enterprise_jobs")).rows[0]?.count).toBe(0);
    } finally { await admin.query(`alter role "${role}" connection limit -1`); }
  }, 20_000);

  it("stops both lanes when a running claim loop loses SQL permission", async () => {
    const run = launch(); await started(run);
    await admin.query(`revoke select on enterprise_jobs from "${role}"`);
    try { expect(await within(run.exited, 15_000), run.output).toBe(1); await noBackends(); }
    finally { await admin.query(`grant select on enterprise_jobs to "${role}"`); }
  }, 25_000);

  it("SIGTERM cancels a blocked cleanup lane and leaves no later delete or successor", async () => {
    await seedExpired(10); const blocker = await admin.connect();
    try {
      await blocker.query("begin"); await blocker.query("lock table enterprise_pairings in access exclusive mode");
      const run = launch(); await started(run);
      await vi.waitFor(async () => expect((await admin.query(`select count(*)::int as count from pg_stat_activity
        where usename=$1 and application_name like 'megaui-cleanup-%' and wait_event_type='Lock'`, [role])).rows[0]?.count).toBe(1), { timeout: 5000, interval: 20 });
      await stop(run); await blocker.query("rollback");
      await pause(150);
      expect((await admin.query("select count(*)::int as count from enterprise_pairings")).rows[0]?.count).toBe(10);
      expect((await admin.query("select count(*)::int as count from enterprise_jobs where queue like 'enterprise.pairing-cleanup:%'")).rows[0]?.count).toBe(1);
    } finally { await blocker.query("rollback"); blocker.release(); }
  }, 30_000);

  it("enforces real session limits despite URL and PGOPTIONS overrides", async () => {
    const url = new URL(workerUrl);
    url.searchParams.set("options", "-c statement_timeout=0 -c lock_timeout=0");
    url.searchParams.set("statement_timeout", "0"); url.searchParams.set("query_timeout", "0");
    url.searchParams.set("connectionTimeoutMillis", "0"); url.searchParams.set("application_name", "untrusted-name");
    vi.stubEnv("PGOPTIONS", "-c statement_timeout=0 -c lock_timeout=0");
    const owned = createOwnedWorkerDatabase(url.toString(), "cleanup");
    try {
      const row = (await owned.pool.query(`select current_setting('statement_timeout') as statement,
        current_setting('lock_timeout') as lock,current_setting('application_name') as application,
        has_schema_privilege(current_user,'public','CREATE') as ddl`)).rows[0];
      expect(row).toMatchObject({ statement: "3s", lock: "1s", ddl: false }); expect(row.application).toMatch(/^megaui-cleanup-/);
      expect(owned.pool.options.connectionTimeoutMillis).toBe(1000);
    } finally { vi.unstubAllEnvs(); await owned.close(); }
  });

  it("collects native socket close evidence when a connection never finishes its PG handshake", async () => {
    const sockets = new Set<net.Socket>(); let accepted = 0; let closed = 0;
    const server = net.createServer(socket => {
      accepted += 1; sockets.add(socket); socket.on("error", () => {});
      socket.resume(); // Consume startup bytes so the peer's FIN can be observed.
      socket.once("close", () => { closed += 1; sockets.delete(socket); });
    });
    await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
    const port = (server.address() as net.AddressInfo).port;
    const owned = createOwnedWorkerDatabase(`postgres://synthetic:synthetic@127.0.0.1:${port}/owned?connectionTimeoutMillis=0`, "cleanup");
    const pending = owned.pool.connect().then(client => { client.release(true); return "unexpected"; }, () => "rejected");
    try {
      await vi.waitFor(() => expect(accepted).toBe(1));
      const first = owned.close(); expect(owned.close()).toBe(first); await within(first, 2000);
      expect(await pending).toBe("rejected"); await vi.waitFor(() => expect(closed).toBe(1));
    } finally {
      try { await owned.close(); }
      finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); }
    }
  }, 5000);

  it("cancels a retired backend after a client-side query timeout has already removed its socket", async () => {
    const blocker = await admin.connect(); const owned = createOwnedWorkerDatabase(workerUrl);
    try {
      await blocker.query("begin"); await blocker.query("lock table enterprise_jobs in access exclusive mode");
      const query = { text: "select count(*) from enterprise_jobs", query_timeout: 100 };
      const pending = owned.pool.query(query).then(() => "unexpected", () => "rejected");
      await vi.waitFor(async () => expect((await admin.query(`select count(*)::int as count from pg_stat_activity
        where usename=$1 and application_name like 'megaui-ordinary-%' and wait_event_type='Lock'`, [role])).rows[0]?.count).toBe(1), { interval: 10 });
      expect(await pending).toBe("rejected"); expect(owned.pool.totalCount).toBe(0);
      await within(owned.close(), 3000); await noBackends(); // The external lock is still held.
    } finally { await blocker.query("rollback"); blocker.release(); await owned.close(); }
  }, 10_000);

  it("waits for the other lane's cancellation when one control connection reports failure", async () => {
    await seedExpired(10);
    // Isolated DB fault: ordinary cancellation fails, cleanup cancellation is delayed.
    await admin.query(`alter role "${role}" set search_path=public,pg_catalog;
      create function public.pg_cancel_backend(integer) returns boolean language plpgsql as $$begin
        if exists(select 1 from pg_catalog.pg_stat_activity where pid=$1 and application_name like 'megaui-ordinary-%')
          then raise exception 'synthetic cancellation failure'; end if;
        perform pg_catalog.pg_sleep(0.25); return pg_catalog.pg_cancel_backend($1); end$$`);
    const blocker = await admin.connect();
    try {
      await blocker.query("begin"); await blocker.query("lock table enterprise_event_inbox,enterprise_pairings in access exclusive mode");
      const run = launch(); await started(run);
      await vi.waitFor(async () => expect((await admin.query(`select count(distinct split_part(application_name,'-',2))::int as count
        from pg_stat_activity where usename=$1 and application_name ~ '^megaui-(ordinary|cleanup)-' and wait_event_type='Lock'`, [role])).rows[0]?.count).toBe(2), { timeout: 5000, interval: 10 });
      const at = performance.now(); process.kill(run.pid!, "SIGTERM");
      expect(await within(run.exited, 10_000), run.output).toBe(1);
      expect(performance.now() - at).toBeLessThan(10_000);
      expect(run.output).toContain("ENTERPRISE_WORKER_SHUTDOWN_FAILED");
      // Inspect at process close, before the fixture unlocks or kills a failed ordinary backend.
      expect((await admin.query(`select count(*)::int as count from pg_stat_activity
        where usename=$1 and application_name like 'megaui-cleanup-%'`, [role])).rows[0]?.count).toBe(0);
    } finally {
      await admin.query("select pg_catalog.pg_terminate_backend(pid) from pg_stat_activity where usename=$1", [role]);
      await blocker.query("rollback"); blocker.release();
      await admin.query(`drop function public.pg_cancel_backend(integer); alter role "${role}" reset search_path`);
    }
  }, 20_000);

  it("keeps the process deadline active while the final stdout callback is blocked", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "megaui-fs11-output-"));
    const preload = resolve(directory, "blocked-output.cjs");
    // Exercise the standard command with only its final output callback faulted.
    await writeFile(preload, `const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = function(chunk, ...args) {
        if (/^enterprise worker \\S+ stopped\\n$/.test(String(chunk))) return false;
        return write(chunk, ...args);
      };\n`);
    try {
      const run = launch({ NODE_OPTIONS: `--require=${preload}` }); await started(run);
      const at = performance.now(); process.kill(run.pid!, "SIGTERM");
      expect(await within(run.exited, 10_000), run.output).toBe(1);
      expect(performance.now() - at).toBeLessThan(10_000);
      expect(run.output).toContain("ENTERPRISE_WORKER_SHUTDOWN_FAILED"); await noBackends();
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);

  it("cleans a real 10000-row backlog within five minutes alongside old slow ordinary work and continuous new expiries", async () => {
    await seedExpired(10_000); await seedExpired(100_000, "fs11-other"); await seedExpired(1000, scope, "canary");
    const earliest = (await admin.query("select min(retain_until) as expiry from enterprise_pairings where scope=$1 and deployment_role='test'", [scope])).rows[0]?.expiry;
    await admin.query(`insert into enterprise_event_inbox (id,tenant_key,app_id,event_id,event_type,event_created_at,subject_open_id)
      select 'fs11-event-'||g,'tenant','app','fs11-event-'||g,'contact.user.updated_v3',now()-interval '30 days','synthetic-open-'||g from generate_series(1,1000) g;
      insert into enterprise_jobs (id,queue,dedupe_key,payload,available_at)
      select gen_random_uuid()::text,'enterprise.verified-event','verified-event:'||id,jsonb_build_object('inboxId',id),'2000-01-01'
      from enterprise_event_inbox;
      create function fs11_slow_ordinary() returns trigger language plpgsql as $$begin
        if NEW.queue='enterprise.contact-event-hint' then perform pg_sleep(0.4); end if; return NEW; end$$;
      create trigger fs11_slow_ordinary before insert on enterprise_jobs for each row execute function fs11_slow_ordinary()`);
    let producer: Promise<void> | undefined; let producing = true;
    try {
      const run = launch(); await started(run);
      await vi.waitFor(async () => expect((await admin.query(`select count(*)::int as count from pg_stat_activity
        where usename=$1 and application_name like 'megaui-ordinary-%' and wait_event='PgSleep'`, [role])).rows[0]?.count).toBeGreaterThan(0), { timeout: 5000 });
      let added = 0;
      producer = (async () => { for (let i = 0; i < 30 && producing; i += 1) { await seedExpired(10); added += 10; await pause(100); } })();
      await producer;
      await vi.waitFor(async () => {
        expect(run.closed, run.output).toBe(false);
        expect((await admin.query("select count(*)::int as count from enterprise_pairings where scope=$1 and deployment_role='test'", [scope])).rows[0]?.count).toBe(0);
      }, { timeout: 290_000, interval: 100 });
      const elapsed = Number((await admin.query("select extract(epoch from clock_timestamp()-$1::timestamptz)*1000 as elapsed", [earliest])).rows[0]?.elapsed);
      expect(added).toBe(300); expect(elapsed).toBeLessThanOrEqual(300_000);
      const backlog = (await admin.query("select count(*)::int as count from enterprise_jobs where queue='enterprise.verified-event' and state<>'done'")).rows[0]?.count;
      expect(backlog).toBeGreaterThan(0);
      expect((await admin.query("select count(*)::int as count from enterprise_pairings where scope='fs11-other'")).rows[0]?.count).toBe(100_000);
      expect((await admin.query("select count(*)::int as count from enterprise_pairings where scope=$1 and deployment_role='canary'", [scope])).rows[0]?.count).toBe(1000);
      console.info(`FS-11 real worker SLA: initial=10000 added=${added} other=101000 elapsed_ms=${elapsed.toFixed(1)} ordinary_backlog=${backlog}`);
      await stop(run);
    } finally {
      producing = false; await producer;
      for (const run of workers) if (!run.closed && run.pid) { process.kill(run.pid, "SIGTERM"); await within(run.exited, 10_000); }
      await admin.query("drop trigger fs11_slow_ordinary on enterprise_jobs; drop function fs11_slow_ordinary()");
    }
  }, 330_000);
});
