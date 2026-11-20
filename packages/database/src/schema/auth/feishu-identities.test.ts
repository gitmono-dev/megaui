// megaui-only (FSL-120): Feishu identity binding table schema and forward-only migration recovery.
import { createHash, createHmac } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedPostgres, resolveMigrationsFolder, type IsolatedPostgres } from "../../test-support/isolated-pg";

const TABLE = "feishu_identities";
const MEMBER_UNIQUE = "feishu_identities_app_open_id_hmac_unique";
const USER_APP_UNIQUE = "feishu_identities_user_app_unique";
const HMAC_CHECK = "feishu_identities_open_id_hmac_check";
const USER_FK = "feishu_identities_user_id_user_id_fk";

// Synthetic values only: the key, app ids and open ids below are not real tenant data.
const KEY = "synthetic-test-key";
const APP_A = "cli_synthetic_app_a";
const APP_B = "cli_synthetic_app_b";
const openIdHmac = (appId: string, openId: string) =>
  createHmac("sha256", KEY).update(`feishu-identity:v1:${appId}:${openId}`).digest("hex");

describe("feishu identity binding table (FSL-120)", () => {
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

    directory = mkdtempSync(join(tmpdir(), "megaui-fsl120-migrations-"));
    cpSync(source, directory, { recursive: true });
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, position) }));
    await migrate(drizzle(pool), { migrationsFolder: directory });
    expect((await pool.query("select to_regclass($1) as name", [`public.${TABLE}`])).rows[0]?.name).toBeNull();
    ledgerBefore = (await pool.query<{ hash: string }>("select * from drizzle.__drizzle_migrations order by id")).rows;

    // Inject an SQL fault after both generated statements (table and foreign key) of this migration.
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
    await pool.query(`delete from "user" where id like 'fsl120-%'`);
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    try { if (directory) rmSync(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FSL-120 fixture cleanup failed");
  }, 120_000);

  async function createUser(id: string): Promise<void> {
    await pool.query(`insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)`,
      [id, `Synthetic ${id}`, `${id}@example.test`]);
  }

  async function bind(appId: string, hmac: string, userId: string): Promise<void> {
    await pool.query(`insert into ${TABLE} (app_id, open_id_hmac, user_id) values ($1, $2, $3)`, [appId, hmac, userId]);
  }

  const rows = async () => (await pool.query<{ app_id: string; open_id_hmac: string; user_id: string }>(
    `select app_id, open_id_hmac, user_id from ${TABLE} order by user_id, app_id`)).rows;

  it("AC1: has exactly app_id, open_id_hmac, user_id and created_at, and no open_id column", async () => {
    const columns = (await pool.query(`select column_name, data_type, is_nullable, column_default
        from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`, [TABLE])).rows;
    expect(columns).toEqual([
      { column_name: "app_id", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "open_id_hmac", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "user_id", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
    ]);
    expect(columns.map(column => column.column_name)).not.toContain("open_id");
  });

  it("AC1: stores the 64-character hex HMAC and rejects any other open_id_hmac shape", async () => {
    await createUser("fsl120-a");
    const hmac = openIdHmac(APP_A, "ou_synthetic_a");
    await bind(APP_A, hmac, "fsl120-a");
    expect(await rows()).toEqual([{ app_id: APP_A, open_id_hmac: hmac, user_id: "fsl120-a" }]);
    for (const bad of ["ou_synthetic_a", hmac.toUpperCase(), hmac.slice(1), `${hmac}0`, ""]) {
      await expect(bind(APP_B, bad, "fsl120-a")).rejects.toMatchObject({ code: "23514", constraint: HMAC_CHECK });
    }
    expect(await rows()).toHaveLength(1);
  });

  it("AC2: deleting a user cascades to its bindings and leaves other users' bindings", async () => {
    await createUser("fsl120-a");
    await createUser("fsl120-b");
    await bind(APP_A, openIdHmac(APP_A, "ou_synthetic_a"), "fsl120-a");
    await bind(APP_B, openIdHmac(APP_B, "ou_synthetic_a"), "fsl120-a");
    await bind(APP_A, openIdHmac(APP_A, "ou_synthetic_b"), "fsl120-b");
    await pool.query(`delete from "user" where id = $1`, ["fsl120-a"]);
    expect(await rows()).toEqual([{ app_id: APP_A, open_id_hmac: openIdHmac(APP_A, "ou_synthetic_b"), user_id: "fsl120-b" }]);
  });

  it("AC2: rejects a binding to a user that does not exist", async () => {
    await expect(bind(APP_A, openIdHmac(APP_A, "ou_synthetic_a"), "fsl120-missing"))
      .rejects.toMatchObject({ code: "23503", constraint: USER_FK });
  });

  it("AC3: rejects a duplicate (app_id, open_id_hmac) insert", async () => {
    await createUser("fsl120-a");
    await createUser("fsl120-b");
    const hmac = openIdHmac(APP_A, "ou_synthetic_a");
    await bind(APP_A, hmac, "fsl120-a");
    // The same HMAC under another app is a different member.
    await bind(APP_B, hmac, "fsl120-b");
    await expect(bind(APP_A, hmac, "fsl120-b")).rejects.toMatchObject({ code: "23505", constraint: MEMBER_UNIQUE });
    expect(await rows()).toHaveLength(2);
  });

  it("AC4: rejects a duplicate (user_id, app_id) insert", async () => {
    await createUser("fsl120-a");
    await bind(APP_A, openIdHmac(APP_A, "ou_synthetic_a"), "fsl120-a");
    // The same user may carry one binding per app.
    await bind(APP_B, openIdHmac(APP_B, "ou_synthetic_a"), "fsl120-a");
    await expect(bind(APP_A, openIdHmac(APP_A, "ou_synthetic_other"), "fsl120-a"))
      .rejects.toMatchObject({ code: "23505", constraint: USER_APP_UNIQUE });
    expect(await rows()).toHaveLength(2);
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
    expect(hashes.slice(0, ledgerBefore.length)).toEqual(ledgerBefore.map(row => row.hash));
  });

  it("adds exactly this table, with its constraints, to the prior generated snapshot", () => {
    const readSnapshot = (tag: string) => JSON.parse(readFileSync(join(source, `meta/${tag.split("_")[0]}_snapshot.json`), "utf8"));
    const previous = readSnapshot(previousTag);
    const current = readSnapshot(migrationTag);
    expect(current.prevId).toBe(previous.id);
    const table = current.tables[`public.${TABLE}`];
    expect(Object.keys(table.columns)).toEqual(["app_id", "open_id_hmac", "user_id", "created_at"]);
    expect(Object.keys(table.uniqueConstraints).sort()).toEqual([MEMBER_UNIQUE, USER_APP_UNIQUE]);
    expect(Object.keys(table.checkConstraints)).toEqual([HMAC_CHECK]);
    expect(table.foreignKeys[USER_FK]).toMatchObject({ tableTo: "user", columnsFrom: ["user_id"], columnsTo: ["id"], onDelete: "cascade" });
    expect(table.indexes).toEqual({});
    delete current.tables[`public.${TABLE}`];
    expect(current).toEqual({ ...previous, id: current.id, prevId: previous.id });
  });
});
