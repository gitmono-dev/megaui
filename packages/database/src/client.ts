// megaui:libs/database/index.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-04 task card): this file
// drops the sqlite/d1 dialect branches, the Cloudflare Workers/Hyperdrive
// request-scoped-client machinery, and the AsyncLocalStorage-based
// per-request client — apps/web runs as a single long-lived Node process
// (not a Workers isolate), so a single shared `pg` `Pool` is sufficient
// and is the only supported PG driver path here (ADR-ARCH-02: PG single
// dialect).
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import {
  assertEnterpriseScope,
  readEnterpriseMarker,
  readSqlRolePrivileges,
  type EnterpriseScopeExpectation,
} from "./enterprise-scope";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;

/** Max simultaneous checked-out clients (GC-09: bounded resource pool). */
const DEFAULT_MAX_CONNECTIONS = 10;
/** Idle clients are closed after this many ms (GC-09: release semantics). */
const DEFAULT_IDLE_TIMEOUT_MILLIS = 10_000;
/** `pool.connect()` rejects if no client becomes available within this many
 * ms instead of hanging forever (GC-09: timeout semantics). */
const DEFAULT_CONNECTION_TIMEOUT_MILLIS = 5_000;
/** Per-statement timeout so a stuck query can't hold a pooled client
 * forever (GC-09: release semantics on the query path too). */
const DEFAULT_STATEMENT_TIMEOUT_MILLIS = 30_000;

export interface CreateDatabaseClientOptions {
  /** Postgres connection string. Required — no implicit fallback (GC-07: fail-closed). */
  connectionString: string;
  /** @default 10 */
  max?: number;
  /** @default 10_000 */
  idleTimeoutMillis?: number;
  /** @default 5_000 */
  connectionTimeoutMillis?: number;
  /** @default 30_000 */
  statementTimeoutMillis?: number;
  /** Called when the pool emits a background client error (e.g. a lost
   * connection while idle). Defaults to logging — the pool remains usable
   * without this handler set, `pg` would otherwise crash the process on an
   * unhandled `'error'` event. */
  onPoolError?: (error: Error) => void;
}

export interface DatabaseClient {
  pool: Pool;
  db: Database;
  /** Ends the pool: waits for checked-out clients to be released, then
   * closes every connection. Idempotent — safe to call more than once
   * (GC-09: deterministic release on shutdown/test teardown). */
  close: () => Promise<void>;
}

export function createDatabaseClient(
  options: CreateDatabaseClientOptions,
): DatabaseClient {
  const {
    connectionString,
    max = DEFAULT_MAX_CONNECTIONS,
    idleTimeoutMillis = DEFAULT_IDLE_TIMEOUT_MILLIS,
    connectionTimeoutMillis = DEFAULT_CONNECTION_TIMEOUT_MILLIS,
    statementTimeoutMillis = DEFAULT_STATEMENT_TIMEOUT_MILLIS,
    onPoolError,
  } = options;

  if (!connectionString) {
    throw new Error(
      "[@megaui/database] createDatabaseClient requires a non-empty connectionString (GC-07: fail-closed, no implicit default).",
    );
  }

  const poolConfig: PoolConfig = {
    connectionString,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    statement_timeout: statementTimeoutMillis,
  };

  const pool = new Pool(poolConfig);

  pool.on("error", (error) => {
    if (onPoolError) {
      onPoolError(error);
    } else {
      console.error("[@megaui/database] pool error:", error);
    }
  });

  const db = drizzle(pool, { schema });

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closePromise) {
      closePromise = pool.end();
    }
    return closePromise;
  };

  return { pool, db, close };
}

/**
 * Creates a database client for an enterprise process.
 *
 * The scope guard runs before the client is handed out: a target that
 * belongs to another owner, instance or environment is refused, and the
 * pool is closed again so that no connection survives the refusal.
 */
export async function createEnterpriseDatabaseClient(
  options: CreateDatabaseClientOptions & { scope: EnterpriseScopeExpectation },
): Promise<DatabaseClient> {
  const client = createDatabaseClient(options);
  try {
    const marker = await readEnterpriseMarker(client.pool);
    const privileges = await readSqlRolePrivileges(client.pool);
    assertEnterpriseScope({
      marker,
      expectation: options.scope,
      privileges,
    });
  } catch (error) {
    await client.close();
    throw error;
  }
  return client;
}

function readDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "[@megaui/database] DATABASE_URL is not set. Fail-closed: this package never falls back to a hardcoded/default connection string (GC-07).",
    );
  }
  return url;
}

let sharedClient: DatabaseClient | undefined;
/** In-flight singleton shutdown; concurrent closes share this promise. */
let sharedClosePromise: Promise<void> | undefined;

/**
 * Lazily-created process-wide singleton, backed by `DATABASE_URL`. Lazy on
 * purpose: importing this module (e.g. for its schema/types) must never
 * open a socket or throw just because `DATABASE_URL` happens to be unset
 * in that process (typecheck/build/unit tests that don't touch the DB).
 */
export function getDatabaseClient(): DatabaseClient {
  if (sharedClosePromise) {
    throw new Error(
      "[@megaui/database] getDatabaseClient() called while closeDatabaseClient() is in flight (GC-09).",
    );
  }
  if (!sharedClient) {
    sharedClient = createDatabaseClient({ connectionString: readDatabaseUrl() });
  }
  return sharedClient;
}

export function getDb(): Database {
  return getDatabaseClient().db;
}

export function getPool(): Pool {
  return getDatabaseClient().pool;
}

/**
 * Releases the shared singleton's pool, if one was ever created.
 * Keeps the singleton slot until `pool.end()` resolves so a concurrent
 * `getDatabaseClient()` cannot orphan an in-flight shutdown (GC-09).
 */
export async function closeDatabaseClient(): Promise<void> {
  if (sharedClosePromise) return sharedClosePromise;
  if (!sharedClient) return;
  const client = sharedClient;
  sharedClosePromise = client.close().finally(() => {
    if (sharedClient === client) {
      sharedClient = undefined;
    }
    sharedClosePromise = undefined;
  });
  return sharedClosePromise;
}
