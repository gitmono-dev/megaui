// PK-04 AC3 (GC-09 并发与资源生命周期): connection pool release/timeout
// semantics, asserted against a live Postgres instance.
//
// Requires `DATABASE_URL` (CI's postgres service already sets it; locally
// run a throwaway `docker run postgres:16 ...` and export the same var —
// see the package README). When unset locally, this suite is skipped with
// a console warning. In CI (`CI=true`), missing `DATABASE_URL` is a hard
// failure so pool lifecycle ACs cannot be skipped accidentally.
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "./client";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  if (process.env.CI === "true") {
    throw new Error(
      "[@megaui/database] client.test.ts: DATABASE_URL is required in CI (postgres service must be provisioned).",
    );
  }
  console.warn(
    "[@megaui/database] client.test.ts: DATABASE_URL is unset — skipping pool lifecycle tests (see README's local-test setup).",
  );
}

describe("createDatabaseClient (GC-07 fail-closed)", () => {
  it("throws when connectionString is empty instead of falling back to pg's default env vars", () => {
    expect(() => createDatabaseClient({ connectionString: "" })).toThrow(
      /connectionString/i,
    );
  });
});

describe.skipIf(!databaseUrl)(
  "createDatabaseClient pool release/timeout semantics (PK-04 AC3, GC-09)",
  () => {
    let client: DatabaseClient | undefined;

    afterEach(async () => {
      if (client) {
        await client.close();
        client = undefined;
      }
    });

    it("returns a checked-out client to the idle pool on release()", async () => {
      client = createDatabaseClient({ connectionString: databaseUrl!, max: 2 });
      const pgClient = await client.pool.connect();
      expect(client.pool.totalCount).toBe(1);
      expect(client.pool.idleCount).toBe(0);

      pgClient.release();

      expect(client.pool.idleCount).toBe(1);
      expect(client.pool.waitingCount).toBe(0);
    });

    it("rejects pool.connect() within connectionTimeoutMillis when the pool is exhausted, instead of hanging forever", async () => {
      client = createDatabaseClient({
        connectionString: databaseUrl!,
        max: 1,
        connectionTimeoutMillis: 200,
      });
      const heldClient = await client.pool.connect();
      try {
        const start = Date.now();
        await expect(client.pool.connect()).rejects.toThrow(/timeout/i);
        const elapsedMs = Date.now() - start;
        // Bounded by the configured timeout, not left hanging indefinitely.
        expect(elapsedMs).toBeLessThan(2000);
      } finally {
        heldClient.release();
      }
    });

    it("evicts idle clients after idleTimeoutMillis (GC-09 release semantics for unused resources)", async () => {
      client = createDatabaseClient({
        connectionString: databaseUrl!,
        max: 3,
        idleTimeoutMillis: 100,
      });
      const pgClient = await client.pool.connect();
      pgClient.release();
      expect(client.pool.idleCount).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(client.pool.idleCount).toBe(0);
      expect(client.pool.totalCount).toBe(0);
    });

    it("close() ends the pool: idempotent, and further queries reject instead of hanging", async () => {
      client = createDatabaseClient({ connectionString: databaseUrl! });
      await client.pool.query("select 1");

      await client.close();
      await expect(client.close()).resolves.toBeUndefined(); // idempotent

      await expect(client.pool.query("select 1")).rejects.toThrow();
      client = undefined; // already closed — afterEach must not double-close
    });

    it("getDb() executes a real query through the drizzle wrapper", async () => {
      client = createDatabaseClient({ connectionString: databaseUrl! });
      const result = await client.db.execute<{ one: number }>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "select 1 as one" as any,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ one: 1 });
    });
  },
);

describe.skipIf(!databaseUrl)(
  "module-level singleton lifecycle (getDatabaseClient/closeDatabaseClient)",
  () => {
    it("closeDatabaseClient() is a no-op when no singleton was ever created", async () => {
      const { closeDatabaseClient } = await import("./client");
      await expect(closeDatabaseClient()).resolves.toBeUndefined();
    });
  },
);

describe("pool error listener (GC-09: no unhandled 'error' crash)", () => {
  it("routes background pool errors to onPoolError instead of letting pg's default throw", () => {
    const errors: Error[] = [];
    const client = createDatabaseClient({
      connectionString: databaseUrl ?? "postgres://invalid-host-for-error-listener-test/db",
      onPoolError: (error) => errors.push(error),
    });
    // Directly exercise the listener path pg wires up internally —
    // asserts our client registered a handler at all (an unhandled
    // 'error' event on a Pool crashes the Node process).
    expect((client.pool as unknown as Pool).listenerCount("error")).toBeGreaterThan(0);
    client.pool.emit("error", new Error("synthetic pool error"));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("synthetic pool error");
    return client.close();
  });
});
