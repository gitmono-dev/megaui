// megaui-only (FS-74): anonymous budgets use only this suite's isolated PostgreSQL.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { createAnonymousPairingBudget } from "./anonymous-budget";
import type { AnonymousBudgetAlert, AnonymousPairingBudgetOptions, AnonymousPendingContext } from "./anonymous-budget-types";
import { anonymousBudgetLockKey, chargeAnonymousIp } from "./anonymous-budget-store";
import { anonymousIpSubjects, canonicalAnonymousIp, createAnonymousIpResolver } from "./anonymous-ip";

const flow = () => createHash("sha256").update(randomUUID()).digest("hex");
const expectation = { processRole: "test", ownerFingerprint: "megaui", instanceId: "fs74", environment: "test" } as const;
const master = new Uint8Array(32).fill(41);
const limited = { kind: "rate-limited", status: 429, code: "RATE_LIMITED" };
const request = (peerAddress = "192.0.2.1", flowHash = flow()) => ({ transport: { peerAddress }, flowHash });

async function createPending(context: Readonly<AnonymousPendingContext>): Promise<string> {
  const id = randomUUID();
  await context.client.query(`insert into enterprise_pairings
    (id,scope,deployment_role,tenant_key,app_id,flow_hash,generation,token_hash,created_at,expires_at,retain_until)
    values ($1,$2,$3,'tenant','app',$4,1,$5,$6,$7,$7)`,
  [id,context.scope,context.deploymentRole,context.flowHash,flow(),new Date(context.nowMs),new Date(context.nowMs + 120_000)]);
  return id;
}

describe("anonymous pairing budget (FS-74)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  const options = (overrides: Partial<AnonymousPairingBudgetOptions> = {}): AnonymousPairingBudgetOptions =>
    ({ pool, expectation, proxyCidrs: [], ipHmacMaster: master, alert: () => undefined, ...overrides });
  const service = (overrides: Partial<AnonymousPairingBudgetOptions> = {}) => createAnonymousPairingBudget(options(overrides));
  const totals = async () => (await pool.query(`select
    (select count(*)::int from enterprise_pairings) as pairings,
    (select coalesce(sum(used),0)::int from enterprise_login_budgets where budget_kind='anonymous-ip') as charges`)).rows[0];

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000 });
    pool.on("error", () => {});
    await pool.query(`insert into enterprise_policy
      (id,scope,owner_fingerprint,deployment_role,environment,activation_state,auth_epoch)
      values ('fs74','fs74','megaui','test','test','enterprise',1)`);
  }, 120_000);

  beforeEach(async () => {
    await pool.query("delete from enterprise_pairings; delete from enterprise_login_budgets");
  });
  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FS-74 fixture cleanup failed");
  }, 120_000);

  it("commits one pending and its IP charge on the same transaction", async () => {
    const service = createAnonymousPairingBudget({ pool, expectation, proxyCidrs: [],
      ipHmacMaster: new Uint8Array(32).fill(41), alert: () => undefined });
    const result = await service.run({ transport: { peerAddress: "192.0.2.1" }, flowHash: flow() }, createPending);
    expect(result.kind).toBe("accepted");
    expect((await pool.query("select count(*)::int as count from enterprise_pairings")).rows[0]?.count).toBe(1);
    expect((await pool.query("select sum(used)::int as used from enterprise_login_budgets")).rows[0]?.used).toBe(1);
  });

  it("serializes two instances at 30 requests and never writes rejected IP events", async () => {
    const other = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000 });
    const alerts: AnonymousBudgetAlert[] = [];
    try {
      const first = service({ alert: event => { alerts.push(event); } });
      const second = service({ pool: other, alert: event => { alerts.push(event); } });
      const results = [];
      // Small simultaneous waves keep this test about database serialization, not pool queue timeouts.
      for (let i = 0; i < 8; i++) results.push(...await Promise.all([
        first.run(request(), createPending), second.run(request(), createPending),
        first.run(request(), createPending), second.run(request(), createPending),
      ]));
      expect(results.filter(result => result.kind === "accepted")).toHaveLength(30);
      expect(results.filter(result => result.kind !== "accepted")).toEqual([limited, limited]);
      expect(await totals()).toEqual({ pairings: 30, charges: 30 });
      expect(alerts.map(event => event.reason)).toEqual(["ip", "ip"]);
    } finally { await other.end(); }
  });

  it("keeps the current and previous UTC day in one strict rolling window, including same-ms events", async () => {
    const client = await pool.connect();
    const midnight = Date.parse("2026-11-12T00:00:00.000Z");
    const charge = (at: number) => chargeAnonymousIp({ client, scope: "fs74", deploymentRole: "test", flowHash: flow(), nowMs: at },
      anonymousIpSubjects(master, "fs74", "test", "192.0.2.1", at));
    try {
      await client.query("begin");
      for (let i = 0; i < 29; i++) expect(await charge(midnight - 1)).toBe(true);
      expect(await charge(midnight)).toBe(true);
      expect(await charge(midnight + 1)).toBe(false);
      expect((await client.query("select used from enterprise_login_budgets order by window_started_at")).rows).toEqual([{ used: 29 }, { used: 1 }]);
      expect(await charge(midnight + 599_998)).toBe(false);
      // Exactly T-600s is excluded. Old rows remain physically present.
      expect(await charge(midnight + 599_999)).toBe(true);
      expect((await client.query("select count(*)::int as count from enterprise_login_budgets")).rows[0]?.count).toBe(3);
      await client.query("rollback");
    } finally { client.release(); }
  });

  it("does not count future, other-role, other-IP or non-anonymous budget rows", async () => {
    const at = Date.parse("2026-11-12T12:00:00Z");
    const subjects = anonymousIpSubjects(master, "fs74", "test", "192.0.2.1", at);
    await pool.query(`insert into enterprise_login_budgets
      (scope,deployment_role,budget_kind,subject_hash,window_started_at,used,expires_at) values
      ('fs74','test','anonymous-ip',$1,$3::timestamptz+interval '1 second',30,$3::timestamptz+interval '601 seconds'),
      ('fs74','canary','anonymous-ip',$1,$3,30,$3::timestamptz+interval '600 seconds'),
      ('fs74','test','anonymous-ip',$2,$3,30,$3::timestamptz+interval '600 seconds'),
      ('fs74','test','verify-failure',$1,$3,30,$3::timestamptz+interval '600 seconds')`, [subjects[0], flow(), new Date(at)]);
    const client = await pool.connect();
    try {
      await client.query("begin");
      expect(await chargeAnonymousIp({ client, scope: "fs74", deploymentRole: "test", flowHash: flow(), nowMs: at }, subjects)).toBe(true);
      await client.query("rollback");
    } finally { client.release(); }
  });

  it("allows only one same-flow winner while charging both callers", async () => {
    const input = request();
    const results = await Promise.all([service().run(input, createPending), service().run(input, createPending)]);
    expect(results.filter(result => result.kind === "accepted")).toHaveLength(1);
    expect(results.find(result => result.kind !== "accepted")).toEqual(limited);
    expect(await totals()).toEqual({ pairings: 1, charges: 2 });
  });

  it("counts uncleared expired pending rows and serializes the 9999/10000 capacity boundary", async () => {
    await pool.query(`insert into enterprise_pairings
      (id,scope,deployment_role,tenant_key,app_id,flow_hash,generation,token_hash,created_at,expires_at,retain_until)
      select gen_random_uuid(),'fs74','test','tenant','app',lpad(n::text,64,'0'),1,lpad(n::text,64,'0'),
        '2026-01-01T00:00:00Z'::timestamptz,'2026-01-01T00:02:00Z'::timestamptz,'2026-01-01T00:02:00Z'::timestamptz
      from generate_series(1,9999) n`);
    const alerts: AnonymousBudgetAlert[] = [];
    const budget = service({ alert: event => { alerts.push(event); } });
    const results = await Promise.all([budget.run(request(), createPending), service().run(request(), createPending)]);
    expect(results.filter(result => result.kind === "accepted")).toHaveLength(1);
    expect(results.find(result => result.kind !== "accepted")).toEqual(limited);
    expect(await totals()).toEqual({ pairings: 10000, charges: 2 });
    const callback = vi.fn(createPending);
    expect(await budget.run(request(), callback)).toEqual(limited);
    expect(callback).not.toHaveBeenCalled();
    expect(alerts.at(-1)?.reason).toBe("capacity");
    expect(await totals()).toEqual({ pairings: 10000, charges: 3 });
  });

  it("expires only the target flow before allowing its next pending generation", async () => {
    const input = request();
    expect((await service().run(input, createPending)).kind).toBe("accepted");
    await pool.query(`update enterprise_pairings set created_at=created_at-interval '1 day',
      expires_at=expires_at-interval '1 day',retain_until=retain_until-interval '1 day'`);
    const callback = async (context: Readonly<AnonymousPendingContext>) => {
      const id = await createPending({ ...context, flowHash: flow() });
      await context.client.query("update enterprise_pairings set flow_hash=$1,generation=2 where id=$2", [context.flowHash, id]);
      return id;
    };
    expect((await service().run(input, callback)).kind).toBe("accepted");
    expect((await pool.query("select state from enterprise_pairings order by generation")).rows).toEqual([{ state: "expired" }, { state: "pending" }]);
  });

  it.each(["throw", "wrong-id", "wrong-flow", "wrong-time", "SQL"])("rolls back the charge and pending for callback failure: %s", async mode => {
    const result = await service().run(request(), async context => {
      const id = await createPending(mode === "wrong-flow" ? { ...context, flowHash: flow() }
        : mode === "wrong-time" ? { ...context, nowMs: context.nowMs - 1 } : context);
      if (mode === "throw") throw new Error("secret IP 192.0.2.1 and token");
      if (mode === "SQL") await context.client.query("select nonexistent_fs74_column");
      return mode === "wrong-id" ? randomUUID() : id;
    });
    expect(result).toEqual({ kind: "unavailable" });
    expect(await totals()).toEqual({ pairings: 0, charges: 0 });
    expect(pool.totalCount).toBe(pool.idleCount);
  });

  it("reports no success when COMMIT fails and destroys that connection", async () => {
    await pool.query(`create function fs74_commit_failure() returns trigger language plpgsql as $$
      begin raise exception 'private SQL detail'; end $$;
      create constraint trigger fs74_commit_failure after insert on enterprise_pairings
      deferrable initially deferred for each row execute function fs74_commit_failure()`);
    try {
      expect(await service().run(request(), createPending)).toEqual({ kind: "unavailable" });
      expect(await totals()).toEqual({ pairings: 0, charges: 0 });
    } finally { await pool.query("drop trigger fs74_commit_failure on enterprise_pairings; drop function fs74_commit_failure()"); }
    expect((await service().run(request(), createPending)).kind).toBe("accepted");
  });

  it("uses database time after the global lock, ignoring the application wall clock", async () => {
    const blocker = await pool.connect();
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [anonymousBudgetLockKey("fs74", "test")]);
    let observed = 0;
    vi.spyOn(Date, "now").mockReturnValue(1);
    const pending = service().run(request(), async context => { observed = context.nowMs; return createPending(context); });
    try {
      // Wait for a real lock waiter, not an assumed scheduling delay.
      await vi.waitFor(async () => expect((await pool.query("select count(*)::int as count from pg_locks where locktype='advisory' and not granted")).rows[0]?.count).toBe(1));
      const lowerBound = Number((await blocker.query("select floor(extract(epoch from clock_timestamp())*1000) as t")).rows[0]?.t);
      await blocker.query("commit");
      expect((await pending).kind).toBe("accepted");
      expect(observed).toBeGreaterThanOrEqual(lowerBound);
    } finally { await blocker.query("rollback"); blocker.release(); }
  });

  it("fails closed on wrong target, owner and excess SQL role without any charge", async () => {
    for (const target of [ { ...expectation, instanceId: "missing" }, { ...expectation, ownerFingerprint: "other" },
      { ...expectation, environment: "canary" }, { ...expectation, processRole: "web" as const } ]) {
      expect(await service({ expectation: target }).run(request(), createPending)).toEqual({ kind: "unavailable" });
    }
    expect(await totals()).toEqual({ pairings: 0, charges: 0 });
  });

  it("uses READ COMMITTED even when the borrowed connection defaults to an older snapshot", async () => {
    const configured = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000,
      options: "-c default_transaction_isolation=repeatable\\ read" });
    try {
      expect((await configured.query("show default_transaction_isolation")).rows[0]?.default_transaction_isolation).toBe("repeatable read");
      const result = await service({ pool: configured }).run(request(), async context => {
        expect((await context.client.query("show transaction_isolation")).rows[0]?.transaction_isolation).toBe("read committed");
        return createPending(context);
      });
      expect(result.kind).toBe("accepted");
    } finally { await configured.end(); }
  });

  it("rejects invalid trusted configuration and unsupported pool implementations", async () => {
    for (const override of [ { ipHmacMaster: new Uint8Array(31) }, { ipHmacMaster: new Uint8Array(1025) },
      { expectation: { ...expectation, instanceId: "" } }, { expectation: { ...expectation, environment: "unknown" } },
      { expectation: { ...expectation, approvedBootstrapTargets: [] } }, { proxyCidrs: ["bad"] } ]) {
      expect(() => service(override)).toThrow("INVALID_ANONYMOUS_BUDGET_CONFIG");
    }
    class CustomPool extends Pool {}
    const custom = new CustomPool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000 });
    try { expect(() => service({ pool: custom })).toThrow("INVALID_ANONYMOUS_BUDGET_CONFIG"); }
    finally { await custom.end(); }
  });

  it("bounds a full pool acquisition and leaves no waiting queue or lost caller connection", async () => {
    const small = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000, max: 1 });
    const held = await small.connect();
    try {
      const started = performance.now();
      expect(await service({ pool: small }).run(request(), createPending)).toEqual({ kind: "unavailable" });
      expect(performance.now() - started).toBeLessThan(1800);
      await vi.waitFor(() => expect(small.waitingCount).toBe(0));
      expect((await held.query("select 1 as alive")).rows[0]?.alive).toBe(1);
    } finally { held.release(); await small.end(); }
  });

  it("bounds lock waits, rolls back the run, and permits a later request", async () => {
    const candidate = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000, max: 1 });
    const originalPid = (await candidate.query("select pg_backend_pid() as pid")).rows[0]?.pid;
    const blocker = await pool.connect();
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [anonymousBudgetLockKey("fs74", "test")]);
    try {
      const started = performance.now();
      expect(await service({ pool: candidate }).run(request(), createPending)).toEqual({ kind: "unavailable" });
      expect(performance.now() - started).toBeLessThan(2000);
      expect(candidate.totalCount).toBe(0);
      await vi.waitFor(async () => expect((await pool.query("select count(*)::int as count from pg_stat_activity where pid=$1", [originalPid])).rows[0]?.count).toBe(0));
      expect(await totals()).toEqual({ pairings: 0, charges: 0 });
      await blocker.query("rollback");
      expect((await service({ pool: candidate }).run(request(), createPending)).kind).toBe("accepted");
      expect((await candidate.query("select pg_backend_pid() as pid")).rows[0]?.pid).not.toBe(originalPid);
    } finally { await blocker.query("rollback"); blocker.release(); await candidate.end(); }
  });

  it("destroys the client when the server times out first, even if the callback catches that error", async () => {
    const candidate = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000, max: 1 });
    const originalPid = (await candidate.query("select pg_backend_pid() as pid")).rows[0]?.pid;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    let lateError: unknown;
    try {
      expect(await service({ pool: candidate }).run(request(), async context => {
        try {
          await createPending(context);
          // A stricter server deadline wins deterministically over the port's timer.
          await context.client.query("set local statement_timeout='20ms'");
          try { await context.client.query("select pg_sleep(1)"); } catch { /* Deliberately swallowed. */ }
          try { await context.client.query("select 1"); } catch (error) { lateError = error; }
          return randomUUID();
        } finally { finish(); }
      })).toEqual({ kind: "unavailable" });
      await done;
      expect(lateError).toEqual(new Error("ANONYMOUS_BUDGET_UNAVAILABLE"));
      expect(candidate.totalCount).toBe(0);
      await vi.waitFor(async () => expect((await pool.query("select count(*)::int as count from pg_stat_activity where pid=$1", [originalPid])).rows[0]?.count).toBe(0));
      expect(await totals()).toEqual({ pairings: 0, charges: 0 });
      expect((await service({ pool: candidate }).run(request(), createPending)).kind).toBe("accepted");
      expect((await candidate.query("select pg_backend_pid() as pid")).rows[0]?.pid).not.toBe(originalPid);
    } finally { await candidate.end(); }
  });

  it("destroys a long SQL connection and rolls back its already-created pending", async () => {
    const started = performance.now();
    expect(await service().run(request(), async context => {
      const id = await createPending(context);
      await context.client.query("select pg_sleep(10)");
      return id;
    })).toEqual({ kind: "unavailable" });
    expect(performance.now() - started).toBeLessThan(4000);
    await vi.waitFor(async () => expect(await totals()).toEqual({ pairings: 0, charges: 0 }));
  }, 10_000);

  it("poisons the transaction after a driver read timeout even if the callback swallows the error", async () => {
    const candidate = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000,
      query_timeout: 500, max: 1 });
    const originalPid = (await candidate.query("select pg_backend_pid() as pid")).rows[0]?.pid;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    let afterTimeoutError: unknown;
    try {
      const result = await service({ pool: candidate }).run(request(), async context => {
        try {
          try { await context.client.query("select pg_sleep(0.75)"); } catch { /* Deliberately swallowed. */ }
          try { await context.client.query("select 1"); } catch (error) { afterTimeoutError = error; }
          return await createPending(context);
        } finally { finish(); }
      });
      await done;
      expect(result).toEqual({ kind: "unavailable" });
      expect(afterTimeoutError).toEqual(new Error("ANONYMOUS_BUDGET_UNAVAILABLE"));
      expect(candidate.totalCount).toBe(0);
      await vi.waitFor(async () => expect((await pool.query("select count(*)::int as count from pg_stat_activity where pid=$1", [originalPid])).rows[0]?.count).toBe(0));
      expect(await totals()).toEqual({ pairings: 0, charges: 0 });
      expect((await service({ pool: candidate }).run(request(), createPending)).kind).toBe("accepted");
    } finally { await candidate.end(); }
  });

  it("bounds a stalled callback and prevents its late write after the response", async () => {
    let resume!: () => void;
    const pause = new Promise<void>(resolve => { resume = resolve; });
    let lateError: unknown;
    let finished!: () => void;
    const callbackDone = new Promise<void>(resolve => { finished = resolve; });
    const started = performance.now();
    const result = await service().run(request(), async context => {
      await pause;
      try { return await createPending(context); } catch (error) { lateError = error; throw error; }
      finally { finished(); }
    });
    expect(result).toEqual({ kind: "unavailable" });
    expect(performance.now() - started).toBeLessThan(6000);
    resume();
    await callbackDone;
    expect(lateError).toEqual(new Error("ANONYMOUS_BUDGET_UNAVAILABLE"));
    await vi.waitFor(async () => expect(await totals()).toEqual({ pairings: 0, charges: 0 }));
    expect((await service().run(request(), createPending)).kind).toBe("accepted");
  }, 10_000);

  it("copies the key, expectation and CIDRs and rejects malformed input before acquiring", async () => {
    const key = Uint8Array.from(master);
    const target = { ...expectation };
    const cidrs = ["10.0.0.0/8"];
    const budget = service({ ipHmacMaster: key, expectation: target, proxyCidrs: cidrs });
    key.fill(0); target.instanceId = "changed" as "fs74"; cidrs[0] = "0.0.0.0/0";
    const input = { transport: { peerAddress: "192.0.2.1", forwardedFor: "203.0.113.1" }, flowHash: flow() };
    expect((await budget.run(input, createPending)).kind).toBe("accepted");
    const row = (await pool.query("select subject_hash,window_started_at from enterprise_login_budgets")).rows[0];
    expect(row?.subject_hash).toBe(anonymousIpSubjects(master, "fs74", "test", "192.0.2.1", row?.window_started_at.getTime())[0]);
    expect(await budget.run({ ...input, flowHash: "bad" }, createPending)).toEqual({ kind: "unavailable" });
    expect(await totals()).toEqual({ pairings: 1, charges: 1 });
  });

  it.each([undefined, 0, -1, NaN, 1001, 1.5])("rejects unsupported connection deadline %s before connecting", async timeout => {
    const candidate = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: timeout });
    try {
      expect(() => service({ pool: candidate })).toThrow("INVALID_ANONYMOUS_BUDGET_CONFIG");
      expect(candidate.totalCount).toBe(0);
      candidate.options.connectionTimeoutMillis = 1000;
      expect(() => service({ pool: candidate })).not.toThrow();
    } finally { await candidate.end(); }
  });

  it.each(["onConnect", "verify", "Client", "Promise", "stream", "password", "connect", "acquire"])("rejects acquisition customization %s without invoking it", async key => {
    const candidate = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000 });
    const hook = vi.fn();
    if (key === "connect" || key === "acquire") candidate.on(key, hook);
    else Reflect.set(candidate.options, key, hook);
    try {
      expect(() => service({ pool: candidate })).toThrow("INVALID_ANONYMOUS_BUDGET_CONFIG");
      expect(hook).not.toHaveBeenCalled();
      expect(candidate.totalCount).toBe(0);
    } finally { candidate.removeAllListeners(); await candidate.end(); }
  });

  it("rejects runtime pool mutation and replaced connect with zero acquisition calls", async () => {
    const candidate = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000 });
    const budget = service({ pool: candidate });
    try {
      candidate.options.connectionTimeoutMillis = 0;
      expect(await budget.run(request(), createPending)).toEqual({ kind: "unavailable" });
      candidate.options.connectionTimeoutMillis = 1000;
      const hook = vi.fn();
      Reflect.set(candidate.options, "onConnect", hook);
      expect(await budget.run(request(), createPending)).toEqual({ kind: "unavailable" });
      expect(hook).not.toHaveBeenCalled();
      Reflect.deleteProperty(candidate.options, "onConnect");
      const connect = vi.spyOn(candidate, "connect");
      expect(await budget.run(request(), createPending)).toEqual({ kind: "unavailable" });
      expect(connect).not.toHaveBeenCalled();
      connect.mockRestore();
      expect(candidate.totalCount).toBe(0);
    } finally { await candidate.end(); }
  });

  it("rejects a runtime replacement of the shared Pool.connect prototype before calling it", async () => {
    const candidate = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000 });
    const budget = service({ pool: candidate });
    const connect = vi.spyOn(Pool.prototype, "connect");
    try {
      expect(await budget.run(request(), createPending)).toEqual({ kind: "unavailable" });
      expect(connect).not.toHaveBeenCalled();
      expect(candidate.totalCount).toBe(0);
    } finally { connect.mockRestore(); await candidate.end(); }
  });

  it("rejects a runtime replacement of native Client.connect before calling it", async () => {
    const candidate = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000 });
    const budget = service({ pool: candidate });
    const connect = vi.spyOn(Client.prototype, "connect");
    try {
      expect(await budget.run(request(), createPending)).toEqual({ kind: "unavailable" });
      expect(connect).not.toHaveBeenCalled();
      expect(candidate.totalCount).toBe(0);
    } finally { connect.mockRestore(); await candidate.end(); }
  });

  it("never passes raw IP or forwarding content to SQL and merges mapped address spellings", async () => {
    const sql = vi.spyOn(Client.prototype, "query");
    const budget = service();
    expect((await budget.run(request("192.0.2.1"), createPending)).kind).toBe("accepted");
    expect((await budget.run({ transport: { peerAddress: "::ffff:c000:201", forwardedFor: "private-forged-header" }, flowHash: flow() }, createPending)).kind).toBe("accepted");
    const calls = JSON.stringify(sql.mock.calls);
    expect(calls).not.toContain("192.0.2.1");
    expect(calls).not.toContain("::ffff:c000:201");
    expect(calls).not.toContain("private-forged-header");
    expect((await pool.query("select count(distinct subject_hash)::int as subjects,sum(used)::int as used from enterprise_login_budgets")).rows[0]).toEqual({ subjects: 1, used: 2 });
    expect((await pool.query("select row_to_json(b) as row from enterprise_login_budgets b")).rows.every(row => !JSON.stringify(row).includes("192.0.2.1"))).toBe(true);
  });

  it.each(["throw", "value", "rejected-promise"])("preserves 429 and emits only fixed fallback for invalid alert sink: %s", async mode => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = request();
    expect((await service().run(input, createPending)).kind).toBe("accepted");
    const sink = ((event: AnonymousBudgetAlert) => {
      expect(pool.totalCount).toBe(pool.idleCount);
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.keys(event).sort()).toEqual(["at", "event", "reason", "scopeFingerprint"]);
      if (mode === "throw") throw new Error("192.0.2.1 private");
      return mode === "value" ? "private" : Promise.reject(new Error("private"));
    }) as unknown as AnonymousPairingBudgetOptions["alert"];
    expect(await service({ alert: sink }).run(input, createPending)).toEqual(limited);
    expect(warning.mock.calls).toEqual([["ENTERPRISE_ANONYMOUS_BUDGET_ALERT_UNAVAILABLE"]]);
  });
});

describe("anonymous IP source and privacy (FS-74)", () => {
  it("canonicalizes equivalent IPv6 and mapped IPv4 without zones or ambiguous literals", () => {
    expect(canonicalAnonymousIp("2001:0DB8:0000:0000:0000:0000:0000:0001")?.address).toBe("2001:db8::1");
    expect(canonicalAnonymousIp("::ffff:c000:201")).toEqual(canonicalAnonymousIp("192.0.2.1"));
    for (const raw of ["fe80::1%en0", "[::1]", "[::1]:80", "192.0.2.1:80", " 192.0.2.1", "192.0.2.1\n", "０.0.0.0", "012.0.0.1", "127.1", ""]) {
      expect(canonicalAnonymousIp(raw), raw).toBeNull();
    }
  });

  it("ignores all XFF from untrusted peers and strips only approved proxies from the right", () => {
    const resolve = createAnonymousIpResolver(["10.0.0.0/8", "2001:db8:1::/48"]);
    expect(resolve({ peerAddress: "192.0.2.1", get forwardedFor(): string { throw new Error("must not read"); } })).toBe("192.0.2.1");
    expect(resolve({ peerAddress: "10.0.0.1", forwardedFor: "198.51.100.1, 192.0.2.1, 10.0.0.2" })).toBe("192.0.2.1");
    expect(resolve({ peerAddress: "10.0.0.1", forwardedFor: "10.0.0.2, 10.0.0.3" })).toBe("10.0.0.2");
    expect(resolve({ peerAddress: "10.0.0.1" })).toBe("10.0.0.1");
    for (const raw of ["", "bad,192.0.2.1", "192.0.2.1,", "192.0.2.1\r\n", Array(17).fill("10.0.0.1").join(","), " ".repeat(2049)]) {
      expect(resolve({ peerAddress: "10.0.0.1", forwardedFor: raw })).toBeNull();
    }
  });

  it("keeps IPv4 and IPv6 trust separate and accepts only unambiguous mapped CIDRs", () => {
    expect(createAnonymousIpResolver(["::/0"] )({ peerAddress: "192.0.2.1", forwardedFor: "203.0.113.1" })).toBe("192.0.2.1");
    expect(createAnonymousIpResolver(["::ffff:10.0.0.0/104"] )({ peerAddress: "::ffff:10.0.0.1", forwardedFor: "203.0.113.1" })).toBe("203.0.113.1");
    for (const cidr of ["::ffff:10.0.0.0/95", "10.0.0.0/33", "::/129", "::/+1", "::/01", "::/-1", "fe80::1%x/64", "10.0.0.1", "::/0/1"]) {
      expect(() => createAnonymousIpResolver([cidr]), cidr).toThrow("INVALID_ANONYMOUS_BUDGET_CONFIG");
    }
    expect(() => createAnonymousIpResolver(Array(65).fill("::/0"))).toThrow("INVALID_ANONYMOUS_BUDGET_CONFIG");
  });

  it("matches an independent daily HMAC oracle and separates scope, role and day", () => {
    const at = Date.parse("2026-11-12T00:00:01Z");
    const expected = ["2026-11-12", "2026-11-11"].map(day => {
      const key = createHmac("sha256", master).update(JSON.stringify(["megaui:anonymous-ip:day:v1", "fs74", "test", day])).digest();
      return createHmac("sha256", key).update(JSON.stringify(["megaui:anonymous-ip:subject:v1", "192.0.2.1"])).digest("hex");
    });
    expect(anonymousIpSubjects(master, "fs74", "test", "192.0.2.1", at)).toEqual(expected);
    expect(anonymousIpSubjects(master, "other", "test", "192.0.2.1", at)[0]).not.toBe(expected[0]);
    expect(anonymousIpSubjects(master, "fs74", "canary", "192.0.2.1", at)[0]).not.toBe(expected[0]);
    expect(expected[0]).not.toBe(expected[1]);
  });
});
