// FS-57 AC：一次性 PG 迁移 fixture 与测试目标证明。
//
// The isolator is the only owner of the test database: it creates a
// container of this run, derives the connection string from it, applies the
// migration set to a one-shot database and destroys only what it created.
//
// The suite needs a docker daemon. Without one it is skipped locally with a
// warning, and in CI it is a hard failure: the postgres service is not a
// substitute, because the fixture must own its database.
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  CONTAINER_LABEL,
  createIsolatedPostgres,
  isDockerAvailable,
  listRegisteredDatabases,
  missingTables,
  readJournalTags,
  readPublicTables,
  type IsolatedPostgres,
} from "./isolated-pg";

const dockerAvailable = await isDockerAvailable();

if (!dockerAvailable && process.env.CI === "true") {
  throw new Error(
    "[@megaui/database] isolated-pg.test.ts: a docker daemon is required in CI (the fixture owns its own Postgres).",
  );
}

if (!dockerAvailable) {
  console.warn(
    "[@megaui/database] isolated-pg.test.ts: no docker daemon — skipping the isolated Postgres suite.",
  );
}

/**
 * A pool with an error handler: a background connection error must not turn
 * into an uncaught exception that fails an unrelated case.
 */
function createPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString });
  pool.on("error", () => {});
  return pool;
}

function dockerInspect(containerName: string): { label?: string; running: boolean } {
  const result = spawnSync(
    "docker",
    ["inspect", "--format", "{{.State.Running}} {{index .Config.Labels \"megaui-run-id\"}}", containerName],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0) return { running: false };
  const [running, label] = result.stdout.trim().split(" ");
  return { running: running === "true", label };
}

describe.skipIf(!dockerAvailable)("isolated Postgres fixture (FS-57)", () => {
  const created: IsolatedPostgres[] = [];

  afterAll(async () => {
    for (const instance of created.reverse()) {
      // A cleanup failure has to fail the suite, not hide behind a warning.
      await instance.destroy();
    }
  }, 120_000);

  it("creates a container and a database that carry the run id", async () => {
    const instance = await createIsolatedPostgres();
    created.push(instance);

    expect(instance.runId).toMatch(/^[0-9a-f]{12}$/);
    expect(instance.containerName).toBe(`megaui-pg-${instance.runId}`);
    expect(instance.databaseName).toBe(`megaui_test_${instance.runId}`);
    expect(instance.databaseName).toContain(instance.runId);

    const inspected = dockerInspect(instance.containerName);
    expect(inspected.running).toBe(true);
    expect(inspected.label).toBe(instance.runId);
    expect(CONTAINER_LABEL).toBe("megaui-run-id");

    // The connection string is derived from the container, not from the
    // environment: it points at the published loopback port of this run.
    const port = Number(instance.databaseUrl.slice(instance.databaseUrl.lastIndexOf(":") + 1).split("/")[0]);
    expect(port).toBeGreaterThan(0);
    expect(instance.databaseUrl).toContain("/" + instance.databaseName);
  }, 120_000);

  it("creates a random database per run", async () => {
    const first = await createIsolatedPostgres();
    const second = await createIsolatedPostgres();
    created.push(first, second);

    expect(first.runId).not.toBe(second.runId);
    expect(first.databaseName).not.toBe(second.databaseName);
    expect(first.containerName).not.toBe(second.containerName);
  }, 120_000);

  it("never uses an external DATABASE_URL as its write target", async () => {
    const previous = process.env.DATABASE_URL;
    // A connection string that cannot be reached: if the fixture used it,
    // the whole run would fail here.
    process.env.DATABASE_URL = "postgres://megaui:megaui@127.0.0.1:1/website";
    try {
      const instance = await createIsolatedPostgres();
      created.push(instance);
      await instance.migrate();

      const pool = createPool(instance.databaseUrl);
      try {
        const tables = await readPublicTables(pool);
        expect(tables.length).toBeGreaterThan(0);
      } finally {
        await pool.end();
      }
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  }, 120_000);

  it("applies the migration only to the database of this run", async () => {
    const instance = await createIsolatedPostgres();
    created.push(instance);
    await instance.migrate();

    const pool = createPool(instance.databaseUrl);
    try {
      const rows = await pool.query(`select count(*)::int as count from drizzle.__drizzle_migrations`);
      expect(rows.rows[0]?.count).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }

    // The maintenance database of the same server stays untouched: the
    // migrations were applied to the one-shot database only.
    const adminPool = createPool(instance.adminUrl);
    try {
      const schemas = await adminPool.query(
        `select schema_name from information_schema.schemata where schema_name = 'drizzle'`,
      );
      expect(schemas.rows).toHaveLength(0);
    } finally {
      await adminPool.end();
    }
  }, 120_000);

  it("does not add journal rows when the migration runs again", async () => {
    const instance = await createIsolatedPostgres();
    created.push(instance);
    await instance.migrate();

    const pool = createPool(instance.databaseUrl);
    try {
      const first = await pool.query(`select hash from drizzle.__drizzle_migrations order by id`);
      await instance.migrate();
      const second = await pool.query(`select hash from drizzle.__drizzle_migrations order by id`);
      expect(second.rows).toEqual(first.rows);
      expect(first.rows.length).toBe(readJournalTags().length);
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("destroys only the databases this run registered", async () => {
    const kept = await createIsolatedPostgres();
    const removed = await createIsolatedPostgres();
    created.push(kept);

    expect(listRegisteredDatabases()).toContain(kept.databaseName);
    expect(listRegisteredDatabases()).toContain(removed.databaseName);

    await removed.destroy();

    expect(listRegisteredDatabases()).not.toContain(removed.databaseName);
    expect(listRegisteredDatabases()).toContain(kept.databaseName);
    expect(dockerInspect(removed.containerName).running).toBe(false);

    // The other database of this run is still there and still reachable.
    const pool = new Pool({ connectionString: kept.databaseUrl });
    try {
      const result = await pool.query(`select 1 as one`);
      expect(result.rows[0]?.one).toBe(1);
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("reports a cleanup failure instead of ignoring it", async () => {
    const instance = await createIsolatedPostgres();
    // The server disappears behind the fixture's back: the cleanup cannot
    // succeed, and the caller has to learn about it.
    spawnSync("docker", ["rm", "-f", instance.containerName], { encoding: "utf8", timeout: 30_000 });
    await expect(instance.destroy()).rejects.toThrow(/isolated Postgres cleanup failed/);
  }, 120_000);

  it("reports the tables of an explicit manifest that are missing", () => {
    expect(missingTables(["a", "b", "c"], ["a", "c"])).toEqual(["b"]);
    expect(missingTables(["a"], ["a", "b"])).toEqual([]);
    expect(missingTables([], ["a"])).toEqual([]);
  });
});
