// megaui-only (FSL-163): Feishu login code table indexes and forward-only migration recovery.
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
const FLOW_SEQ = "feishu_login_codes_flow_seq_uidx";
const EMAIL_CREATED = "feishu_login_codes_email_created_at_idx";
const EMAIL_SEQ = "feishu_login_codes_email_seq_uidx";
const CREATED = "feishu_login_codes_created_at_idx";
const INDEXES = [FLOW_SEQ, EMAIL_CREATED, EMAIL_SEQ, CREATED] as const;
const DEFINITIONS: Record<(typeof INDEXES)[number], string> = {
  [FLOW_SEQ]: `CREATE UNIQUE INDEX ${FLOW_SEQ} ON public.${TABLE} USING btree (flow_hash, flow_seq)`,
  [EMAIL_CREATED]: `CREATE INDEX ${EMAIL_CREATED} ON public.${TABLE} USING btree (email_hmac, created_at)`,
  [EMAIL_SEQ]: `CREATE UNIQUE INDEX ${EMAIL_SEQ} ON public.${TABLE} USING btree (email_hmac, email_seq)`,
  [CREATED]: `CREATE INDEX ${CREATED} ON public.${TABLE} USING btree (created_at)`,
};

describe("feishu login code table indexes (FSL-163)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  let directory: string | undefined;
  let migrationTag: string;
  let previousTag: string;
  let migrationHash: string;
  let ledgerBefore: { hash: string }[];
  let faultRejected = false;
  const indexesAfterFault: Record<string, unknown> = {};
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
      readFileSync(join(source, `${entry.tag}.sql`), "utf8").includes(`CREATE UNIQUE INDEX "${FLOW_SEQ}"`));
    expect(position).toBeGreaterThan(0);
    migrationTag = journal.entries[position]!.tag;
    previousTag = journal.entries[position - 1]!.tag;
    const originalSql = readFileSync(join(source, `${migrationTag}.sql`), "utf8");
    migrationHash = createHash("sha256").update(originalSql).digest("hex");

    directory = mkdtempSync(join(tmpdir(), "megaui-fsl163-migrations-"));
    cpSync(source, directory, { recursive: true });
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, position) }));
    await migrate(drizzle(pool), { migrationsFolder: directory });
    expect((await pool.query("select to_regclass($1) as name", [`public.${TABLE}`])).rows[0]?.name).toBe(TABLE);
    ledgerBefore = (await pool.query<{ hash: string }>("select * from drizzle.__drizzle_migrations order by id")).rows;

    // Inject an SQL fault after all four generated index statements of this migration.
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, position + 1) }));
    writeFileSync(join(directory, `${migrationTag}.sql`), originalSql + "\n--> statement-breakpoint\nSELECT 1 / 0;");
    await expect(migrate(drizzle(pool), { migrationsFolder: directory })).rejects.toThrow();
    faultRejected = true;
    for (const name of INDEXES) {
      indexesAfterFault[name] = (await pool.query("select to_regclass($1) as name", [`public.${name}`])).rows[0]?.name;
    }
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
    if (errors.length) throw new AggregateError(errors, "FSL-163 fixture cleanup failed");
  }, 120_000);

  async function insert(row: { flowHash: string; flowSeq: number; emailHmac: string; emailSeq: number }): Promise<void> {
    await pool.query(`insert into ${TABLE} (id, flow_hash, flow_seq, email_hmac, email_seq, state, expires_at)
      values (gen_random_uuid(), $1, $2, $3, $4, 'reserved', now() + interval '5 minutes')`,
    [row.flowHash, row.flowSeq, row.emailHmac, row.emailSeq]);
  }

  async function indexDefinition(name: string): Promise<{ indexdef: string }[]> {
    return (await pool.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname='public' and tablename=$1 and indexname=$2", [TABLE, name])).rows;
  }

  const flowA = "a".repeat(64);
  const flowB = "b".repeat(64);
  const emailA = "c".repeat(64);
  const emailB = "d".repeat(64);
  const count = async () => (await pool.query(`select count(*)::int as n from ${TABLE}`)).rows[0]?.n;

  it("AC1: has the unique index (flow_hash, flow_seq)", async () => {
    expect(await indexDefinition(FLOW_SEQ)).toEqual([{ indexdef: DEFINITIONS[FLOW_SEQ] }]);
  });

  it("AC2: rejects a duplicate (flow_hash, flow_seq) insert", async () => {
    await insert({ flowHash: flowA, flowSeq: 1, emailHmac: emailA, emailSeq: 1 });
    await insert({ flowHash: flowA, flowSeq: 2, emailHmac: emailA, emailSeq: 2 });
    await insert({ flowHash: flowB, flowSeq: 1, emailHmac: emailA, emailSeq: 3 });
    await expect(insert({ flowHash: flowA, flowSeq: 1, emailHmac: emailB, emailSeq: 1 }))
      .rejects.toMatchObject({ code: "23505", constraint: FLOW_SEQ });
    expect(await count()).toBe(3);
  });

  it("AC3: has the unique index (email_hmac, email_seq)", async () => {
    expect(await indexDefinition(EMAIL_SEQ)).toEqual([{ indexdef: DEFINITIONS[EMAIL_SEQ] }]);
  });

  it("AC4: rejects a duplicate (email_hmac, email_seq) insert across flows", async () => {
    await insert({ flowHash: flowA, flowSeq: 1, emailHmac: emailA, emailSeq: 1 });
    await insert({ flowHash: flowB, flowSeq: 1, emailHmac: emailA, emailSeq: 2 });
    await insert({ flowHash: flowB, flowSeq: 2, emailHmac: emailB, emailSeq: 1 });
    await expect(insert({ flowHash: flowB, flowSeq: 3, emailHmac: emailA, emailSeq: 1 }))
      .rejects.toMatchObject({ code: "23505", constraint: EMAIL_SEQ });
    expect(await count()).toBe(3);
  });

  it("AC5: has the index (email_hmac, created_at)", async () => {
    expect(await indexDefinition(EMAIL_CREATED)).toEqual([{ indexdef: DEFINITIONS[EMAIL_CREATED] }]);
  });

  it("AC6: has the index (created_at)", async () => {
    expect(await indexDefinition(CREATED)).toEqual([{ indexdef: DEFINITIONS[CREATED] }]);
  });

  it("has exactly the primary key and the four indexes on the table", async () => {
    const names = (await pool.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname='public' and tablename=$1 order by indexname", [TABLE])).rows;
    expect(names.map(row => row.indexname)).toEqual([...INDEXES, `${TABLE}_pkey`].sort());
  });

  it("AC7: the injected SQL fault leaves none of the four indexes behind", () => {
    expect(faultRejected).toBe(true);
    expect(indexesAfterFault).toEqual(Object.fromEntries(INDEXES.map(name => [name, null])));
  });

  it("AC8: the injected SQL fault leaves the journal without this migration", () => {
    expect(faultRejected).toBe(true);
    expect(ledgerAfterFault).toEqual(ledgerBefore);
    expect(ledgerAfterFault.map(row => row.hash)).not.toContain(migrationHash);
  });

  it("applies the generated migration forward after the fault and records it once", async () => {
    const hashes = (await pool.query<{ hash: string }>("select hash from drizzle.__drizzle_migrations order by id")).rows.map(row => row.hash);
    expect(hashes.filter(hash => hash === migrationHash)).toHaveLength(1);
    expect(hashes.slice(0, ledgerBefore.length)).toEqual(ledgerBefore.map(row => row.hash));
  });

  it("adds exactly the four indexes to the prior generated snapshot and SQL", () => {
    const readSnapshot = (tag: string) => JSON.parse(readFileSync(join(source, `meta/${tag.split("_")[0]}_snapshot.json`), "utf8"));
    const previous = readSnapshot(previousTag);
    const current = readSnapshot(migrationTag);
    expect(current.prevId).toBe(previous.id);
    const indexes = current.tables[`public.${TABLE}`].indexes as Record<string, { isUnique: boolean; columns: { expression: string }[] }>;
    expect(Object.fromEntries(Object.entries(indexes).map(([name, index]) =>
      [name, { unique: index.isUnique, columns: index.columns.map(column => column.expression) }]))).toEqual({
      [FLOW_SEQ]: { unique: true, columns: ["flow_hash", "flow_seq"] },
      [EMAIL_CREATED]: { unique: false, columns: ["email_hmac", "created_at"] },
      [EMAIL_SEQ]: { unique: true, columns: ["email_hmac", "email_seq"] },
      [CREATED]: { unique: false, columns: ["created_at"] },
    });
    current.tables[`public.${TABLE}`].indexes = {};
    expect(current).toEqual({ ...previous, id: current.id, prevId: previous.id });
    expect(readFileSync(join(source, `${migrationTag}.sql`), "utf8").trim().split("--> statement-breakpoint\n")).toEqual([
      `CREATE UNIQUE INDEX "${FLOW_SEQ}" ON "${TABLE}" USING btree ("flow_hash","flow_seq");`,
      `CREATE INDEX "${EMAIL_CREATED}" ON "${TABLE}" USING btree ("email_hmac","created_at");`,
      `CREATE UNIQUE INDEX "${EMAIL_SEQ}" ON "${TABLE}" USING btree ("email_hmac","email_seq");`,
      `CREATE INDEX "${CREATED}" ON "${TABLE}" USING btree ("created_at");`,
    ]);
  });
});
