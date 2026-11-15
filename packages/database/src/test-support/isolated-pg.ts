/**
 * FS-57：一次性 PG 迁移 fixture 与测试目标证明。
 *
 * 本模块只用于测试。它在本次运行内创建一个带 run_id 标签的独立 Postgres
 * 容器，从该容器派生连接串，在容器内创建一个以随机 run_id 命名的一次性
 * 数据库，把迁移只应用到该库，并在结束时只销毁本次运行登记的数据库与容器。
 *
 * 它不读取 `DATABASE_URL`：任意外部连接串都不可能成为 fixture 的写入目标，
 * 也不可能有外部数据库被本次运行销毁。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const DEFAULT_IMAGE = "postgres:16";
const DEFAULT_USER = "megaui";
const DEFAULT_PASSWORD = "megaui";
/** The label the container carries, so a leftover container is attributable. */
export const CONTAINER_LABEL = "megaui-run-id";
const DATABASE_PREFIX = "megaui_test";
const READY_TIMEOUT_MS = 60_000;
const READY_INTERVAL_MS = 250;

export interface IsolatedPostgresOptions {
  /** The image of the throwaway server. */
  image?: string;
  /** The run id; a random one is generated when it is absent. */
  runId?: string;
  /** The admin user of the throwaway server. */
  user?: string;
  /** The admin password of the throwaway server. */
  password?: string;
}

export interface IsolatedPostgres {
  /** The run id of this instance; it labels the container and the database. */
  readonly runId: string;
  /** The name of the container of this run. */
  readonly containerName: string;
  /** The one-shot database of this run. */
  readonly databaseName: string;
  /** The connection string of the one-shot database. */
  readonly databaseUrl: string;
  /** The connection string of the server's maintenance database. */
  readonly adminUrl: string;
  /** Applies the migration set to the one-shot database of this run. */
  migrate(): Promise<void>;
  /**
   * Destroys the one-shot database and the container of this run. A failure
   * is reported as an error, so a failed cleanup fails the caller.
   */
  destroy(): Promise<void>;
}

/** The containers of this run, so a crashed run still leaves nothing behind. */
const registeredContainers = new Set<string>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const containerName of registeredContainers) {
      try {
        spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
      } catch {
        // The process is exiting; the real failure was already reported.
      }
    }
  });
}

/** The databases this run registered; only these may be destroyed. */
const registeredDatabases = new Map<string, IsolatedPostgres>();

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * A pool with an error handler.
 *
 * A pool without one turns a background connection error into an uncaught
 * exception, which would fail an unrelated test.
 */
function createPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString });
  pool.on("error", () => {
    // The caller sees the failure through its own query; the pool only has
    // to stay silent instead of crashing the process.
  });
  return pool;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when a docker daemon answers; the isolator needs one. */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const result = await runCommand("docker", ["version", "--format", "{{.Server.Version}}"]);
    return result.code === 0;
  } catch {
    return false;
  }
}

async function resolveContainerPort(containerName: string): Promise<number> {
  const result = await runCommand("docker", ["port", containerName, "5432/tcp"]);
  if (result.code !== 0) {
    throw new Error(
      `[@megaui/database] the isolated Postgres container has no published port: ${result.stderr.trim()}`,
    );
  }
  const line = result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) {
    throw new Error("[@megaui/database] the isolated Postgres container published no port.");
  }
  const port = Number(line.slice(line.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("[@megaui/database] the isolated Postgres container published an invalid port.");
  }
  return port;
}

/**
 * Waits until the server answers a query.
 *
 * The container's entrypoint runs a temporary server for initdb that only
 * listens on the unix socket, and the real server accepts a connection while
 * it is still starting up. A query that succeeds is therefore the only
 * readiness signal that is worth trusting.
 */
async function waitForReady(
  containerName: string,
  adminUrl: string,
  user: string,
  deadline: number,
): Promise<void> {
  let consecutiveSuccesses = 0;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        "[@megaui/database] the isolated Postgres container did not become ready in time.",
      );
    }
    const ready = await runCommand("docker", [
      "exec",
      containerName,
      "pg_isready",
      "-U",
      user,
      "-d",
      "postgres",
    ]);
    if (ready.code === 0) {
      try {
        const pool = createPool(adminUrl);
        try {
          await pool.query("select 1");
        } finally {
          await pool.end();
        }
        consecutiveSuccesses += 1;
        if (consecutiveSuccesses >= 2) {
          return;
        }
      } catch {
        // The server is not answering yet; the next round tries again.
        consecutiveSuccesses = 0;
      }
    } else {
      consecutiveSuccesses = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
  }
}

/**
 * Creates the one-shot database.
 *
 * The server of a fresh container terminates connections that arrive during
 * its startup window, so the statement is retried instead of failing the
 * whole run.
 */
async function createDatabase(adminUrl: string, databaseName: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const pool = createPool(adminUrl);
    try {
      await pool.query(`CREATE DATABASE "${databaseName}"`);
      return;
    } catch (error) {
      lastError = error;
    } finally {
      await pool.end();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `[@megaui/database] the one-shot database could not be created: ${describeError(lastError)}`,
  );
}

/** The migrations folder of this package. */
export function resolveMigrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "drizzle");
}

/**
 * The tags of the generated migration journal.
 *
 * The count comes from the generated journal, so a new migration never needs
 * a hand-written snapshot of it.
 */
export function readJournalTags(migrationsFolder = resolveMigrationsFolder()): string[] {
  const raw = readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8");
  const journal = JSON.parse(raw) as { entries?: { tag?: string }[] };
  return (journal.entries ?? []).map((entry) => entry.tag ?? "");
}

/** The tables of the `public` schema of the given database. */
export async function readPublicTables(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

/**
 * The tables of the explicit manifest that the database does not have.
 *
 * The manifest is explicit, so a migration that stops creating a table is
 * detected instead of being hidden behind a count.
 */
export function missingTables(
  expected: readonly string[],
  actual: readonly string[],
): string[] {
  const present = new Set(actual);
  return expected.filter((name) => !present.has(name)).sort();
}

/** The databases this run registered, sorted. */
export function listRegisteredDatabases(): string[] {
  return [...registeredDatabases.keys()].sort();
}

/**
 * Creates an isolated Postgres for this run.
 *
 * The container carries the run id as a label and the one-shot database is
 * named after the same random run id, so a leftover resource is attributable
 * and two runs never share a database.
 */
export async function createIsolatedPostgres(
  options: IsolatedPostgresOptions = {},
): Promise<IsolatedPostgres> {
  const image = options.image ?? DEFAULT_IMAGE;
  const user = options.user ?? DEFAULT_USER;
  const password = options.password ?? DEFAULT_PASSWORD;
  const runId = options.runId ?? randomUUID().replace(/-/g, "").slice(0, 12);
  const containerName = `megaui-pg-${runId}`;
  const databaseName = `${DATABASE_PREFIX}_${runId}`;

  const started = await runCommand("docker", [
    "run",
    "-d",
    "--label",
    `${CONTAINER_LABEL}=${runId}`,
    "--name",
    containerName,
    "-e",
    `POSTGRES_USER=${user}`,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=postgres",
    "-p",
    "127.0.0.1::5432",
    image,
  ]);
  if (started.code !== 0) {
    throw new Error(
      `[@megaui/database] the isolated Postgres container could not start: ${started.stderr.trim()}`,
    );
  }

  let adminUrl = "";
  try {
    const port = await resolveContainerPort(containerName);
    adminUrl = `postgres://${user}:${password}@127.0.0.1:${port}/postgres`;
    await waitForReady(containerName, adminUrl, user, Date.now() + READY_TIMEOUT_MS);

    await createDatabase(adminUrl, databaseName);
  } catch (error) {
    await runCommand("docker", ["rm", "-f", containerName]);
    throw error;
  }

  const databaseUrl = adminUrl.replace(/\/postgres$/, `/${databaseName}`);

  const isolated: IsolatedPostgres = {
    runId,
    containerName,
    databaseName,
    databaseUrl,
    adminUrl,
    migrate: async (): Promise<void> => {
      const pool = createPool(databaseUrl);
      try {
        await drizzleMigrate(drizzle(pool), { migrationsFolder: resolveMigrationsFolder() });
      } finally {
        await pool.end();
      }
    },
    destroy: async (): Promise<void> => {
      const failures: string[] = [];
      if (registeredDatabases.has(databaseName)) {
        try {
          const pool = createPool(adminUrl);
          try {
            await pool.query(
              `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
              [databaseName],
            );
            await pool.query(`drop database if exists "${databaseName}"`);
          } finally {
            await pool.end();
          }
          registeredDatabases.delete(databaseName);
        } catch (error) {
          failures.push(`dropping the one-shot database failed: ${describeError(error)}`);
        }
      }
      const removed = await runCommand("docker", ["rm", "-f", containerName]);
      if (removed.code !== 0) {
        failures.push(`removing the container failed: ${removed.stderr.trim()}`);
      } else {
        registeredContainers.delete(containerName);
      }
      if (failures.length > 0) {
        throw new Error(
          `[@megaui/database] the isolated Postgres cleanup failed: ${failures.join("; ")}`,
        );
      }
    },
  };

  registeredDatabases.set(databaseName, isolated);
  registeredContainers.add(containerName);
  installExitHook();
  return isolated;
}
