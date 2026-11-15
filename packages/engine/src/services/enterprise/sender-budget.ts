// megaui-only (FS-75): trusted sender and identity send budgets.
import { createHash } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { assertEnterpriseScope, type EnterpriseScopeExpectation } from "@megaui/database";

export const ENTERPRISE_SENDER_WINDOW_MS = 600_000;
export const ENTERPRISE_SENDER_INTERVAL_MS = 60_000;
export const ENTERPRISE_SENDER_IDENTITY_MAX = 5;
export const ENTERPRISE_SENDER_FLOW_MAX = 3;
export const ENTERPRISE_SENDER_INVALID_WINDOW_MS = 600_000;
export const ENTERPRISE_SENDER_INVALID_MAX = 10;

export interface EnterpriseSenderBudgetOptions {
  readonly pool: Pool;
  readonly expectation: EnterpriseScopeExpectation;
  readonly tenantKey: string;
  readonly appId: string;
}

export interface EnterpriseSenderBudgetClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string, values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface EnterpriseSenderBudgetContext {
  readonly client: EnterpriseSenderBudgetClient;
  readonly scope: string;
  readonly deploymentRole: string;
  readonly senderOpenId: string;
  readonly identityId: string;
  readonly flowHash: string;
  readonly nowMs: number;
}

export interface EnterpriseSenderBudgetInput {
  readonly senderOpenId: string;
  readonly identityId?: string;
  readonly flowHash?: string;
  readonly validToken: boolean;
}

export type EnterpriseSenderBudgetResult<T> =
  | { readonly kind: "accepted"; readonly value: T }
  | { readonly kind: "invalid-token" }
  | { readonly kind: "rate-limited"; readonly status: 429; readonly code: "RATE_LIMITED" }
  | { readonly kind: "unavailable" };

export interface EnterpriseSenderBudget {
  run<T>(
    input: EnterpriseSenderBudgetInput,
    createChallenge: (context: Readonly<EnterpriseSenderBudgetContext>) => Promise<T>,
  ): Promise<EnterpriseSenderBudgetResult<T>>;
}

const unavailable = <T>(): EnterpriseSenderBudgetResult<T> => ({ kind: "unavailable" });
const failure = () => new Error("ENTERPRISE_SENDER_BUDGET_UNAVAILABLE");
const SENDER_LOCK_PREFIX = "megaui:sender-budget:v1";

// Freeze the supported Pool surface before a caller can replace acquisition or
// release hooks on a shared pool. The port must never end a caller-owned pool.
const standardPoolMethods = ["connect", "newClient", "_afterConnect", "_acquireClient", "_promiseTry",
  "_pulseQueue", "_isFull", "_isAboveMin", "_releaseOnce", "_release", "_remove"]
  .map(key => [key, Reflect.get(Pool.prototype, key)] as const);
const standardClientMethods = ["connect", "_connect"].map(key => [key, Reflect.get(Client.prototype, key)] as const);

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

function safeText(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256
    && ![...value].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127);
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function subject(kind: "sender" | "identity", value: string): string {
  return createHash("sha256").update(JSON.stringify(["megaui:sender-budget:subject:v1", kind, value]), "utf8").digest("hex");
}

function lockKey(scope: string, role: string): string {
  return JSON.stringify([SENDER_LOCK_PREFIX, scope, role, "login"]);
}

async function lockAuthority(client: EnterpriseSenderBudgetClient, expectation: EnterpriseScopeExpectation): Promise<number> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey(expectation.instanceId, expectation.environment)]);
  const result = await client.query<{
    scope: string; owner_fingerprint: string; environment: string; activation_state: string; auth_epoch: number;
    role_name: string; can_ddl: boolean; can_create_db: boolean;
  }>(`select scope,owner_fingerprint,environment,activation_state,auth_epoch,current_user as role_name,
    has_schema_privilege(current_user,'public','CREATE') as can_ddl,
    has_database_privilege(current_user,current_database(),'CREATE') as can_create_db
    from enterprise_policy where scope=$1 and activation_state='enterprise' for share`, [expectation.instanceId]);
  const row = result.rows[0];
  if (!row) throw failure();
  assertEnterpriseScope({ expectation, marker: { scope: row.scope, ownerFingerprint: row.owner_fingerprint,
    environment: row.environment, activationState: row.activation_state, authEpoch: row.auth_epoch },
  privileges: { roleName: row.role_name, canDdl: row.can_ddl, canCreateDatabase: row.can_create_db } });
  const clock = await client.query<{ now_ms: number }>("select floor(extract(epoch from clock_timestamp())*1000)::double precision as now_ms");
  const nowMs = clock.rows[0]?.now_ms;
  if (typeof nowMs !== "number" || !Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8_639_999_999_400_000) throw failure();
  return nowMs;
}

async function chargeInvalid(client: EnterpriseSenderBudgetClient, scope: string, role: string, senderHash: string, nowMs: number): Promise<boolean> {
  const at = new Date(nowMs);
  const result = await client.query<{ used: number }>(`select coalesce(sum(used),0)::int as used
    from enterprise_login_budgets where scope=$1 and deployment_role=$2 and budget_kind='sender-invalid'
      and subject_hash=$3 and window_started_at > $4::timestamptz-interval '600 seconds'
      and window_started_at <= $4::timestamptz`, [scope, role, senderHash, at]);
  if (!result.rows[0] || result.rows[0].used >= ENTERPRISE_SENDER_INVALID_MAX) return false;
  await client.query(`insert into enterprise_login_budgets as budget
    (scope,deployment_role,budget_kind,subject_hash,window_started_at,used,expires_at)
    values ($1,$2,'sender-invalid',$3,$4,1,$5)
    on conflict (scope,deployment_role,budget_kind,subject_hash,window_started_at)
    do update set used=budget.used+1`,
  [scope, role, senderHash, at, new Date(nowMs + ENTERPRISE_SENDER_INVALID_WINDOW_MS)]);
  return true;
}

async function senderBlocked(client: EnterpriseSenderBudgetClient, scope: string, role: string, senderHash: string, at: Date): Promise<boolean> {
  const result = await client.query<{ blocked: boolean }>(`select coalesce(bool_or(next_allowed_at > $4::timestamptz),false) as blocked
    from enterprise_login_budgets where scope=$1 and deployment_role=$2 and budget_kind='sender-send'
      and subject_hash=$3 and window_started_at > $4::timestamptz-interval '600 seconds'
      and window_started_at <= $4::timestamptz`, [scope, role, senderHash, at]);
  return result.rows[0]?.blocked === true;
}

async function identityBlocked(client: EnterpriseSenderBudgetClient, scope: string, role: string, identityHash: string, at: Date): Promise<boolean> {
  const result = await client.query<{ used: number }>(`select coalesce(sum(used),0)::int as used
    from enterprise_login_budgets where scope=$1 and deployment_role=$2 and budget_kind='sender-send'
      and subject_hash=$3 and window_started_at > $4::timestamptz-interval '600 seconds'
      and window_started_at <= $4::timestamptz`, [scope, role, identityHash, at]);
  return !result.rows[0] || result.rows[0].used >= ENTERPRISE_SENDER_IDENTITY_MAX;
}

async function flowLimit(client: EnterpriseSenderBudgetClient, scope: string, role: string, tenantKey: string, appId: string, identityId: string, flowHash: string): Promise<boolean> {
  const result = await client.query<{ flow_count: number; current_flow: boolean }>(`select
    count(distinct flow_hash)::int as flow_count,
    coalesce(bool_or(flow_hash=$6),false) as current_flow
    from enterprise_pairings where scope=$1 and deployment_role=$2 and tenant_key=$3 and app_id=$4
      and purpose='login' and intended_identity_id=$5 and state='confirmed'`, [scope, role, tenantKey, appId, identityId, flowHash]);
  const row = result.rows[0];
  return !row || (row.flow_count >= ENTERPRISE_SENDER_FLOW_MAX && row.current_flow !== true);
}

async function chargeSend(client: EnterpriseSenderBudgetClient, scope: string, role: string, senderHash: string, identityHash: string, at: Date): Promise<void> {
  const nextAllowed = new Date(at.getTime() + ENTERPRISE_SENDER_INTERVAL_MS);
  const expiresAt = new Date(at.getTime() + ENTERPRISE_SENDER_WINDOW_MS);
  for (const hash of [senderHash, identityHash]) {
    await client.query(`insert into enterprise_login_budgets
      (scope,deployment_role,budget_kind,subject_hash,window_started_at,used,expires_at,next_allowed_at)
      values ($1,$2,'sender-send',$3,$4,1,$5,$6)`, [scope, role, hash, at, expiresAt, nextAllowed]);
  }
}

export function createEnterpriseSenderBudget(options: EnterpriseSenderBudgetOptions): EnterpriseSenderBudget {
  if (!options || !supportedPool(options.pool) || !options.expectation
    || !safeText(options.tenantKey) || !safeText(options.appId)) {
    throw new Error("INVALID_ENTERPRISE_SENDER_BUDGET_CONFIG");
  }
  const pool = options.pool;
  const poolOptions = pool.options;
  const optionSnapshot = Object.getOwnPropertyNames(poolOptions).map(key => [key, Reflect.get(poolOptions, key)] as const);
  const expectation = Object.freeze({ ...options.expectation });
  const tenantKey = options.tenantKey;
  const appId = options.appId;

  return Object.freeze({
    async run<T>(input: EnterpriseSenderBudgetInput,
      createChallenge: (context: Readonly<EnterpriseSenderBudgetContext>) => Promise<T>): Promise<EnterpriseSenderBudgetResult<T>> {
      const keys = input && typeof input === "object" ? Object.keys(input) : [];
      if (!supportedPool(pool) || pool.options !== poolOptions
        || Object.getOwnPropertyNames(poolOptions).length !== optionSnapshot.length
        || optionSnapshot.some(([key, value]) => Reflect.get(poolOptions, key) !== value)
        || keys.some(key => !["senderOpenId", "identityId", "flowHash", "validToken"].includes(key))
        || !input || !safeText(input.senderOpenId) || typeof input.validToken !== "boolean"
        || typeof createChallenge !== "function") return unavailable();
      if (input.validToken && (!safeText(input.identityId) || !safeHash(input.flowHash))) return unavailable();
      let client: PoolClient;
      try { client = await acquire(pool); } catch { return unavailable(); }
      let released = false;
      let committing = false;
      const release = (destroy = false) => { if (!released) { released = true; client.release(destroy); } };
      let abort: () => void = () => undefined;
      const deadline = new Promise<never>((_, reject) => { abort = () => { release(true); reject(failure()); }; });
      const timer = setTimeout(abort, 5000);
      client.on("error", abort);
      const transaction: EnterpriseSenderBudgetClient = Object.freeze({
        async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
          if (released) throw failure();
          const queryTimer = setTimeout(abort, 3000);
          try { return await client.query<Row>(text, values ? [...values] : undefined); }
          catch { abort(); throw failure(); }
          finally { clearTimeout(queryTimer); }
        },
      });
      const work = async (): Promise<EnterpriseSenderBudgetResult<T>> => {
        try {
          await transaction.query("begin isolation level read committed");
          await transaction.query("set local lock_timeout='1s'; set local statement_timeout='3s'; set local idle_in_transaction_session_timeout='5s'");
          const nowMs = await lockAuthority(transaction, expectation);
          const scope = expectation.instanceId;
          const role = expectation.environment;
          const senderHash = subject("sender", input.senderOpenId);
          if (!input.validToken) {
            const charged = await chargeInvalid(transaction, scope, role, senderHash, nowMs);
            committing = true;
            await transaction.query("commit");
            return charged ? { kind: "invalid-token" } : { kind: "rate-limited", status: 429, code: "RATE_LIMITED" };
          }
          const identityId = input.identityId;
          const flowHash = input.flowHash;
          if (!safeText(identityId) || !safeHash(flowHash)) throw failure();
          const at = new Date(nowMs);
          const identityHash = subject("identity", identityId);
          if (await senderBlocked(transaction, scope, role, senderHash, at)
            || await identityBlocked(transaction, scope, role, identityHash, at)
            || await flowLimit(transaction, scope, role, tenantKey, appId, identityId, flowHash)) {
            committing = true;
            await transaction.query("commit");
            return { kind: "rate-limited", status: 429, code: "RATE_LIMITED" };
          }
          const context = Object.freeze({ client: transaction, scope, deploymentRole: role,
            senderOpenId: input.senderOpenId, identityId, flowHash, nowMs });
          await chargeSend(transaction, scope, role, senderHash, identityHash, at);
          const value = await createChallenge(context);
          committing = true;
          await transaction.query("commit");
          if (released) return unavailable();
          return { kind: "accepted", value };
        } catch {
          if (!released && !committing) {
            try { await transaction.query("rollback"); } catch { release(true); }
          } else release(true);
          return unavailable();
        } finally { release(); }
      };
      let result: EnterpriseSenderBudgetResult<T>;
      try { result = await Promise.race([work(), deadline]); } catch { result = unavailable(); }
      finally { clearTimeout(timer); client.removeListener("error", abort); }
      return result;
    },
  });
}
