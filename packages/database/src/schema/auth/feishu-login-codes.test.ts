// megaui-only (FSL-119): Feishu login code table schema and forward-only migration recovery.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedPostgres, resolveMigrationsFolder, type IsolatedPostgres } from "../../test-support/isolated-pg";

const TABLE = "feishu_login_codes";
const STATE_CHECK = "feishu_login_codes_state_check";
const HOLD_CHECK = "feishu_login_codes_hold_check";
const HELD = ["email", "open_id", "display_name", "code_hmac"] as const;
type Held = (typeof HELD)[number];
const HELD_VALUES: Record<Held, string> = {
  email: "member@example.test",
  open_id: "ou_synthetic_member",
  display_name: "Synthetic Member",
  code_hmac: "c".repeat(64),
};

describe("feishu login code table (FSL-119)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  let directory: string | undefined;
  let migrationTag: string;
  let previousTag: string;
  let migrationHash: string;
  let ledgerBefore: unknown[];
  let faultRejected = false;
  let tableAfterFault: unknown = "unchecked";
  let ledgerAfterFault: { hash: string }[] = [];
  let sequence = 0;
  const source = resolveMigrationsFolder();

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string; idx: number; when: number }[];
    };
    const position = journal.entries.findIndex(entry =>
      readFileSync(join(source, `${entry.tag}.sql`), "utf8").includes(`CREATE TABLE "${TABLE}"`));
    expect(position).toBeGreaterThan(0);
    migrationTag = journal.entries[position]!.tag;
    previousTag = journal.entries[position - 1]!.tag;
    const originalSql = readFileSync(join(source, `${migrationTag}.sql`), "utf8");
    migrationHash = createHash("sha256").update(originalSql).digest("hex");

    directory = mkdtempSync(join(tmpdir(), "megaui-fsl119-migrations-"));
    cpSync(source, directory, { recursive: true });
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, position) }));
    await migrate(drizzle(pool), { migrationsFolder: directory });
    ledgerBefore = (await pool.query("select * from drizzle.__drizzle_migrations order by id")).rows;

    // Inject an SQL fault after the generated statements of this migration.
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, position + 1) }));
    writeFileSync(join(directory, `${migrationTag}.sql`), originalSql + "\n--> statement-breakpoint\nSELECT 1 / 0;");
    await expect(migrate(drizzle(pool), { migrationsFolder: directory })).rejects.toThrow();
    faultRejected = true;
    tableAfterFault = (await pool.query("select to_regclass($1) as name", [`public.${TABLE}`])).rows[0]?.name;
    ledgerAfterFault = (await pool.query<{ hash: string }>("select * from drizzle.__drizzle_migrations order by id")).rows;

    // Forward recovery: the full generated set applies cleanly afterwards.
    await isolated.migrate();
  }, 120_000);

  beforeEach(async () => {
    await pool.query(`delete from ${TABLE}`);
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    try { if (directory) rmSync(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FSL-119 fixture cleanup failed");
  }, 120_000);

  async function insert(state: unknown, held: Partial<Record<Held, string | null>> = {}): Promise<void> {
    sequence += 1;
    const values = { ...HELD_VALUES, ...held };
    await pool.query(`insert into ${TABLE}
      (id, flow_hash, flow_seq, email_hmac, email_seq, email, open_id, display_name, code_hmac, state, expires_at)
      values (gen_random_uuid(), $1, $2, $3, $2, $4, $5, $6, $7, $8, now() + interval '5 minutes')`,
    ["a".repeat(64), sequence, "b".repeat(64), values.email, values.open_id, values.display_name, values.code_hmac, state]);
  }

  const nonePresent: Record<Held, null> = { email: null, open_id: null, display_name: null, code_hmac: null };

  it("AC1: has exactly the 13 columns, with only the four held columns nullable", async () => {
    const columns = (await pool.query(`select column_name, data_type, is_nullable, column_default
        from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`, [TABLE])).rows;
    expect(columns).toEqual([
      { column_name: "id", data_type: "uuid", is_nullable: "NO", column_default: null },
      { column_name: "flow_hash", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "flow_seq", data_type: "integer", is_nullable: "NO", column_default: null },
      { column_name: "email_hmac", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "email_seq", data_type: "integer", is_nullable: "NO", column_default: null },
      { column_name: "email", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "open_id", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "display_name", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "code_hmac", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "state", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "failed_attempts", data_type: "integer", is_nullable: "NO", column_default: "0" },
      { column_name: "expires_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: null },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
    ]);
    const primaryKey = (await pool.query(`select a.attname from pg_index i
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = $1::regclass and i.indisprimary`, [`public.${TABLE}`])).rows;
    expect(primaryKey).toEqual([{ attname: "id" }]);
  });

  it("AC2: rejects any state outside reserved, active, consumed and void", async () => {
    await insert("active");
    for (const state of ["reserved", "consumed", "void"]) await insert(state, nonePresent);
    expect((await pool.query(`select state from ${TABLE} order by flow_seq`)).rows.map(row => row.state))
      .toEqual(["active", "reserved", "consumed", "void"]);
    for (const state of ["pending", "expired", "ACTIVE", "", " void"]) {
      await expect(insert(state, nonePresent)).rejects.toMatchObject({ code: "23514", constraint: STATE_CHECK });
    }
    await expect(insert(null, nonePresent)).rejects.toMatchObject({ code: "23502", column: "state" });
  });

  it("AC3: rejects an active row when any held column is null", async () => {
    for (const column of HELD) {
      await expect(insert("active", { [column]: null })).rejects.toMatchObject({ code: "23514", constraint: HOLD_CHECK });
    }
    await expect(insert("active", nonePresent)).rejects.toMatchObject({ code: "23514", constraint: HOLD_CHECK });
    expect((await pool.query(`select count(*)::int as n from ${TABLE}`)).rows[0]?.n).toBe(0);
  });

  it("AC4: rejects a non-active row when any held column is present", async () => {
    for (const state of ["reserved", "consumed", "void"]) {
      for (const column of HELD) {
        await expect(insert(state, { ...nonePresent, [column]: HELD_VALUES[column] }))
          .rejects.toMatchObject({ code: "23514", constraint: HOLD_CHECK });
      }
      await expect(insert(state)).rejects.toMatchObject({ code: "23514", constraint: HOLD_CHECK });
    }
    expect((await pool.query(`select count(*)::int as n from ${TABLE}`)).rows[0]?.n).toBe(0);
  });

  it("AC4: rejects clearing or keeping held columns across a state update", async () => {
    await insert("active");
    await expect(pool.query(`update ${TABLE} set state='consumed'`))
      .rejects.toMatchObject({ code: "23514", constraint: HOLD_CHECK });
    await pool.query(`update ${TABLE} set state='consumed', email=null, open_id=null, display_name=null, code_hmac=null`);
    await expect(pool.query(`update ${TABLE} set state='active'`))
      .rejects.toMatchObject({ code: "23514", constraint: HOLD_CHECK });
  });

  it("AC5: the injected SQL fault leaves no table behind", () => {
    expect(faultRejected).toBe(true);
    expect(tableAfterFault).toBeNull();
  });

  it("AC6: the injected SQL fault leaves the journal without this migration", () => {
    expect(faultRejected).toBe(true);
    expect(ledgerAfterFault).toEqual(ledgerBefore);
    expect(ledgerAfterFault.map(row => row.hash)).not.toContain(migrationHash);
  });

  it("applies the generated migration forward after the fault and records it once", async () => {
    const hashes = (await pool.query<{ hash: string }>("select hash from drizzle.__drizzle_migrations order by id")).rows.map(row => row.hash);
    expect(hashes.filter(hash => hash === migrationHash)).toHaveLength(1);
    expect(hashes.slice(0, ledgerBefore.length)).toEqual((ledgerBefore as { hash: string }[]).map(row => row.hash));
  });

  it("adds exactly this table, with both CHECK constraints, to the prior generated snapshot", () => {
    const readSnapshot = (tag: string) => JSON.parse(readFileSync(join(source, `meta/${tag.split("_")[0]}_snapshot.json`), "utf8"));
    const previous = readSnapshot(previousTag);
    const current = readSnapshot(migrationTag);
    expect(current.prevId).toBe(previous.id);
    const table = current.tables[`public.${TABLE}`];
    expect(Object.keys(table.columns)).toHaveLength(13);
    expect(Object.keys(table.checkConstraints).sort()).toEqual([HOLD_CHECK, STATE_CHECK]);
    expect(table.indexes).toEqual({});
    delete current.tables[`public.${TABLE}`];
    expect(current).toEqual({ ...previous, id: current.id, prevId: previous.id });
    const sql = readFileSync(join(source, `${migrationTag}.sql`), "utf8");
    expect(sql).toContain(`CONSTRAINT "${STATE_CHECK}" CHECK`);
    expect(sql).toContain(`CONSTRAINT "${HOLD_CHECK}" CHECK`);
  });
});
