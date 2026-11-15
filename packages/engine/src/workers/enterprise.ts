// megaui-only (FS-07): the standalone enterprise worker has no upstream counterpart.
/**
 * FS-07：独立 worker 进程生命周期。
 *
 * The worker runs as its own long-lived process and claims jobs from the
 * leased queue of FS-42 with `FOR UPDATE SKIP LOCKED`: one claim takes at
 * most 100 jobs, one lease has exactly one owner, and a job whose lease
 * expired after a crash is claimed again. Scoped workers split the four
 * handler slots into ordinary 3 + pairing cleanup 1, with separate pools.
 * SIGTERM stops both claim loops and verifies owned database cleanup.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";
import { createPairingCleanup } from "../services/enterprise/pairing-cleanup";
import { preflightEnterpriseWorker, readEnterpriseWorkerConfig, workerDeadline } from "./enterprise-config";
import { createOwnedWorkerDatabase, takeWorkerDatabase, type OwnedWorkerDatabase } from "./enterprise-pairing";

import {
  createDurableVerifiedEventEffects,
  createVerifiedEventJobHandler,
  VERIFIED_EVENT_QUEUE,
  type VerifiedEventEffects,
} from "../services/enterprise/events";
import {
  createEventInboxCleanupJobHandler,
  enterpriseRetentionSlot,
  eventInboxCleanupSlot,
  EVENT_INBOX_CLEANUP_QUEUE,
  ENTERPRISE_RETENTION_QUEUE,
  scheduleEventInboxCleanupJob,
  scheduleEnterpriseRetentionJob,
  type EnterpriseJob,
  type EnterpriseJobHandler,
} from "../services/enterprise/jobs";
import { createEnterpriseRetentionJobHandler } from "../services/enterprise/auth-retention";

/** The lease of a claimed job. */
export const LEASE_SECONDS = 30;
/** The maximum number of jobs of one claim. */
export const CLAIM_BATCH_LIMIT = 100;
/** The maximum number of handlers that run at the same time. */
export const HANDLER_CONCURRENCY = 4;
/** The deadline of a graceful shutdown. */
export const SHUTDOWN_DEADLINE_MS = 10_000;
/** Database work must settle before the process-level shutdown deadline. */
export const DATABASE_OPERATION_TIMEOUT_MS = SHUTDOWN_DEADLINE_MS - 1_000;
/** The pause of the claim loop when the queue is empty. */
const IDLE_PAUSE_MS = 1_000;
/** First retry delay after a handler failure. */
export const JOB_RETRY_BASE_DELAY_MS = 1_000;
/** Persistent failures remain recoverable but run at most once every five minutes. */
export const JOB_RETRY_MAX_DELAY_MS = 5 * 60 * 1_000;

export type ClaimedJob = EnterpriseJob;
export type EnterpriseHandler = EnterpriseJobHandler;

export interface EnterpriseWorkerRuntimeOptions {
  connectionString: string;
  handlers: Record<string, EnterpriseHandler | undefined>;
  /** A fresh factory-owned pool transfers one lifecycle to this runtime exactly once. */
  pool?: Pool;
  workerId?: string;
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
  claimBatchLimit?: number;
}

/** The event and retention handlers registered by the standard worker entry. */
export function createStandardEnterpriseWorkerHandlers(
  pool: Pool,
  effects: VerifiedEventEffects = createDurableVerifiedEventEffects(pool),
): Record<string, EnterpriseHandler> {
  return {
    [VERIFIED_EVENT_QUEUE]: createVerifiedEventJobHandler({ pool, effects }),
    [EVENT_INBOX_CLEANUP_QUEUE]: createEventInboxCleanupJobHandler({ writer: pool }),
    [ENTERPRISE_RETENTION_QUEUE]: createEnterpriseRetentionJobHandler({ pool }),
  };
}

export class EnterpriseWorkerRuntime {
  readonly workerId: string;
  private readonly pool: Pool;
  private readonly database: OwnedWorkerDatabase;
  private readonly handlers: Record<string, EnterpriseHandler | undefined>;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly concurrency: number;
  private readonly claimBatchLimit: number;
  private readonly controller = new AbortController();
  private stopPromise: Promise<void> | undefined;
  private stopping = false;
  private batch: Promise<void> | undefined;
  private claimInFlight: Promise<number> | undefined;
  private startupInFlight: Promise<void> | undefined;

  constructor(options: EnterpriseWorkerRuntimeOptions) {
    this.concurrency = options.concurrency ?? HANDLER_CONCURRENCY;
    this.claimBatchLimit = options.claimBatchLimit ?? CLAIM_BATCH_LIMIT;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4
      || !Number.isInteger(this.claimBatchLimit) || this.claimBatchLimit < 1 || this.claimBatchLimit > 100) {
      throw new Error("INVALID_ENTERPRISE_WORKER_CONFIG");
    }
    this.workerId = options.workerId ?? `worker-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    if (!this.workerId || this.workerId.length > 256) throw new Error("INVALID_ENTERPRISE_WORKER_CONFIG");
    this.handlers = { ...options.handlers };
    this.sleep = options.sleep;
    this.database = takeWorkerDatabase(options.pool ?? createOwnedWorkerDatabase(options.connectionString).pool);
    this.pool = this.database.pool;
  }

  /**
   * Runs one idempotent startup action on a tracked client.
   *
   * A shutdown destroys this client to cancel a blocked startup query. The
   * caller may safely retry the action on the next boot.
   */
  async runStartup(task: (client: PoolClient) => Promise<void>): Promise<void> {
    if (this.stopping) return;
    const work = (async (): Promise<void> => {
      const client = await this.pool.connect();
      if (this.stopping) {
        client.release();
        return;
      }
      try {
        if (this.stopping) return;
        await task(client);
      } finally {
        client.release(this.stopping);
      }
    })();
    this.startupInFlight = work;
    try {
      await work;
    } finally {
      if (this.startupInFlight === work) this.startupInFlight = undefined;
    }
  }

  /** Runs the claim loop until `stop()` is called. */
  async start(): Promise<void> {
    while (!this.stopping) {
      const claimed = await this.runOnce();
      if (claimed === 0 && !this.stopping) await this.waitIdle();
    }
  }

  /**
   * Claims one batch and runs its handlers.
   *
   * The claim stops at once after a shutdown request, so a SIGTERM never
   * waits for the queue.
   */
  async runOnce(): Promise<number> {
    if (this.stopping) return 0;
    if (this.claimInFlight) return this.claimInFlight;
    // The claim and its release are tracked as one unit, so a shutdown that
    // starts during the claim still waits for the release.
    const work = (async (): Promise<number> => {
      const jobs = await this.claim();
      if (this.stopping) {
        // Ownership is sealed on stop; unstarted leases recover after thirty seconds.
        return 0;
      }
      if (jobs.length === 0) return 0;
      await this.handleBatch(jobs);
      return jobs.length;
    })();
    this.claimInFlight = work;
    try {
      return await work;
    } catch (error) {
      if (this.stopping) return 0;
      throw error;
    } finally {
      if (this.claimInFlight === work) this.claimInFlight = undefined;
    }
  }

  /**
   * Stops claiming and releases the pool.
   *
   * The wait for an in-flight claim or batch is bounded by the shutdown
   * deadline, so a hanging handler can never keep the process alive past
   * ten seconds.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.controller.abort();
    const closing = this.database.close();
    const inFlight = [
      this.startupInFlight,
      this.claimInFlight,
      this.batch,
    ].filter(
      (value): value is Promise<void> | Promise<number> => value !== undefined,
    );
    this.stopPromise = workerDeadline(Promise.allSettled([closing,
      ...inFlight.map(value => value.catch(() => undefined))]).then(results => {
      if (results.some(result => result.status === "rejected")) throw new Error("ENTERPRISE_WORKER_SHUTDOWN_FAILED");
    }), SHUTDOWN_DEADLINE_MS - 500);
    return this.stopPromise;
  }

  private waitIdle(): Promise<void> {
    return new Promise((resolveWait, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { clearTimeout(timer); this.controller.signal.removeEventListener("abort", finish); };
      const finish = () => { cleanup(); resolveWait(); };
      this.controller.signal.addEventListener("abort", finish, { once: true });
      if (this.stopping) { finish(); return; }
      if (this.sleep) this.sleep(IDLE_PAUSE_MS).then(finish, error => { cleanup(); reject(error); });
      else timer = setTimeout(finish, IDLE_PAUSE_MS);
    });
  }

  private async claim(): Promise<ClaimedJob[]> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("begin");
      const queues = Object.keys(this.handlers).filter(
        (queue) => typeof this.handlers[queue] === "function",
      );
      if (queues.length === 0) {
        await client.query("commit");
        return [];
      }
      const rows = await client.query<ClaimedJob>(
        `select id, queue, payload from "enterprise_jobs"
           where queue = any($2::text[])
             and ((state = 'pending' and available_at <= now())
               or (state = 'leased' and lease_until < now()))
           order by available_at
           limit $1
           for update skip locked`,
        [this.claimBatchLimit, queues],
      );
      const ids = rows.rows.map((row) => row.id);
      if (ids.length > 0) {
        await client.query(
          `update "enterprise_jobs"
              set state = 'leased', claim_owner = $1,
                  lease_until = now() + interval '${LEASE_SECONDS} seconds',
                  attempts = attempts + 1
            where id = any($2::text[])`,
          [this.workerId, ids],
        );
      }
      await client.query("commit");
      return rows.rows;
    } catch (error) {
      if (!this.stopping) { try { await client.query("rollback"); } catch { /* Original error wins. */ } }
      throw error;
    } finally {
      client.release(this.stopping);
    }
  }

  private async handleBatch(jobs: ClaimedJob[]): Promise<void> {
    const running: Promise<void>[] = [];
    const queue = [...jobs];
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.stopping) return;
        const job = queue.shift();
        if (!job) return;
        await this.handle(job);
      }
    };
    for (let index = 0; index < Math.min(this.concurrency, jobs.length); index += 1) {
      running.push(worker());
    }
    this.batch = Promise.all(running).then(() => undefined);
    await this.batch;
  }

  private async handle(job: ClaimedJob): Promise<void> {
    if (this.stopping) return;
    const handler = this.handlers[job.queue];
    try {
      if (!handler) throw new Error(`no handler for the queue ${job.queue}`);
      await handler(job, { claimOwner: this.workerId, signal: this.controller.signal });
      if (this.stopping) return;
      await this.pool.query(
        `update "enterprise_jobs"
            set state = 'done', completed_at = now(), claim_owner = null, lease_until = null
          where id = $1 and claim_owner = $2`,
        [job.id, this.workerId],
      );
    } catch (error) {
      if (this.stopping) return;
      if (error instanceof Error && ["ENTERPRISE_WORKER_CANCEL_FAILED", "ENTERPRISE_WORKER_SHUTDOWN_FAILED"].includes(error.message)) throw error;
      // Persistent failures remain pending for operator recovery; they are
      // never discarded. A capped exponential delay prevents a hot retry loop.
      await this.pool.query(
        `update "enterprise_jobs"
            set state = 'pending', claim_owner = null, lease_until = null,
                available_at = now() + (
                  least(
                    $3::double precision,
                    $4::double precision * power(
                      2::double precision,
                      least(greatest(attempts - 1, 0), 20)
                    )
                  ) * interval '1 millisecond'
                ),
                updated_at = now()
          where id = $1 and claim_owner = $2`,
        [
          job.id,
          this.workerId,
          JOB_RETRY_MAX_DELAY_MS,
          JOB_RETRY_BASE_DELAY_MS,
        ],
      );
    }
  }
}

/**
 * The entry of the standalone process.
 *
 * The process claims from the queue, stops claiming on SIGTERM or SIGINT, and
 * releases the pool before it exits.
 */
async function main(): Promise<void> {
  const config = readEnterpriseWorkerConfig(process.env);
  const databases: OwnedWorkerDatabase[] = [];
  const runtimes: EnterpriseWorkerRuntime[] = [];
  let ordinary: EnterpriseWorkerRuntime;
  let cleanup: ReturnType<typeof createPairingCleanup> | undefined;
  try {
    const ordinaryDb = createOwnedWorkerDatabase(config.connectionString);
    databases.push(ordinaryDb);
    ordinary = new EnterpriseWorkerRuntime({ connectionString: config.connectionString, pool: ordinaryDb.pool,
      handlers: createStandardEnterpriseWorkerHandlers(ordinaryDb.pool), concurrency: config.expectation ? 3 : 4 });
    runtimes.push(ordinary);
    if (config.expectation) {
      const cleanupDb = createOwnedWorkerDatabase(config.connectionString, "cleanup");
      databases.push(cleanupDb);
      cleanup = createPairingCleanup({ pool: cleanupDb.pool, expectation: config.expectation,
        authMode: config.authMode, cancelBackend: cleanupDb.cancelBackend });
      runtimes.push(new EnterpriseWorkerRuntime({ connectionString: config.connectionString, pool: cleanupDb.pool,
        handlers: { [cleanup.queue]: cleanup.handle }, concurrency: 1, claimBatchLimit: 1 }));
    }
  } catch {
    await Promise.allSettled(databases.map(database => database.close()));
    throw new Error("INVALID_ENTERPRISE_WORKER_CONFIG");
  }
  const controller = new AbortController();
  let signalRequested = false;
  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;
  let hardDeadline: ReturnType<typeof setTimeout> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true; controller.abort();
    // The process owner supplies the final fail-closed deadline if a native close receipt is missing.
    hardDeadline = setTimeout(() => {
      process.stderr.write("ERROR: ENTERPRISE_WORKER_SHUTDOWN_FAILED\n"); process.exit(1);
    }, SHUTDOWN_DEADLINE_MS - 250);
    const pending = runtimes.map(runtime => runtime.stop()); // seals both lanes synchronously
    shutdownPromise = workerDeadline(Promise.allSettled(pending).then(results => {
      if (results.some(result => result.status === "rejected")) throw new Error("ENTERPRISE_WORKER_SHUTDOWN_FAILED");
    }), SHUTDOWN_DEADLINE_MS - 300);
    void shutdownPromise.catch(() => { process.exitCode = 1; });
    return shutdownPromise;
  };
  const onSignal = (): void => { signalRequested = true; void shutdown(); };
  process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);
  process.stdout.write(`enterprise worker ${ordinary.workerId} pid ${process.pid} starting\n`);
  try {
    // Both exact targets/roles pass before either lane writes any durable schedule.
    await Promise.all(runtimes.map(runtime => runtime.runStartup(async client => {
      await preflightEnterpriseWorker(client, config);
    })));
    if (!stopping) {
      const cleanupSlot = eventInboxCleanupSlot(new Date()).toISOString();
      const retentionSlot = enterpriseRetentionSlot(new Date()).toISOString();
      await ordinary.runStartup(async client => {
        await client.query("begin");
        try {
          await preflightEnterpriseWorker(client, config);
          await scheduleEventInboxCleanupJob(client, { scheduledFor: cleanupSlot });
          await scheduleEnterpriseRetentionJob(client, { scheduledFor: retentionSlot });
          await client.query("commit");
        } catch (error) {
          try { await client.query("rollback"); } catch { /* A sealed connection is already being rolled back. */ }
          throw error;
        }
      });
    }
    if (!stopping && cleanup) await cleanup.schedule(controller.signal);
    if (!stopping) {
      process.stdout.write(`enterprise worker ${ordinary.workerId} pid ${process.pid} started\n`);
      await Promise.all(runtimes.map(runtime => runtime.start()));
    }
  } catch (error) {
    if (!signalRequested) throw error;
  } finally {
    await shutdown();
    process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal);
    const stopped = `enterprise worker ${ordinary.workerId} stopped\n`;
    if (signalRequested) {
      await new Promise<void>((resolveWrite, rejectWrite) => {
        process.stdout.write(stopped, (error?: Error | null) => { if (error) rejectWrite(error); else resolveWrite(); });
      });
      process.exit(process.exitCode ?? 0);
    }
    process.stdout.write(stopped);
    clearTimeout(hardDeadline);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    const known = ["INVALID_ENTERPRISE_WORKER_CONFIG", "ENTERPRISE_WORKER_TARGET_REJECTED",
      "ENTERPRISE_WORKER_SHUTDOWN_FAILED", "ENTERPRISE_WORKER_CANCEL_FAILED"];
    const key = error instanceof Error && known.includes(error.message) ? error.message : "ENTERPRISE_WORKER_UNAVAILABLE";
    process.stderr.write(`ERROR: ${key}\n`); process.exit(1);
  });
}
