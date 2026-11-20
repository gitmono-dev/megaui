// megaui-only (FSL-147): Feishu session source table schema and forward-only migration recovery.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedPostgres, resolveMigrationsFolder, type IsolatedPostgres } from "../../test-support/isolated-pg";

const TABLE = "feishu_login_sessions";
const PRIMARY_KEY = "feishu_login_sessions_pkey";
const SESSION_FK = "feishu_login_sessions_session_id_session_id_fk";

describe("feishu login session source table (FSL-147)", () => {
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

    directory = mkdtempSync(join(tmpdir(), "megaui-fsl147-migrations-"));
    cpSync(source, directory, { recursive: true });
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, position) }));
    await migrate(drizzle(pool), { migrationsFolder: directory });
    expect((await pool.query("select to_regclass($1) as name", [`public.${TABLE}`])).rows[0]?.name).toBeNull();
    ledgerBefore = (await pool.query<{ hash: string }>("select * from drizzle.__drizzle_migrations order by id")).rows;

    // Inject an SQL fault after both generated statements (table and foreign key) of this migration.
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, position + 1) }));
    writeFileSync(join(directory, `${migrationTag}.sql`), originalSql + "\n--> statement-breakpoint\nSELECT 1 / 0;");
    const fault = await migrate(drizzle(pool), { migrationsFolder: directory }).then(() => undefined, (error: unknown) => error);
    // The failure must come from the injected division by zero (SQLSTATE 22012), i.e. after both generated
    // statements ran, not from an earlier unrelated error.
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
    await pool.query(`delete from "session" where id like 'fsl147-%'`);
    await pool.query(`delete from "user" where id like 'fsl147-%'`);
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    try { if (directory) rmSync(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FSL-147 fixture cleanup failed");
  }, 120_000);

  // Synthetic values only: no real tenant data.
  async function createUser(id: string): Promise<void> {
    await pool.query(`insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)`,
      [id, `Synthetic ${id}`, `${id}@example.test`]);
  }

  async function createSession(id: string, userId: string): Promise<void> {
    await pool.query(`insert into "session" (id, expires_at, token, user_id) values ($1, now() + interval '8 hours', $2, $3)`,
      [id, `token-${id}`, userId]);
  }

  async function mark(sessionId: string): Promise<void> {
    await pool.query(`insert into ${TABLE} (session_id) values ($1)`, [sessionId]);
  }

  const marked = async () => (await pool.query<{ session_id: string }>(
    `select session_id from ${TABLE} order by session_id`)).rows.map(row => row.session_id);

  it("AC1: has exactly session_id and created_at", async () => {
    const columns = (await pool.query(`select column_name, data_type, is_nullable, column_default
        from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`, [TABLE])).rows;
    expect(columns).toEqual([
      { column_name: "session_id", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
    ]);
    const constraints = (await pool.query<{ conname: string; definition: string }>(
      `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = $1::regclass order by conname`, [`public.${TABLE}`])).rows;
    expect(constraints).toEqual([
      { conname: PRIMARY_KEY, definition: "PRIMARY KEY (session_id)" },
      { conname: SESSION_FK, definition: "FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE" },
    ]);
  });

  it("AC1: records a session ID with a server-side creation time", async () => {
    await createUser("fsl147-u");
    await createSession("fsl147-s1", "fsl147-u");
    await mark("fsl147-s1");
    const rows = (await pool.query<{ session_id: string; fresh: boolean }>(
      `select session_id, created_at > now() - interval '1 minute' as fresh from ${TABLE}`)).rows;
    expect(rows).toEqual([{ session_id: "fsl147-s1", fresh: true }]);
  });

  it("AC1: rejects a row for a session that does not exist", async () => {
    await expect(mark("fsl147-missing")).rejects.toMatchObject({ code: "23503", constraint: SESSION_FK });
    expect(await marked()).toEqual([]);
  });

  it("AC2: rejects a duplicate session_id insert", async () => {
    await createUser("fsl147-u");
    await createSession("fsl147-s1", "fsl147-u");
    await mark("fsl147-s1");
    await expect(mark("fsl147-s1")).rejects.toMatchObject({ code: "23505", constraint: PRIMARY_KEY });
    expect(await marked()).toEqual(["fsl147-s1"]);
  });

  it("AC3: deleting a session cascades to its row and leaves other sessions' rows", async () => {
    await createUser("fsl147-u");
    await createSession("fsl147-s1", "fsl147-u");
    await createSession("fsl147-s2", "fsl147-u");
    await mark("fsl147-s1");
    await mark("fsl147-s2");
    await pool.query(`delete from "session" where id = $1`, ["fsl147-s1"]);
    expect(await marked()).toEqual(["fsl147-s2"]);
  });

  it("AC3: deleting a user cascades through its sessions to their rows", async () => {
    await createUser("fsl147-u");
    await createSession("fsl147-s1", "fsl147-u");
    await mark("fsl147-s1");
    await pool.query(`delete from "user" where id = $1`, ["fsl147-u"]);
    expect(await marked()).toEqual([]);
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

  it("adds exactly this table, with its key and foreign key, to the prior generated snapshot", () => {
    const readSnapshot = (tag: string) => JSON.parse(readFileSync(join(source, `meta/${tag.split("_")[0]}_snapshot.json`), "utf8"));
    const previous = readSnapshot(previousTag);
    const current = readSnapshot(migrationTag);
    expect(current.prevId).toBe(previous.id);
    const table = current.tables[`public.${TABLE}`];
    expect(Object.keys(table.columns)).toEqual(["session_id", "created_at"]);
    expect(table.columns.session_id).toMatchObject({ type: "text", primaryKey: true, notNull: true });
    expect(table.foreignKeys[SESSION_FK]).toMatchObject({ tableTo: "session", columnsFrom: ["session_id"], columnsTo: ["id"], onDelete: "cascade" });
    expect(Object.keys(table.foreignKeys)).toEqual([SESSION_FK]);
    expect(table.indexes).toEqual({});
    expect(table.uniqueConstraints).toEqual({});
    expect(table.checkConstraints).toEqual({});
    delete current.tables[`public.${TABLE}`];
    expect(current).toEqual({ ...previous, id: current.id, prevId: previous.id });
  });
});
