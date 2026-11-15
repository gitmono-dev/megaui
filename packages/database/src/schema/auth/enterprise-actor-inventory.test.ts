// megaui-only (FS-90): inventory constraints and forward-only migration recovery.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedPostgres, resolveMigrationsFolder, type IsolatedPostgres } from "../../test-support/isolated-pg";

describe("complete actor inventory schema (FS-90)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  let directory: string | undefined;
  let recovered = false;
  let oldReservation: unknown[];

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    const source = resolveMigrationsFolder();
    const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string; idx: number; when: number }[];
    };
    const inventoryIndex = journal.entries.findIndex((entry) =>
      readFileSync(join(source, `${entry.tag}.sql`), "utf8").includes('CREATE TABLE "enterprise_actor_inventory"'));
    if (inventoryIndex < 0) {
      await isolated.migrate();
    } else {
      directory = mkdtempSync(join(tmpdir(), "megaui-fs90-migrations-"));
      cpSync(source, directory, { recursive: true });
      writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({
        ...journal, entries: journal.entries.slice(0, inventoryIndex),
      }));
      await migrate(drizzle(pool), { migrationsFolder: directory });
      await pool.query(`insert into enterprise_actor_reservations
        (id, backend_username, actor_state, source_snapshot_digest)
        values ('legacy-reservation', 'legacy-actor', 'unclaimable', 'legacy-source')`);
      oldReservation = (await pool.query(`select * from enterprise_actor_reservations`)).rows;
      const ledgerBefore = (await pool.query(`select * from drizzle.__drizzle_migrations order by id`)).rows;
      const entry = journal.entries[inventoryIndex];
      if (!entry) throw new Error("missing inventory migration");
      writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({
        ...journal, entries: journal.entries.slice(0, inventoryIndex + 1),
      }));
      writeFileSync(join(directory, `${entry.tag}.sql`), readFileSync(join(source, `${entry.tag}.sql`), "utf8") +
        '\n--> statement-breakpoint\nSELECT 1 / 0;');
      await expect(migrate(drizzle(pool), { migrationsFolder: directory })).rejects.toThrow();
      expect((await pool.query(`select to_regclass('public.enterprise_actor_inventory') as name`)).rows[0]?.name).toBeNull();
      expect((await pool.query(`select * from drizzle.__drizzle_migrations order by id`)).rows).toEqual(ledgerBefore);
      await isolated.migrate();
      expect((await pool.query(`select * from enterprise_actor_reservations`)).rows).toEqual(oldReservation);
      recovered = true;
    }
    await pool.query(`insert into enterprise_policy
      (id, scope, owner_fingerprint, deployment_role, environment)
      values ('fs90', 'fs90-instance', 'megaui', 'test', 'test')`);
  }, 120_000);

  beforeEach(async () => {
    // The missing-table error is intentional in the initial TDD red run.
    await pool.query(`delete from enterprise_actor_inventory`);
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    try { if (directory) rmSync(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FS-90 fixture cleanup failed");
  }, 120_000);

  async function insert(overrides: Record<string, unknown> = {}): Promise<void> {
    const row = { scope: "fs90-instance", operationId: "00000000-0000-4000-8000-000000000090",
      sourceDigest: "a".repeat(64), subjectsDigest: "b".repeat(64), ownershipDigest: "c".repeat(64),
      observedAt: new Date(), actors: "[]", ...overrides };
    await pool.query(`insert into enterprise_actor_inventory
      (scope, operation_id, source_digest, subjects_digest, ownership_digest, observed_at, upstream_actors)
      values ($1, $2, $3, $4, $5, $6, $7)`,
    [row.scope, row.operationId, row.sourceDigest, row.subjectsDigest, row.ownershipDigest, row.observedAt, row.actors]);
  }

  it("rolls back interrupted DDL and journal, then retries forward without changing old reservations", async () => {
    expect(recovered).toBe(true);
    expect((await pool.query(`select * from enterprise_actor_reservations`)).rows).toEqual(oldReservation);
  });

  it("represents an approved empty inventory with its original observedAt", async () => {
    const observedAt = new Date("2026-11-11T00:00:00Z");
    await insert({ observedAt });
    expect((await pool.query(`select upstream_actors, observed_at from enterprise_actor_inventory`)).rows)
      .toEqual([{ upstream_actors: [], observed_at: observedAt }]);
  });

  it("requires a unique existing policy scope", async () => {
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
    await expect(insert({ scope: "foreign-instance" })).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects absent or malformed approval and digest fields", async () => {
    for (const field of ["operationId", "sourceDigest", "subjectsDigest", "ownershipDigest"]) {
      await expect(insert({ [field]: null })).rejects.toMatchObject({ code: "23502" });
      await expect(insert({ [field]: "invalid" })).rejects.toThrow();
    }
  });

  it("rejects non-finite observation times and non-array source JSON", async () => {
    for (const observedAt of ["infinity", "-infinity"]) {
      await expect(insert({ observedAt })).rejects.toMatchObject({ code: "23514" });
    }
    await expect(insert({ observedAt: null })).rejects.toMatchObject({ code: "23502" });
    for (const actors of ["null", "{}", '"invalid"']) {
      await expect(insert({ actors })).rejects.toMatchObject({ code: "23514" });
    }
  });
});
