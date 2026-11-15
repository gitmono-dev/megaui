// FS-56：目录快照与水位 schema。
//
// The suite proves the constraints of the three new tables on a one-shot
// Postgres of FS-57. It never skips: without a docker daemon the run fails
// instead of pretending to have verified the schema.
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "../../test-support/isolated-pg";
import { advanceDirectoryWatermark } from "./enterprise-directory";

const dockerAvailable = await isDockerAvailable();

if (!dockerAvailable) {
  throw new Error(
    "[@megaui/database] enterprise-directory.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

let isolated: IsolatedPostgres;
let pool: Pool;
const SCOPE = "scope-hash-1";

async function insertSnapshot(row: {
  id: string;
  scopeHash?: string;
  generation: number;
  complete?: boolean;
}): Promise<void> {
  await pool.query(
    `insert into "enterprise_directory_snapshots"
       (id, scope_hash, generation, complete, observed_at)
     values ($1, $2, $3, $4, now())`,
    [row.id, row.scopeHash ?? SCOPE, row.generation, row.complete ?? false],
  );
}

describe("enterprise directory snapshot and watermark schema (FS-56)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    await pool.query(
      `insert into "enterprise_directory_watermarks" (id, scope_hash, generation)
       values ($1, $2, $3)`,
      ["watermark-1", SCOPE, 1],
    );
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (isolated) await isolated.destroy();
  }, 120_000);

  it("identifies a snapshot by its scope and generation", async () => {
    await insertSnapshot({ id: "snapshot-1", generation: 1 });
    await expect(insertSnapshot({ id: "snapshot-2", generation: 1 })).rejects.toThrow(
      /enterprise_directory_snapshots_scope_generation_uidx/,
    );

    // Another generation or another scope is another snapshot.
    await insertSnapshot({ id: "snapshot-3", generation: 2 });
    await insertSnapshot({ id: "snapshot-4", scopeHash: "scope-hash-2", generation: 1 });
  });

  it("commits the completion flag inside a transaction", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into "enterprise_directory_snapshots" (id, scope_hash, generation, observed_at)
         values ($1, $2, $3, now())`,
        ["snapshot-tx-1", SCOPE, 10],
      );
      // The last page sets the flag in the same transaction.
      await client.query(
        `update "enterprise_directory_snapshots" set complete = true, completed_at = now()
          where id = $1`,
        ["snapshot-tx-1"],
      );
      await client.query("rollback");
    } finally {
      client.release();
    }

    // The rolled back completion flag never became visible.
    const absent = await pool.query(`select id from "enterprise_directory_snapshots" where id = $1`, [
      "snapshot-tx-1",
    ]);
    expect(absent.rows).toHaveLength(0);

    const client2 = await pool.connect();
    try {
      await client2.query("begin");
      await client2.query(
        `insert into "enterprise_directory_snapshots" (id, scope_hash, generation, observed_at)
         values ($1, $2, $3, now())`,
        ["snapshot-tx-2", SCOPE, 11],
      );
      await client2.query(
        `update "enterprise_directory_snapshots" set complete = true, completed_at = now()
          where id = $1`,
        ["snapshot-tx-2"],
      );
      await client2.query("commit");
    } finally {
      client2.release();
    }

    const committed = await pool.query<{ complete: boolean }>(
      `select complete from "enterprise_directory_snapshots" where id = $1`,
      ["snapshot-tx-2"],
    );
    expect(committed.rows[0]?.complete).toBe(true);
  });

  it("keeps the latest generation on an identity watermark", async () => {
    await pool.query(
      `insert into "enterprise_directory_identity_watermarks"
         (id, identity_id, scope_hash, generation)
       values ($1, $2, $3, $4)`,
      ["identity-watermark-1", "identity-1", SCOPE, 4],
    );
    await expect(
      pool.query(
        `insert into "enterprise_directory_identity_watermarks"
           (id, identity_id, scope_hash, generation)
         values ($1, $2, $3, $4)`,
        ["identity-watermark-2", "identity-1", SCOPE, 5],
      ),
    ).rejects.toThrow(/enterprise_directory_identity_watermarks_identity_uidx/);

    await pool.query(
      `update "enterprise_directory_identity_watermarks" set generation = $1 where identity_id = $2`,
      [6, "identity-1"],
    );
    const stored = await pool.query<{ generation: number }>(
      `select generation from "enterprise_directory_identity_watermarks" where identity_id = $1`,
      ["identity-1"],
    );
    expect(stored.rows[0]?.generation).toBe(6);
  });

  it("supports a freshness query on the observation time", async () => {
    const index = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'enterprise_directory_snapshots'
          and indexname = 'enterprise_directory_snapshots_scope_observed_idx'`,
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]?.indexdef).toContain("scope_hash");
    expect(index.rows[0]?.indexdef).toContain("observed_at");

    const fresh = await pool.query<{ generation: number }>(
      `select generation from "enterprise_directory_snapshots"
        where scope_hash = $1 and complete = true
        order by observed_at desc limit 1`,
      [SCOPE],
    );
    expect(fresh.rows[0]?.generation).toBe(11);
  });

  it("refuses an out-of-order generation with a compare-and-set", async () => {
    // A higher generation advances the watermark.
    expect(await advanceDirectoryWatermark(pool, SCOPE, 7)).toBe(true);

    // An older or equal generation is refused.
    expect(await advanceDirectoryWatermark(pool, SCOPE, 6)).toBe(false);
    expect(await advanceDirectoryWatermark(pool, SCOPE, 7)).toBe(false);

    const stored = await pool.query<{ generation: number }>(
      `select generation from "enterprise_directory_watermarks" where scope_hash = $1`,
      [SCOPE],
    );
    expect(stored.rows[0]?.generation).toBe(7);
  });
});
