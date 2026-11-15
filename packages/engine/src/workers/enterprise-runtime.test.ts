// FS-07：独立 worker 进程生命周期。
//
// The suite drives the runtime against a one-shot Postgres of FS-57 and
// proves the seven acceptance criteria of the card, including the standalone
// process that starts from the standard command and stops on SIGTERM.
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CLAIM_BATCH_LIMIT,
  DATABASE_OPERATION_TIMEOUT_MS,
  EnterpriseWorkerRuntime,
  HANDLER_CONCURRENCY,
  JOB_RETRY_BASE_DELAY_MS,
  JOB_RETRY_MAX_DELAY_MS,
  LEASE_SECONDS,
} from "./enterprise";
import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "@megaui/database/test-support";

const dockerAvailable = await isDockerAvailable();

if (!dockerAvailable) {
  throw new Error(
    "[@megaui/engine] enterprise-runtime.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

const REPO_ROOT = resolve(__dirname, "../../../..");

let isolated: IsolatedPostgres;
let pool: Pool;
let counter = 0;

async function insertJobs(count: number, state = "pending"): Promise<void> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    counter += 1;
    const id = `job-${counter}`;
    ids.push(id);
    await pool.query(
      `insert into "enterprise_jobs" (id, queue, dedupe_key, state, available_at)
       values ($1, 'noop', $2, $3, now())`,
      [id, `dedupe-${counter}`, state],
    );
  }
}

async function stateOf(
  id: string,
): Promise<{ state: string; claim_owner: string | null } | undefined> {
  const result = await pool.query<{ state: string; claim_owner: string | null }>(
    `select state, claim_owner from "enterprise_jobs" where id = $1`,
    [id],
  );
  return result.rows[0];
}

describe("standalone enterprise worker runtime (FS-07)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
  }, 120_000);

  beforeEach(async () => {
    // Every case starts from an empty queue of its own.
    await pool.query(`delete from "enterprise_jobs"`);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (isolated) await isolated.destroy();
  }, 120_000);

  it("claims one batch of at most one hundred jobs", async () => {
    await insertJobs(CLAIM_BATCH_LIMIT + 50);
    const runtime = new EnterpriseWorkerRuntime({
      connectionString: isolated.databaseUrl,
      handlers: { noop: async () => undefined },
    });
    try {
      const claimed = await runtime.runOnce();
      expect(claimed).toBe(CLAIM_BATCH_LIMIT);
      const remaining = await pool.query<{ count: number }>(
        `select count(*)::int as count from "enterprise_jobs" where state = 'pending'`,
      );
      expect(remaining.rows[0]?.count).toBe(50);
    } finally {
      await runtime.stop();
    }
  });

  it("gives one lease exactly one owner", async () => {
    await insertJobs(10);
    // The handler observes the owner of the row while it holds the lease.
    const owners = new Map<string, string[]>();
    const handler =
      (workerId: string) =>
      async (job: { id: string }): Promise<void> => {
        const seen = owners.get(job.id) ?? [];
        seen.push(workerId);
        owners.set(job.id, seen);
        await new Promise((done) => setTimeout(done, 10));
      };
    const first = new EnterpriseWorkerRuntime({
      connectionString: isolated.databaseUrl,
      handlers: { noop: handler("worker-a") },
      workerId: "worker-a",
    });
    const second = new EnterpriseWorkerRuntime({
      connectionString: isolated.databaseUrl,
      handlers: { noop: handler("worker-b") },
      workerId: "worker-b",
    });
    try {
      const [claimedByFirst, claimedBySecond] = await Promise.all([
        first.runOnce(),
        second.runOnce(),
      ]);
      // The two workers together claimed every job exactly once.
      expect(claimedByFirst + claimedBySecond).toBe(10);
      expect(owners.size).toBe(10);
      for (const seen of owners.values()) expect(seen).toHaveLength(1);
      // Every job finished exactly once.
      const done = await pool.query<{ count: number }>(
        `select count(*)::int as count from "enterprise_jobs" where state = 'done'`,
      );
      expect(done.rows[0]?.count).toBe(10);
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  it("takes over a job whose thirty second lease expired", async () => {
    await insertJobs(1, "leased");
    const expired = await pool.query<{ id: string }>(
      `select id from "enterprise_jobs" where state = 'leased' limit 1`,
    );
    const id = expired.rows[0]?.id ?? "";
    await pool.query(
      `update "enterprise_jobs"
          set claim_owner = 'crashed-worker', lease_until = now() - interval '5 seconds'
        where id = $1`,
      [id],
    );

    const runtime = new EnterpriseWorkerRuntime({
      connectionString: isolated.databaseUrl,
      handlers: { noop: async () => undefined },
    });
    try {
      expect(LEASE_SECONDS).toBe(30);
      expect(await runtime.runOnce()).toBe(1);
      const state = await stateOf(id);
      expect(state?.state).toBe("done");
    } finally {
      await runtime.stop();
    }
  });

  it("backs off persistent failures and keeps the job pending for recovery", async () => {
    await insertJobs(1);
    const id = `job-${counter}`;
    const runtime = new EnterpriseWorkerRuntime({
      connectionString: isolated.databaseUrl,
      handlers: {
        noop: async () => {
          throw new Error("persistent downstream failure");
        },
      },
    });
    try {
      expect(await runtime.runOnce()).toBe(1);
      const firstRetry = await pool.query<{
        state: string;
        claim_owner: string | null;
        attempts: number;
        available_at: Date;
      }>(
        `select state, claim_owner, attempts, available_at
           from "enterprise_jobs" where id = $1`,
        [id],
      );
      expect(firstRetry.rows[0]).toMatchObject({
        state: "pending",
        claim_owner: null,
        attempts: 1,
      });
      const firstDelay = firstRetry.rows[0]!.available_at.getTime() - Date.now();
      expect(firstDelay).toBeGreaterThan(JOB_RETRY_BASE_DELAY_MS - 500);
      expect(firstDelay).toBeLessThanOrEqual(JOB_RETRY_BASE_DELAY_MS + 1_000);
      expect(await runtime.runOnce()).toBe(0);

      await pool.query(
        `update "enterprise_jobs"
            set attempts = 100, available_at = now()
          where id = $1`,
        [id],
      );
      expect(await runtime.runOnce()).toBe(1);
      const cappedRetry = await pool.query<{
        state: string;
        attempts: number;
        available_at: Date;
      }>(
        `select state, attempts, available_at
           from "enterprise_jobs" where id = $1`,
        [id],
      );
      expect(cappedRetry.rows[0]).toMatchObject({ state: "pending", attempts: 101 });
      const cappedDelay = cappedRetry.rows[0]!.available_at.getTime() - Date.now();
      expect(cappedDelay).toBeGreaterThan(JOB_RETRY_MAX_DELAY_MS - 1_000);
      expect(cappedDelay).toBeLessThanOrEqual(JOB_RETRY_MAX_DELAY_MS + 1_000);
    } finally {
      await runtime.stop();
    }
  });

  it("stops claiming at once after a shutdown request", async () => {
    await insertJobs(5);
    const runtime = new EnterpriseWorkerRuntime({
      connectionString: isolated.databaseUrl,
      handlers: { noop: async () => undefined },
    });
    await runtime.stop();
    expect(await runtime.runOnce()).toBe(0);
    // The runtime's own pool is released with the shutdown; the shared pool
    // of the suite still reads the queue.
    const pending = await pool.query<{ count: number }>(
      `select count(*)::int as count from "enterprise_jobs" where state = 'pending'`,
    );
    expect(pending.rows[0]?.count).toBeGreaterThan(0);
  });

  it("bounds the handler concurrency", async () => {
    await insertJobs(12);
    let active = 0;
    let maxActive = 0;
    const runtime = new EnterpriseWorkerRuntime({
      connectionString: isolated.databaseUrl,
      handlers: {
        noop: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((done) => setTimeout(done, 20));
          active -= 1;
        },
      },
    });
    try {
      await runtime.runOnce();
      expect(maxActive).toBeLessThanOrEqual(HANDLER_CONCURRENCY);
      expect(maxActive).toBeGreaterThan(1);
    } finally {
      await runtime.stop();
    }
  });

  // FS-11: bounded runtime options and shutdown apply to both owned worker lanes.
  it.each([
    { concurrency: 0 }, { concurrency: 5 }, { concurrency: 1.5 },
    { claimBatchLimit: 0 }, { claimBatchLimit: 101 }, { claimBatchLimit: NaN },
  ])("FS-11 rejects invalid worker bounds %s before running", async bounds => {
    let runtime: EnterpriseWorkerRuntime | undefined;
    try {
      expect(() => { runtime = new EnterpriseWorkerRuntime({ connectionString: isolated.databaseUrl,
        handlers: { noop: async () => undefined }, ...bounds }); }).toThrow("INVALID_ENTERPRISE_WORKER_CONFIG");
    } finally { await runtime?.stop(); }
  });

  it("FS-11 honors a dedicated 1-handler/2-claim lane and passes lease ownership", async () => {
    await insertJobs(8); let active = 0; let peak = 0; const owners: string[] = [];
    const runtime = new EnterpriseWorkerRuntime({ connectionString: isolated.databaseUrl, concurrency: 1, claimBatchLimit: 2,
      workerId: "fs11-dedicated", handlers: { noop: async (_job, lease) => {
        expect(lease?.signal.aborted).toBe(false); owners.push(lease?.claimOwner ?? "missing");
        active += 1; peak = Math.max(peak, active);
        await new Promise(resolveWait => setTimeout(resolveWait, 10)); active -= 1;
      } } });
    try {
      expect(await runtime.runOnce()).toBe(2); expect(peak).toBe(1);
      expect(owners).toEqual(["fs11-dedicated", "fs11-dedicated"]);
      expect((await pool.query("select count(*)::int as count from enterprise_jobs where state='pending'")).rows[0]?.count).toBe(6);
    } finally { await runtime.stop(); }
  });

  it("FS-11 returns the same shutdown promise and stops dispatching the claimed queue", async () => {
    await insertJobs(8); let start!: () => void; let finish!: () => void; let handled = 0;
    const started = new Promise<void>(resolveStart => { start = resolveStart; });
    const gate = new Promise<void>(resolveFinish => { finish = resolveFinish; });
    const runtime = new EnterpriseWorkerRuntime({ connectionString: isolated.databaseUrl, concurrency: 1,
      handlers: { noop: async (_job, lease) => {
        handled += 1; start(); await gate; expect(lease?.signal.aborted).toBe(true);
      } } });
    const running = runtime.runOnce().catch(() => undefined);
    try {
      await started; const first = runtime.stop(); const second = runtime.stop();
      expect(first).toBe(second); finish(); await first; await running;
      expect(handled).toBe(1); expect(await runtime.runOnce()).toBe(0);
    } finally { finish(); await runtime.stop(); await running; }
  });

  it("cancels a blocked startup schedule and exits cleanly on SIGTERM", async () => {
    const locker = await pool.connect();
    let child: ChildProcess | undefined;
    let workerPid: number | undefined;
    let output = "";
    try {
      await locker.query("begin");
      await locker.query(`lock table "enterprise_jobs" in access exclusive mode`);
      child = spawn("pnpm", ["--filter", "@megaui/engine", "run", "enterprise:worker"], {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: isolated.databaseUrl, NODE_ENV: "test" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      await new Promise<void>((resolveStarting, reject) => {
        const timer = setTimeout(
          () => reject(new Error("the worker did not enter startup")),
          30_000,
        );
        child?.stdout?.on("data", (chunk: Buffer) => {
          output += String(chunk);
          const match = /enterprise worker \S+ pid (\d+) starting/.exec(output);
          if (match) {
            workerPid = Number(match[1]);
            clearTimeout(timer);
            resolveStarting();
          }
        });
        child?.stderr?.on("data", (chunk: Buffer) => {
          output += String(chunk);
        });
        child?.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`the worker exited during startup with ${code}`));
        });
      });

      let startupBackendPid: number | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const blocked = await pool.query<{ pid: number }>(
          `select pid
             from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and state = 'active'
              and wait_event_type = 'Lock'
              and query like '%insert into "enterprise_jobs"%'
            limit 1`,
        );
        if (blocked.rows[0]) {
          startupBackendPid = blocked.rows[0].pid;
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      expect(startupBackendPid, output).toBeTypeOf("number");
      expect(workerPid).toBeTypeOf("number");

      const closed = new Promise<number>((resolveClose) => {
        const timer = setTimeout(() => resolveClose(-1), 10_000);
        child?.once("close", (code) => {
          clearTimeout(timer);
          resolveClose(code ?? -1);
        });
      });
      const signalStartedAt = Date.now();
      if (workerPid !== undefined) process.kill(workerPid, "SIGTERM");
      expect(await closed, output).toBe(0);
      let blockedBackends = 1;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const cancelled = await pool.query<{ count: number }>(
          `select count(*)::int as count
             from pg_stat_activity
            where pid = $1
              and state = 'active'
              and wait_event_type = 'Lock'`,
          [startupBackendPid ?? -1],
        );
        blockedBackends = cancelled.rows[0]?.count ?? 0;
        if (blockedBackends === 0) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      expect(blockedBackends).toBe(0);
      expect(Date.now() - signalStartedAt).toBeLessThan(
        DATABASE_OPERATION_TIMEOUT_MS / 2,
      );
      expect(output).toContain("starting");
      expect(output).not.toContain(" started\n");
      expect(output).toContain("stopped");
    } finally {
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group already exited.
        }
      }
      try {
        await locker.query("rollback");
      } finally {
        locker.release();
      }
    }
  }, 45_000);

  it("starts the standalone process with the standard command and stops it on SIGTERM", async () => {
    let child: ChildProcess | undefined;
    let workerPid: number | undefined;
    let output = "";
    try {
      // The standard package command starts the process.
      child = spawn("pnpm", ["--filter", "@megaui/engine", "run", "enterprise:worker"], {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: isolated.databaseUrl, NODE_ENV: "test" },
        stdio: ["ignore", "pipe", "pipe"],
        // Keep the wrapper and all descendants in a group so the fallback
        // cleanup can still remove every process owned by this test.
        detached: true,
      });
      const started = await new Promise<string>((resolveStarted, reject) => {
        const timer = setTimeout(() => reject(new Error("the worker did not start")), 30_000);
        child?.stdout?.on("data", (chunk: Buffer) => {
          output += String(chunk);
          const match = /enterprise worker \S+ pid (\d+) started/.exec(output);
          if (match) {
            workerPid = Number(match[1]);
            clearTimeout(timer);
            resolveStarted(output);
          }
        });
        child?.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`the worker exited early with ${code}`));
        });
      });
      expect(started).toContain("enterprise worker");
      expect(workerPid).toBeTypeOf("number");

      // Signal the actual worker instead of its package-manager wrapper. This
      // proves that the entry handles SIGTERM and lets the standard command
      // observe its clean exit on both macOS and Linux.
      const closed = await new Promise<number>((resolveClose) => {
        const timer = setTimeout(() => resolveClose(-1), 10_000);
        // `close` follows `exit` only after the child's stdio streams close, so
        // every lifecycle line forwarded by pnpm is present before assertions.
        child?.once("close", (code) => {
          clearTimeout(timer);
          resolveClose(code ?? -1);
        });
        if (workerPid !== undefined) process.kill(workerPid, "SIGTERM");
      });
      expect(closed, output).toBe(0);
      expect(output).toContain("stopped");
    } finally {
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group already exited.
        }
      }
    }
  }, 45_000);
});
