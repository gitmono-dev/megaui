// megaui-only (FS-91): scoped pairing retention index and forward migration recovery.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedPostgres, resolveMigrationsFolder, type IsolatedPostgres } from "../../test-support/isolated-pg";

const INDEX = "enterprise_pairings_scope_retention_idx";
const runFile = promisify(execFile);
type PlanNode = { "Node Type": string; "Index Name"?: string; "Index Cond"?: string;
  "Actual Rows": number; "Rows Removed by Filter"?: number; Plans?: PlanNode[] };
function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

describe("scoped pairing cleanup index (FS-91)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  let directory: string | undefined;
  let beforeSchema: string;
  let beforeRows: Record<string, string[]>;
  let recovered = false;
  let migrationTag: string;
  let previousTag: string;
  const source = resolveMigrationsFolder();

  async function schemaDump(): Promise<string> {
    const { stdout } = await runFile("docker", ["exec", isolated.containerName, "pg_dump", "-U", "megaui",
      "-d", isolated.databaseName, "--schema-only"], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    // Recent pg_dump versions randomize these psql execution guards; they are not schema.
    return stdout.replace(/^\\(?:un)?restrict[^\n]*\n/gm, "");
  }

  function withoutNewIndex(dump: string): string {
    const block = /\n--\n-- Name: enterprise_pairings_scope_retention_idx; Type: INDEX; Schema: public; Owner: [^\n]*\n--\n\nCREATE INDEX enterprise_pairings_scope_retention_idx [^\n]*;\n\n/g;
    expect([...dump.matchAll(block)]).toHaveLength(1);
    return dump.replace(block, "");
  }

  async function businessRows(): Promise<Record<string, string[]>> {
    const tables = await pool.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public' order by tablename");
    const rows: Record<string, string[]> = {};
    for (const { tablename } of tables.rows) {
      const table = tablename.replace(/"/g, '""');
      rows[tablename] = (await pool.query<{ value: string }>(`select row_to_json(t)::text as value from public."${table}" t order by 1`)).rows.map(row => row.value);
    }
    return rows;
  }

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    expect((await pool.query("select current_database() as name")).rows[0]?.name).toBe(isolated.databaseName);
    expect(new URL(isolated.databaseUrl).hostname).toBe("127.0.0.1");
    const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const position = journal.entries.findIndex(entry => readFileSync(join(source, `${entry.tag}.sql`), "utf8").includes(`CREATE INDEX "${INDEX}"`));
    expect(position).toBeGreaterThan(0);
    migrationTag = journal.entries[position]!.tag;
    previousTag = journal.entries[position - 1]!.tag;
    directory = mkdtempSync(join(tmpdir(), "megaui-fs91-migrations-"));
    cpSync(source, directory, { recursive: true });
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, position) }));
    await migrate(drizzle(pool), { migrationsFolder: directory });
    await pool.query(`insert into "user" (id,name,email,email_verified,role) values ('fs91-user','Synthetic User','fs91@example.test',false,'admin');
      insert into "session" (id,user_id,token,expires_at) values ('fs91-session','fs91-user','fs91-synthetic-session','2030-01-01');
      insert into enterprise_identity (id,local_user_id,tenant_key,app_id,open_id,identity_version)
        values ('fs91-identity','fs91-user','tenant-a','app-a','open-a',7);
      insert into enterprise_policy (id,scope,owner_fingerprint,deployment_role,environment)
        values ('fs91-old','fs91-old','megaui','test','test');
      insert into enterprise_pairings (id,scope,deployment_role,tenant_key,app_id,flow_hash,generation,token_hash,intended_identity_id,state,
        confirmed_identity_version,confirmed_message_id,confirmed_at,created_at,expires_at,retain_until)
        values ('00000000-0000-4000-8000-000000000091','fs91-old','test','tenant-a','app-a',repeat('a',64),1,repeat('b',64),
          'fs91-identity','confirmed',7,'fs91-message','2026-11-11 00:00:10Z','2026-11-11 00:00:00Z','2026-11-11 00:02:00Z','2026-11-11 00:06:40Z');
      insert into enterprise_challenges (id,scope,deployment_role,local_user_id,identity_id,identity_version,flow_hash,generation,pairing_id,
        code_hmac,hmac_key_id,state,failed_attempts,created_at,expires_at,secret_expires_at)
        values ('00000000-0000-4000-8000-000000000092','fs91-old','test','fs91-user','fs91-identity',7,repeat('a',64),1,
          '00000000-0000-4000-8000-000000000091',repeat('c',64),'fs91-key','active',0,'2026-11-11 00:00:10Z','2026-11-11 00:05:10Z','2026-11-11 00:05:10Z')`);
    beforeSchema = await schemaDump();
    beforeRows = await businessRows();
    const ledger = (await pool.query("select * from drizzle.__drizzle_migrations order by id")).rows;
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, position + 1) }));
    const originalSql = readFileSync(join(source, `${migrationTag}.sql`), "utf8");
    writeFileSync(join(directory, `${migrationTag}.sql`), originalSql + "\n--> statement-breakpoint\nSELECT 1 / 0;");
    await expect(migrate(drizzle(pool), { migrationsFolder: directory })).rejects.toThrow();
    expect((await pool.query("select to_regclass($1) as name", [`public.${INDEX}`])).rows[0]?.name).toBeNull();
    expect((await pool.query("select * from drizzle.__drizzle_migrations order by id")).rows).toEqual(ledger);
    expect(await schemaDump()).toBe(beforeSchema);
    expect(await businessRows()).toEqual(beforeRows);
    writeFileSync(join(directory, `${migrationTag}.sql`), originalSql);
    await migrate(drizzle(pool), { migrationsFolder: directory });
    const applied = (await pool.query("select hash from drizzle.__drizzle_migrations order by id")).rows;
    expect(applied).toHaveLength(ledger.length + 1);
    expect(applied.at(-1)?.hash).toBe(createHash("sha256").update(originalSql).digest("hex"));
    expect(withoutNewIndex(await schemaDump())).toBe(beforeSchema);
    expect(await businessRows()).toEqual(beforeRows);
    recovered = true;
  }, 120_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    try { if (directory) rmSync(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FS-91 fixture cleanup failed");
  }, 120_000);

  it("provides the fixed scope, role, retention and id B-tree order", async () => {
    const result = await pool.query(`select indexdef from pg_indexes
      where schemaname='public' and tablename='enterprise_pairings'
        and indexname='enterprise_pairings_scope_retention_idx'`);
    expect(result.rows).toEqual([{ indexdef: "CREATE INDEX enterprise_pairings_scope_retention_idx ON public.enterprise_pairings USING btree (scope, deployment_role, retain_until, id)" }]);
  });

  it("rolls back DDL and journal on failure, then retries forward with the full old schema and data intact", async () => {
    expect(recovered).toBe(true);
    expect(withoutNewIndex(await schemaDump())).toBe(beforeSchema);
    expect(await businessRows()).toEqual(beforeRows);
  });

  it("re-applies the generated migration without changing schema, rows or journal", async () => {
    const ledger = (await pool.query("select * from drizzle.__drizzle_migrations order by id")).rows;
    const schema = await schemaDump();
    await migrate(drizzle(pool), { migrationsFolder: directory! });
    expect(await schemaDump()).toBe(schema);
    expect(await businessRows()).toEqual(beforeRows);
    expect((await pool.query("select * from drizzle.__drizzle_migrations order by id")).rows).toEqual(ledger);
  });

  it("adds exactly the one index to the prior generated snapshot and SQL", () => {
    const readSnapshot = (tag: string) => JSON.parse(readFileSync(join(source, `meta/${tag.split("_")[0]}_snapshot.json`), "utf8"));
    const previous = readSnapshot(previousTag);
    const current = readSnapshot(migrationTag);
    expect(current.prevId).toBe(previous.id);
    expect(current.tables["public.enterprise_pairings"].indexes[INDEX].columns.map((column: { expression: string }) => column.expression))
      .toEqual(["scope", "deployment_role", "retain_until", "id"]);
    delete current.tables["public.enterprise_pairings"].indexes[INDEX];
    expect(current).toEqual({ ...previous, id: current.id, prevId: previous.id });
    expect(readFileSync(join(source, `${migrationTag}.sql`), "utf8").trim()).toBe(
      'CREATE INDEX "enterprise_pairings_scope_retention_idx" ON "enterprise_pairings" USING btree ("scope","deployment_role","retain_until","id");');
  });

  it("uses the composite index for a sorted 100-row page among 110000 cross-scope and cross-role rows", async () => {
    await pool.query(`insert into enterprise_policy (id,scope,owner_fingerprint,deployment_role,environment)
      values ('fs91-page','fs91-page','megaui','test','test'),('fs91-else','fs91-else','megaui','test','test');
      insert into enterprise_pairings (id,scope,deployment_role,tenant_key,app_id,flow_hash,generation,token_hash,state,created_at,expires_at,retain_until)
      select md5('id:'||n)::uuid,case when n>60000 then 'fs91-else' else 'fs91-page' end,
        case when n>10000 and n<=60000 then 'canary' else 'test' end,'tenant-a','app-a',
        repeat(md5('flow:'||n),2),1,repeat(md5('token:'||n),2),'expired',
        t - interval '120 seconds',t,t
      from generate_series(1,110000) n cross join lateral
        (select '2026-11-11 00:00:00Z'::timestamptz + (n%1000)*interval '1 millisecond'
          - case when n>10000 then interval '1 day' else interval '0 days' end as t) times;
      analyze enterprise_pairings`);
    const query = `select id,scope,deployment_role,retain_until from enterprise_pairings
      where scope=$1 and deployment_role=$2 and retain_until<=$3
      order by retain_until,id limit 100 for update skip locked`;
    const parameters = ["fs91-page", "test", "2026-11-11 00:00:01Z"];
    const result = await pool.query<{ "QUERY PLAN": { Plan: PlanNode; "Execution Time": number }[] }>(
      `explain (analyze, buffers, format json) ${query}`, parameters);
    const explanation = result.rows[0]!["QUERY PLAN"][0]!;
    const nodes = planNodes(explanation.Plan);
    const indexNode = nodes.find(node => node["Index Name"] === INDEX);
    expect(indexNode).toBeDefined();
    expect(indexNode?.["Node Type"]).toBe("Index Scan");
    for (const field of ["scope", "deployment_role", "retain_until"]) expect(indexNode?.["Index Cond"]).toContain(field);
    expect(nodes.some(node => /Sort|Seq Scan/.test(node["Node Type"]))).toBe(false);
    expect(indexNode?.["Actual Rows"]).toBe(100);
    expect(indexNode?.["Rows Removed by Filter"] ?? 0).toBe(0);
    const page = (await pool.query<{ id: string; scope: string; deployment_role: string; retain_until: Date }>(query, parameters)).rows;
    expect(page).toHaveLength(100);
    expect(page.every(row => row.scope === "fs91-page" && row.deployment_role === "test" && row.retain_until <= new Date(parameters[2]!))).toBe(true);
    const eligible = (await pool.query<{ id: string; retain_until: Date }>(
      "select id,retain_until from enterprise_pairings where scope=$1 and deployment_role=$2 and retain_until<=$3", parameters)).rows;
    expect(eligible).toHaveLength(10000);
    eligible.sort((a, b) => a.retain_until.getTime() - b.retain_until.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(page.map(row => row.id)).toEqual(eligible.slice(0, 100).map(row => row.id));
    console.info(`FS-91 EXPLAIN: own=10000 other=100000 rows=${page.length} index=${INDEX} execution_ms=${explanation["Execution Time"]}`);
  }, 120_000);
});
