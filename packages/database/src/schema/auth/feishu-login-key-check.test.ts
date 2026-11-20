// megaui-only (FSL-159): Feishu login key fingerprint table schema and forward-only migration recovery.
import { createHash, createHmac } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedPostgres, resolveMigrationsFolder, type IsolatedPostgres } from "../../test-support/isolated-pg";

const TABLE = "feishu_login_key_check";
const PRIMARY_KEY = "feishu_login_key_check_pkey";
const SINGLE_ROW_CHECK = "feishu_login_key_check_single_row_check";
const FORMAT_CHECK = "feishu_login_key_check_key_check_check";

// Synthetic values only: neither a real key nor a real app ID.
const fingerprint = (key: string, appId: string) =>
  createHmac("sha256", key).update(`feishu-login-key-check:v1:${appId}`).digest("hex");
const KEY_CHECK = fingerprint("synthetic-fsl159-key", "cli_synthetic_fsl159");
const OTHER_KEY_CHECK = fingerprint("synthetic-fsl159-other-key", "cli_synthetic_fsl159");

describe("feishu login key fingerprint table (FSL-159)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  let directory: string | undefined;
  let migrationTag: string;
  let previousTag: string;
  let migrationHash: string;
  let ledgerBefore: { hash: string }[];
  let faultRejected = false;
  let tableAfterFault: unknown = "unchecked";
  let ledgerAfterFault: { hash: string }[] = [];
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

    directory = mkdtempSync(join(tmpdir(), "megaui-fsl159-migrations-"));
    cpSync(source, directory, { recursive: true });
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, position) }));
    await migrate(drizzle(pool), { migrationsFolder: directory });
    expect((await pool.query("select to_regclass($1) as name", [`public.${TABLE}`])).rows[0]?.name).toBeNull();
    ledgerBefore = (await pool.query<{ hash: string }>("select * from drizzle.__drizzle_migrations order by id")).rows;

    // Inject an SQL fault after the generated CREATE TABLE statement of this migration.
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, position + 1) }));
    writeFileSync(join(directory, `${migrationTag}.sql`), originalSql + "\n--> statement-breakpoint\nSELECT 1 / 0;");
    const fault = await migrate(drizzle(pool), { migrationsFolder: directory }).then(() => undefined, (error: unknown) => error);
    // The failure must come from the injected division by zero (SQLSTATE 22012), i.e. after the generated
    // statement ran, not from an earlier unrelated error.
    const codes: unknown[] = [];
    for (let cause: unknown = fault; cause && typeof cause === "object"; cause = (cause as { cause?: unknown }).cause) {
      codes.push((cause as { code?: unknown }).code);
    }
    expect(codes).toContain("22012");
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
    if (errors.length) throw new AggregateError(errors, "FSL-159 fixture cleanup failed");
  }, 120_000);

  const rows = async () => (await pool.query<{ id: number; key_check: string }>(
    `select id, key_check from ${TABLE} order by id`)).rows;

  it("AC1: has exactly id, key_check and created_at", async () => {
    const columns = (await pool.query(`select column_name, data_type, is_nullable, column_default
        from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`, [TABLE])).rows;
    expect(columns).toEqual([
      { column_name: "id", data_type: "integer", is_nullable: "NO", column_default: "1" },
      { column_name: "key_check", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
    ]);
    const constraints = (await pool.query<{ conname: string; definition: string }>(
      `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = $1::regclass order by conname`, [`public.${TABLE}`])).rows;
    expect(constraints).toEqual([
      { conname: FORMAT_CHECK, definition: "CHECK ((key_check ~ '^[0-9a-f]{64}$'::text))" },
      { conname: PRIMARY_KEY, definition: "PRIMARY KEY (id)" },
      { conname: SINGLE_ROW_CHECK, definition: "CHECK ((id = 1))" },
    ]);
  });

  it("AC1: stores one fingerprint with id 1 and a server-side creation time", async () => {
    await pool.query(`insert into ${TABLE} (key_check) values ($1)`, [KEY_CHECK]);
    const stored = (await pool.query<{ id: number; key_check: string; fresh: boolean }>(
      `select id, key_check, created_at > now() - interval '1 minute' as fresh from ${TABLE}`)).rows;
    expect(stored).toEqual([{ id: 1, key_check: KEY_CHECK, fresh: true }]);
  });

  it("only accepts a lowercase 64-hex value (the format of the HMAC fingerprint)", async () => {
    for (const value of ["synthetic-fsl159-key", KEY_CHECK.toUpperCase(), KEY_CHECK.slice(1), `${KEY_CHECK}0`, ""]) {
      await expect(pool.query(`insert into ${TABLE} (id, key_check) values (1, $1)`, [value]))
        .rejects.toMatchObject({ code: "23514", constraint: FORMAT_CHECK });
    }
    expect(await rows()).toEqual([]);
  });

  it("AC2: rejects an insert whose id is not 1", async () => {
    for (const id of [0, 2, -1]) {
      await expect(pool.query(`insert into ${TABLE} (id, key_check) values ($1, $2)`, [id, KEY_CHECK]))
        .rejects.toMatchObject({ code: "23514", constraint: SINGLE_ROW_CHECK });
    }
    expect(await rows()).toEqual([]);
  });

  it("AC2: rejects moving the existing row to an id other than 1", async () => {
    await pool.query(`insert into ${TABLE} (key_check) values ($1)`, [KEY_CHECK]);
    await expect(pool.query(`update ${TABLE} set id = 2`))
      .rejects.toMatchObject({ code: "23514", constraint: SINGLE_ROW_CHECK });
    expect(await rows()).toEqual([{ id: 1, key_check: KEY_CHECK }]);
  });

  it("AC3: rejects a second insert while a row exists, with or without an explicit id", async () => {
    await pool.query(`insert into ${TABLE} (key_check) values ($1)`, [KEY_CHECK]);
    await expect(pool.query(`insert into ${TABLE} (key_check) values ($1)`, [OTHER_KEY_CHECK]))
      .rejects.toMatchObject({ code: "23505", constraint: PRIMARY_KEY });
    await expect(pool.query(`insert into ${TABLE} (id, key_check) values (1, $1)`, [KEY_CHECK]))
      .rejects.toMatchObject({ code: "23505", constraint: PRIMARY_KEY });
    expect(await rows()).toEqual([{ id: 1, key_check: KEY_CHECK }]);
  });

  it("AC4: the injected SQL fault leaves no table behind", () => {
    expect(faultRejected).toBe(true);
    expect(tableAfterFault).toBeNull();
  });

  it("AC5: the injected SQL fault leaves the journal without this migration", () => {
    expect(faultRejected).toBe(true);
    expect(ledgerAfterFault).toEqual(ledgerBefore);
    expect(ledgerAfterFault.map(row => row.hash)).not.toContain(migrationHash);
  });

  it("applies the generated migration forward after the fault and records it once", async () => {
    const hashes = (await pool.query<{ hash: string }>("select hash from drizzle.__drizzle_migrations order by id")).rows.map(row => row.hash);
    expect(hashes.filter(hash => hash === migrationHash)).toHaveLength(1);
    expect(hashes.slice(0, ledgerBefore.length)).toEqual(ledgerBefore.map(row => row.hash));
  });

  it("adds exactly this table, with its key and checks, to the prior generated snapshot", () => {
    const readSnapshot = (tag: string) => JSON.parse(readFileSync(join(source, `meta/${tag.split("_")[0]}_snapshot.json`), "utf8"));
    const previous = readSnapshot(previousTag);
    const current = readSnapshot(migrationTag);
    expect(current.prevId).toBe(previous.id);
    const table = current.tables[`public.${TABLE}`];
    expect(Object.keys(table.columns)).toEqual(["id", "key_check", "created_at"]);
    expect(table.columns.id).toMatchObject({ type: "integer", primaryKey: true, notNull: true, default: 1 });
    expect(Object.keys(table.checkConstraints).sort()).toEqual([FORMAT_CHECK, SINGLE_ROW_CHECK]);
    expect(table.foreignKeys).toEqual({});
    expect(table.indexes).toEqual({});
    expect(table.uniqueConstraints).toEqual({});
    delete current.tables[`public.${TABLE}`];
    expect(current).toEqual({ ...previous, id: current.id, prevId: previous.id });
  });
});
