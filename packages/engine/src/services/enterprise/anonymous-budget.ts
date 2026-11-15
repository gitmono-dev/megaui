// megaui-only (FS-74): anonymous pairing budgets have no upstream counterpart.
import { createHash } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { ENTERPRISE_PROCESS_ROLES } from "@megaui/database";
import type {
  AnonymousBudgetAlert, AnonymousBudgetClient, AnonymousPairingBudget,
  AnonymousPairingBudgetOptions, AnonymousPairingBudgetResult,
} from "./anonymous-budget-types";
import { anonymousIpSubjects, createAnonymousIpResolver } from "./anonymous-ip";
import { anonymousCapacity, chargeAnonymousIp, expireAnonymousFlow, lockAnonymousBudget, verifyAnonymousPending } from "./anonymous-budget-store";

const unavailable = (): AnonymousPairingBudgetResult => ({ kind: "unavailable" });
const failure = () => new Error("ANONYMOUS_BUDGET_UNAVAILABLE");
const DAY_MS = 24 * 60 * 60 * 1_000;
// Freeze references before a caller can wrap the shared acquisition/cleanup prototypes.
const standardPoolMethods = ["connect", "newClient", "_afterConnect", "_acquireClient", "_promiseTry",
  "_pulseQueue", "_isFull", "_isAboveMin", "_releaseOnce", "_release", "_remove"]
  .map(key => [key, Reflect.get(Pool.prototype, key)] as const);
const standardClientMethods = ["connect", "_connect"].map(key => [key, Reflect.get(Client.prototype, key)] as const);

/** pg's connection timer does not cover user acquisition hooks. Never invoke them. */
function supportedPool(pool: Pool): boolean {
  if (!pool || Object.getPrototypeOf(pool) !== Pool.prototype
    || standardPoolMethods.some(([key, value]) => Reflect.get(pool, key) !== value)
    || standardClientMethods.some(([key, value]) => Reflect.get(Client.prototype, key) !== value)) return false;
  const actual = pool as unknown as { Client: unknown; Promise: unknown; options: Record<string, unknown> };
  const config = actual.options;
  return !!config && Number.isInteger(config.connectionTimeoutMillis) && Number(config.connectionTimeoutMillis) >= 1
    && Number(config.connectionTimeoutMillis) <= 1000 && actual.Client === Client && actual.Promise === Promise
    && (config.Client === undefined || config.Client === Client) && (config.Promise === undefined || config.Promise === Promise)
    && config.onConnect === undefined && config.verify === undefined && config.stream === undefined
    && typeof config.password !== "function" && pool.listenerCount("connect") === 0 && pool.listenerCount("acquire") === 0;
}

/** Observe a late acquisition without retaining its client or ending the caller's pool. */
function acquire(pool: Pool): Promise<PoolClient> {
  const pending = pool.connect();
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(failure()); }, 1000);
    pending.then(client => {
      clearTimeout(timer);
      if (expired) client.release(true);
      else resolve(client);
    }, () => { clearTimeout(timer); reject(failure()); });
  });
}

/**
 * Caches only derived pseudonyms, never the master or a raw address. Entries
 * older than the current UTC day and its predecessor are evicted on access.
 * This keeps the daily-key retention bound explicit even for long-lived
 * workers and also makes key rotation require a fresh service instance.
 */
export interface AnonymousIpSubjectCache {
  (scope: string, role: string, ip: string, nowMs: number): readonly [string, string];
  readonly size: () => number;
}

export function createAnonymousIpSubjectCache(master: Uint8Array): AnonymousIpSubjectCache {
  const entries = new Map<string, { day: number; subjects: readonly [string, string] }>();
  let latestDay = -1;
  const resolve = ((scope: string, role: string, ip: string, nowMs: number) => {
    const day = Math.floor(nowMs / DAY_MS);
    if (day > latestDay) latestDay = day;
    for (const [key, value] of entries) {
      if (value.day < latestDay - 1) entries.delete(key);
    }
    const key = `${scope}\u0000${role}\u0000${ip}\u0000${day}`;
    const cached = entries.get(key);
    if (cached) return cached.subjects;
    const subjects = anonymousIpSubjects(master, scope, role, ip, nowMs);
    entries.set(key, { day, subjects });
    return subjects;
  }) as AnonymousIpSubjectCache;
  Object.defineProperty(resolve, "size", { value: () => entries.size });
  return resolve;
}

function emitAlert(sink: AnonymousPairingBudgetOptions["alert"], event: AnonymousBudgetAlert): void {
  try {
    const result: unknown = sink(Object.freeze(event));
    if (result === undefined) return;
    // Invalid async sinks are unsupported; consume rejection without awaiting delivery.
    if (result !== null && (typeof result === "object" || typeof result === "function")) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch { /* Only the fixed fallback below may escape to logs. */ }
  console.warn("ENTERPRISE_ANONYMOUS_BUDGET_ALERT_UNAVAILABLE");
}

export function createAnonymousPairingBudget(options: AnonymousPairingBudgetOptions): AnonymousPairingBudget {
  let resolveIp: ReturnType<typeof createAnonymousIpResolver>;
  try {
    const target = options.expectation;
    if (!supportedPool(options.pool) || !target || !ENTERPRISE_PROCESS_ROLES.includes(target.processRole)
      || [target.instanceId, target.ownerFingerprint, target.environment].some(value =>
        typeof value !== "string" || value.length === 0 || value.length > 256 || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127))
      || !["development", "test", "production", "canary"].includes(target.environment)
      || target.approvedBootstrapTargets !== undefined || !(options.ipHmacMaster instanceof Uint8Array)
      || options.ipHmacMaster.length < 32 || options.ipHmacMaster.length > 1024 || typeof options.alert !== "function") {
      throw failure();
    }
    resolveIp = createAnonymousIpResolver(options.proxyCidrs);
  } catch { throw new Error("INVALID_ANONYMOUS_BUDGET_CONFIG"); }
  const pool = options.pool;
  const poolOptions = pool.options;
  const optionSnapshot = Object.getOwnPropertyNames(poolOptions).map(key => [key, Reflect.get(poolOptions, key)] as const);
  const expectation = Object.freeze({ ...options.expectation });
  const master = Uint8Array.from(options.ipHmacMaster);
  const subjectCache = createAnonymousIpSubjectCache(master);
  const sink = options.alert;
  const fingerprint = createHash("sha256").update(JSON.stringify([
    expectation.ownerFingerprint, expectation.instanceId, expectation.environment,
  ])).digest("hex");

  return Object.freeze({
    async run(input, createPending): Promise<AnonymousPairingBudgetResult> {
      if (!supportedPool(pool) || pool.options !== poolOptions
        || Object.getOwnPropertyNames(poolOptions).length !== optionSnapshot.length
        || optionSnapshot.some(([key, value]) => Reflect.get(poolOptions, key) !== value)
        || !input || typeof input.flowHash !== "string" || !/^[0-9a-f]{64}$/.test(input.flowHash)
        || input.flowHash.length !== 64 || typeof createPending !== "function") return unavailable();
      const ip = resolveIp(input.transport);
      if (ip === null) return unavailable();
      const flowHash = input.flowHash;
      let client: PoolClient;
      try { client = await acquire(pool); } catch { return unavailable(); }
      let released = false;
      let committing = false;
      let alert: AnonymousBudgetAlert | undefined;
      const release = (destroy = false) => {
        if (released) return;
        released = true;
        client.release(destroy);
      };
      let abort: () => void = () => undefined;
      const deadline = new Promise<never>((_, reject) => {
        abort = () => { release(true); reject(failure()); };
      });
      const timer = setTimeout(abort, 5000);
      client.on("error", abort);
      const transaction: AnonymousBudgetClient = Object.freeze({
        async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
          if (released) throw failure();
          const queryTimer = setTimeout(abort, 3000);
          try { return await client.query<Row>(sql, values ? [...values] : undefined); }
          catch {
            // Any failed query invalidates this transaction, including driver timeouts without SQLSTATE.
            // Closing also rolls back its uncommitted writes before a callback can recover and commit.
            abort();
            throw failure();
          }
          finally { clearTimeout(queryTimer); }
        },
      });
      const work = async (): Promise<AnonymousPairingBudgetResult> => {
        try {
          await transaction.query("begin isolation level read committed");
          await transaction.query("set local lock_timeout='1s'; set local statement_timeout='3s'; set local idle_in_transaction_session_timeout='5s'");
          const nowMs = await lockAnonymousBudget(transaction, expectation);
          const context = Object.freeze({ client: transaction, scope: expectation.instanceId,
            deploymentRole: expectation.environment, flowHash, nowMs });
          await expireAnonymousFlow(context);
          const charged = await chargeAnonymousIp(
            context,
            subjectCache(context.scope, context.deploymentRole, ip, nowMs),
          );
          const reason = charged ? await anonymousCapacity(context) : "ip";
          let result: AnonymousPairingBudgetResult;
          if (reason) {
            alert = { event: "enterprise.anonymous-budget.saturated", reason, scopeFingerprint: fingerprint,
              at: new Date(nowMs).toISOString() };
            result = { kind: "rate-limited", status: 429, code: "RATE_LIMITED" };
          } else {
            const pairingId = await createPending(context);
            await verifyAnonymousPending(context, pairingId);
            result = { kind: "accepted", pairingId };
          }
          committing = true;
          await transaction.query("commit");
          if (released) return unavailable();
          return result;
        } catch {
          if (!released && !committing) {
            try { await transaction.query("rollback"); } catch { release(true); }
          } else release(true);
          return unavailable();
        } finally { release(); }
      };
      let result: AnonymousPairingBudgetResult;
      try { result = await Promise.race([work(), deadline]); } catch { result = unavailable(); }
      finally { clearTimeout(timer); client.removeListener("error", abort); }
      if (result.kind === "rate-limited" && alert) emitAlert(sink, alert);
      return result;
    },
  } satisfies AnonymousPairingBudget);
}
