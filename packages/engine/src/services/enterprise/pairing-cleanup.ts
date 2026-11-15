// megaui-only (FS-11): a leased, scope-bound retention chain with atomic page/successor writes.
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AuthMode } from "@megaui/core";
import type { EnterpriseScopeExpectation } from "@megaui/database";
import type { AnonymousBudgetClient } from "./anonymous-budget-types";
import type { EnterpriseJobHandler } from "./jobs";
import { readPairingTarget } from "./pairing-store";

const BATCH = 100;
// Reserve two seconds of the five-second page envelope for independent cancellation.
const WORK_MS = 3000;
const failure = () => new Error("ENTERPRISE_PAIRING_CLEANUP_UNAVAILABLE");
const uuid = (value: unknown): value is string => typeof value === "string" && value.length === 36
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export interface PairingCleanupOptions {
  readonly pool: Pool;
  readonly expectation: EnterpriseScopeExpectation;
  readonly authMode: AuthMode;
  /** Owned worker control connection; must settle within the reserved two seconds. */
  readonly cancelBackend: (pid: number) => Promise<void>;
}

export function createPairingCleanup(options: PairingCleanupOptions): {
  readonly queue: string;
  readonly schedule: (signal?: AbortSignal) => Promise<void>;
  readonly handle: EnterpriseJobHandler;
} {
  const target = options.expectation;
  if (!target || !["worker", "test"].includes(target.processRole) || target.approvedBootstrapTargets !== undefined
    || [target.instanceId, target.ownerFingerprint, target.environment].some(value => typeof value !== "string"
      || value.length === 0 || value.length > 256 || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127))
    || !["development", "test", "production", "canary"].includes(target.environment)
    || !["legacy", "enterprise", "maintenance"].includes(options.authMode) || typeof options.cancelBackend !== "function"
    || !Number.isInteger(options.pool?.options.connectionTimeoutMillis) || Number(options.pool.options.connectionTimeoutMillis) < 1
    || Number(options.pool.options.connectionTimeoutMillis) > 1000) throw new Error("INVALID_PAIRING_CLEANUP_CONFIG");
  const expectation = Object.freeze({ ...target });
  const { pool, authMode, cancelBackend } = options;
  const fingerprint = createHash("sha256").update(JSON.stringify([
    expectation.ownerFingerprint, expectation.instanceId, expectation.environment,
  ])).digest("hex");
  const prefix = `pairing-cleanup:${fingerprint}`;
  const queue = `enterprise.${prefix}`;

  function payload(value: unknown): { scope: string; deploymentRole: string; scheduledFor: string } {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== 3 || row.scope !== expectation.instanceId || row.deploymentRole !== expectation.environment
      || typeof row.scheduledFor !== "string" || row.scheduledFor.length !== 24) throw failure();
    const date = new Date(row.scheduledFor);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== row.scheduledFor) throw failure();
    return { scope: expectation.instanceId, deploymentRole: expectation.environment, scheduledFor: row.scheduledFor };
  }

  async function transaction(signal: AbortSignal, task: (client: AnonymousBudgetClient) => Promise<void>): Promise<void> {
    if (signal.aborted) throw failure();
    let native: PoolClient;
    try { native = await pool.connect(); } catch { throw failure(); }
    let released = false; let poisoned = false; let backendPid: number | undefined;
    let cancellation: Promise<void> | undefined; let rejectDeadline!: (reason: Error) => void;
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    native.once("end", resolveClosed);
    const release = (destroy = false) => { if (!released) { released = true; native.release(destroy); } };
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    const abort = () => {
      if (poisoned) return;
      poisoned = true;
      // Register cancellation before closing the client, since a lock waiter may not notice EOF.
      if (backendPid !== undefined) {
        cancellation = Promise.resolve().then(() => cancelBackend(backendPid!));
        void cancellation.catch(() => undefined);
      }
      release(true); native.connection.stream.destroy(); rejectDeadline(failure());
    };
    const timer = setTimeout(abort, WORK_MS);
    signal.addEventListener("abort", abort, { once: true }); native.on("error", abort);
    const client: AnonymousBudgetClient = {
      async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
        if (poisoned || signal.aborted || released) throw failure();
        // pg 8 supports this per-query timeout although its QueryConfig declaration omits it.
        const query = { text, values: values ? [...values] : undefined, query_timeout: WORK_MS };
        try { return await native.query<Row>(query); }
        catch { abort(); throw failure(); }
      },
    };
    const work = (async () => {
      if (signal.aborted) { abort(); throw failure(); }
      const backend = await client.query<{ pid: number }>("select pg_backend_pid()::int as pid");
      backendPid = backend.rows[0]?.pid;
      if (!Number.isInteger(backendPid) || backendPid! <= 0) throw failure();
      await client.query("begin isolation level read committed");
      await client.query("set local lock_timeout='1s'; set local statement_timeout='3s'; set local idle_in_transaction_session_timeout='3s'");
      await readPairingTarget(client, expectation, authMode);
      await task(client);
      await client.query("commit");
    })();
    let failed = false; let cancellationFailed = false;
    try { await Promise.race([work, deadline]); }
    catch { abort(); failed = true; }
    finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort); native.removeListener("error", abort);
      try {
        if (poisoned) {
          // Cancellation failure is infrastructure failure, not a recoverable handler retry.
          const results = await Promise.allSettled([work.catch(() => undefined), cancellation, closed]);
          cancellationFailed = results.some(result => result.status === "rejected");
        } else release();
      } finally { native.removeListener("end", resolveClosed); }
    }
    if (cancellationFailed) throw new Error("ENTERPRISE_WORKER_CANCEL_FAILED");
    if (failed) throw failure();
  }

  async function clock(client: AnonymousBudgetClient): Promise<number> {
    const result = await client.query<{ now_ms: number }>("select floor(extract(epoch from clock_timestamp())*1000)::double precision as now_ms");
    const now = result.rows[0]?.now_ms;
    if (!Number.isSafeInteger(now) || now! < 0 || now! > 8_639_999_999_940_000) throw failure();
    return now!;
  }
  async function insertJob(client: AnonymousBudgetClient, dedupe: string, at: number): Promise<void> {
    const scheduledFor = new Date(at).toISOString();
    await client.query(`insert into enterprise_jobs (id,queue,dedupe_key,payload,available_at)
      values ($1,$2,$3,$4::jsonb,$5) on conflict (dedupe_key) do nothing`,
    [randomUUID(), queue, dedupe, JSON.stringify({ scope: expectation.instanceId, deploymentRole: expectation.environment, scheduledFor }), new Date(at)]);
  }

  const handle: EnterpriseJobHandler = async (job, context) => {
    if (!job || !uuid(job.id) || job.queue !== queue || !context || typeof context.claimOwner !== "string"
      || context.claimOwner.length < 1 || context.claimOwner.length > 256 || !(context.signal instanceof AbortSignal)
      || context.signal.aborted) throw failure();
    const submitted = payload(job.payload);
    await transaction(context.signal, async client => {
      const lease = async () => {
        const result = await client.query<{ payload: unknown; dedupe_key: string }>(`select payload,dedupe_key from enterprise_jobs
          where id=$1 and queue=$2 and state='leased' and claim_owner=$3 and lease_until > clock_timestamp() for update`,
        [job.id, queue, context.claimOwner]);
        const row = result.rows[0];
        if (result.rows.length !== 1 || !row || payload(row.payload).scheduledFor !== submitted.scheduledFor
          || (row.dedupe_key !== `${prefix}:root` && !(row.dedupe_key.startsWith(`${prefix}:next:`)
            && uuid(row.dedupe_key.slice(`${prefix}:next:`.length))))) throw failure();
      };
      await lease();
      const successor = `${prefix}:next:${job.id}`;
      const existing = await client.query<{ queue: string; payload: unknown }>("select queue,payload from enterprise_jobs where dedupe_key=$1", [successor]);
      if (existing.rows.length > 0) {
        if (existing.rows.length !== 1 || existing.rows[0]?.queue !== queue) throw failure();
        payload(existing.rows[0].payload);
      } else {
        const now = await clock(client);
        const deleted = await client.query(`with expired as (
          select id from enterprise_pairings where scope=$1 and deployment_role=$2 and retain_until <= $3
          order by retain_until,id limit $4 for update skip locked
        ) delete from enterprise_pairings as pairing using expired where pairing.id=expired.id`,
        [expectation.instanceId, expectation.environment, new Date(now), BATCH]);
        if (deleted.rowCount === null || deleted.rowCount < 0 || deleted.rowCount > BATCH) throw failure();
        await insertJob(client, successor, (await clock(client)) + (deleted.rowCount === BATCH ? 0 : 60_000));
      }
      // Use a fresh DB clock after all writes; holding a row lock alone does not extend a lease.
      await lease();
    });
  };
  return Object.freeze({ queue, handle, async schedule(signal = new AbortController().signal) {
    await transaction(signal, async client => { await insertJob(client, `${prefix}:root`, await clock(client)); });
  } });
}
