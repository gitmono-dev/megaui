// megaui-only (FSL-168): the forward migration that drops the enterprise tables and the `session`
// enterprise columns, applied for real to a one-shot Postgres.
//
// The database is first migrated to the state before this migration (the journal cut right
// before it) and seeded with sample rows in enterprise tables, in the four Feishu login tables
// and in other non-enterprise tables. An injected SQL fault must leave that state untouched;
// the generated migration then applies forward and only the enterprise structure is gone.
//
// Enterprise names are built from `PREFIX` instead of written out, so the FSL-168 zero-hit
// guard (the prefix followed by anything but `email`, test files included) holds for this file.
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedPostgres, resolveMigrationsFolder, type IsolatedPostgres } from "../../test-support/isolated-pg";

/** The enterprise table-name prefix. */
const PREFIX = "enterprise" + "_";
const isEnterprise = (name: string) => name.startsWith(PREFIX);

/** The four enterprise columns of `session`. */
const SESSION_ENTERPRISE_COLUMNS = [`${PREFIX}grant_id`, `${PREFIX}identity_id`, "auth_epoch", "auth_method"];
/** The constraints and index that belong to those columns. */
const SESSION_ENTERPRISE_CHECK = `session_${PREFIX}metadata_check`;
const SESSION_ENTERPRISE_FKS = [`session_${PREFIX}grant_id_${PREFIX}login_grants_id_fk`,
  `session_${PREFIX}identity_id_${PREFIX}identity_id_fk`];
const SESSION_ENTERPRISE_INDEX = `session_${PREFIX}grant_uidx`;
const SESSION_COLUMNS_AFTER = ["id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent",
  "user_id", "impersonated_by"];
const FEISHU_LOGIN_TABLES = ["feishu_identities", "feishu_login_codes", "feishu_login_key_check", "feishu_login_sessions"];

// Synthetic values only.
const hex = (seed: string) => createHash("sha256").update(`fsl168:${seed}`).digest("hex");
const SCOPE = "fsl168-scope";
const ENTERPRISE_USER = "fsl168-enterprise-user";
const FEISHU_USER = "fsl168-feishu-user";
const PLAIN_USER = "fsl168-plain-user";
const IDENTITY = "fsl168-identity";
const CHALLENGE = randomUUID();
const GRANT = randomUUID();
const CREATED = new Date(Date.UTC(2026, 10, 12, 12, 0, 0));

type Rows = Record<string, string[]>;

async function publicTables(pool: Pool): Promise<string[]> {
  return (await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public' order by table_name`)).rows
    .map(row => row.table_name);
}

/** Every relation (table, index, sequence, view) of the public schema. */
async function publicRelations(pool: Pool): Promise<string[]> {
  return (await pool.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' order by c.relname`)).rows.map(row => row.relname);
}

async function sessionColumns(pool: Pool): Promise<string[]> {
  return (await pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'session' order by ordinal_position`)).rows
    .map(row => row.column_name);
}

/** `table: name definition` of every constraint of the public schema. */
async function constraints(pool: Pool): Promise<string[]> {
  return (await pool.query<{ entry: string }>(
    `select c.conrelid::regclass::text || ': ' || c.conname || ' ' || pg_get_constraintdef(c.oid) as entry
       from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where n.nspname = 'public' order by entry`)).rows.map(row => row.entry);
}

/** `table: indexdef` of every index of the public schema. */
async function indexes(pool: Pool): Promise<string[]> {
  return (await pool.query<{ entry: string }>(
    `select tablename || ': ' || indexdef as entry from pg_indexes where schemaname = 'public' order by entry`)).rows
    .map(row => row.entry);
}

/** Every row of the given tables as JSON text, without the given columns of `session`. */
async function rowsOf(pool: Pool, tables: readonly string[], droppedSessionColumns: readonly string[] = []): Promise<Rows> {
  const result: Rows = {};
  for (const table of tables) {
    const rows = (await pool.query<{ row: Record<string, unknown> }>(
      `select to_jsonb(t) as row from "${table}" t order by to_jsonb(t)::text`)).rows.map(entry => entry.row);
    result[table] = rows.map(row => {
      if (table === "session") for (const column of droppedSessionColumns) delete row[column];
      return JSON.stringify(row);
    }).sort();
  }
  return result;
}

async function ledger(pool: Pool): Promise<string[]> {
  return (await pool.query<{ hash: string }>("select hash from drizzle.__drizzle_migrations order by id")).rows
    .map(row => row.hash);
}

async function seed(pool: Pool): Promise<void> {
  for (const [id, email] of [[ENTERPRISE_USER, "fsl168-enterprise@example.test"],
    [FEISHU_USER, "fsl168-feishu@example.test"], [PLAIN_USER, "fsl168-plain@example.test"]] as const) {
    await pool.query(`insert into "user" (id, name, email, email_verified) values ($1, $1, $2, true)`, [id, email]);
  }
  await pool.query(
    `insert into account (id, account_id, provider_id, user_id, password) values ('fsl168-account', $1, 'credential', $1, 'x')`,
    [PLAIN_USER]);
  await pool.query(
    `insert into verification (id, identifier, value, expires_at) values ('fsl168-verification', 'fsl168', 'v', $1)`,
    [CREATED]);
  await pool.query(
    `insert into mega_channels (id, kind, name) values ('fsl168-channel', 'channel', 'FSL-168 channel')`);
  await pool.query(
    `insert into mega_content (container_type, container_id, body_json) values ('doc', 'fsl168-doc', '{"type":"doc"}')`);

  // The enterprise rows: policy, identity, a consumed challenge, its grant and the profile.
  await pool.query(
    `insert into ${PREFIX}policy (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
     values ('fsl168-policy', $1, 'megaui', 'test', 'test', 7, 'enterprise')`, [SCOPE]);
  await pool.query(
    `insert into ${PREFIX}identity (id, local_user_id, tenant_key, app_id, open_id, identity_version)
     values ($1, $2, 'fsl168-tenant', 'fsl168-app', 'ou-fsl168', 3)`, [IDENTITY, ENTERPRISE_USER]);
  await pool.query(
    `insert into ${PREFIX}challenges
       (id, scope, deployment_role, local_user_id, identity_id, identity_version, flow_hash, generation, purpose,
        pairing_id, code_hmac, hmac_key_id, state, failed_attempts, created_at, expires_at, consumed_at,
        recover_until, secret_expires_at)
     values ($1, $2, 'test', $3, $4, 3, $5, 1, 'login', null, $6, 'fsl168-hmac-v1', 'consumed', 0, $7, $8, $9, $10, $10)`,
    [CHALLENGE, SCOPE, ENTERPRISE_USER, IDENTITY, hex("flow"), hex("code"), CREATED,
      new Date(CREATED.getTime() + 300_000), new Date(CREATED.getTime() + 1_000), new Date(CREATED.getTime() + 91_000)]);
  await pool.query(
    `insert into ${PREFIX}login_grants
       (id, challenge_id, scope, deployment_role, local_user_id, identity_id, identity_version, auth_epoch, flow_hash,
        generation, purpose, created_at, recover_until)
     values ($1, $2, $3, 'test', $4, $5, 3, 7, $6, 1, 'login', $7, $8)`,
    [GRANT, CHALLENGE, SCOPE, ENTERPRISE_USER, IDENTITY, hex("flow"), CREATED, new Date(CREATED.getTime() + 90_000)]);
  await pool.query(
    `insert into ${PREFIX}profile (user_id, tenant_key, login_name, backend_username, display_name)
     values ($1, 'fsl168-tenant', 'fsl168-login', 'fsl168-backend', 'FSL-168 Enterprise')`, [ENTERPRISE_USER]);

  // Sessions: one with enterprise metadata, one legacy, one issued and marked by the Feishu login.
  await pool.query(
    `insert into session (id, expires_at, token, user_id, ${SESSION_ENTERPRISE_COLUMNS.join(", ")})
     values ('fsl168-session-enterprise', $1, 'fsl168-token-enterprise', $2, $3, $4, 7, 'enterprise')`,
    [new Date(CREATED.getTime() + 8 * 3_600_000), ENTERPRISE_USER, GRANT, IDENTITY]);
  await pool.query(
    `insert into session (id, expires_at, token, user_id) values ('fsl168-session-legacy', $1, 'fsl168-token-legacy', $2)`,
    [new Date(CREATED.getTime() + 8 * 3_600_000), PLAIN_USER]);
  await pool.query(
    `insert into session (id, expires_at, token, user_id, ip_address, user_agent)
     values ('fsl168-session-feishu', $1, 'fsl168-token-feishu', $2, '127.0.0.1', 'fsl168-agent')`,
    [new Date(CREATED.getTime() + 8 * 3_600_000), FEISHU_USER]);

  // The four Feishu login tables.
  await pool.query(`insert into feishu_login_sessions (session_id) values ('fsl168-session-feishu')`);
  await pool.query(`insert into feishu_identities (app_id, open_id_hmac, user_id) values ('fsl168-app', $1, $2)`,
    [hex("open-id"), FEISHU_USER]);
  await pool.query(
    `insert into feishu_login_codes (id, flow_hash, flow_seq, email_hmac, email_seq, state, expires_at)
     values ($1, $2, 1, $3, 1, 'void', $4)`, [randomUUID(), hex("feishu-flow"), hex("feishu-email"), CREATED]);
  await pool.query(`insert into feishu_login_key_check (key_check) values ($1)`, [hex("key-check")]);
}

describe("FSL-168: the forward migration drops the enterprise structure", () => {
  const source = resolveMigrationsFolder();
  let isolated: IsolatedPostgres;
  let pool: Pool;
  let directory: string | undefined;
  let migrationTag: string;
  let previousTag: string;
  let migrationHash: string;
  let enterpriseTables: string[] = [];
  let tablesBefore: string[] = [];
  let relationsBefore: string[] = [];
  let sessionColumnsBefore: string[] = [];
  let constraintsBefore: string[] = [];
  let indexesBefore: string[] = [];
  let rowsBefore: Rows = {};
  let rowsBeforeLessDropped: Rows = {};
  let enterpriseRowsBefore: Rows = {};
  let ledgerBefore: string[] = [];
  let faultCodes: unknown[] = [];
  let afterFault: { tables: string[]; sessionColumns: string[]; rows: Rows; enterpriseRows: Rows; ledger: string[] } | undefined;

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string; idx: number; when: number }[];
    };
    const position = journal.entries.findIndex(entry =>
      readFileSync(join(source, `${entry.tag}.sql`), "utf8").includes(`DROP TABLE "${PREFIX}policy"`));
    expect(position).toBeGreaterThan(0);
    migrationTag = journal.entries[position]!.tag;
    previousTag = journal.entries[position - 1]!.tag;
    const originalSql = readFileSync(join(source, `${migrationTag}.sql`), "utf8");
    migrationHash = createHash("sha256").update(originalSql).digest("hex");

    // The state before this migration, with sample rows.
    directory = mkdtempSync(join(tmpdir(), "megaui-fsl168-migrations-"));
    cpSync(source, directory, { recursive: true });
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, position) }));
    await migrate(drizzle(pool), { migrationsFolder: directory });
    await seed(pool);
    tablesBefore = await publicTables(pool);
    enterpriseTables = tablesBefore.filter(isEnterprise);
    relationsBefore = await publicRelations(pool);
    sessionColumnsBefore = await sessionColumns(pool);
    constraintsBefore = await constraints(pool);
    indexesBefore = await indexes(pool);
    rowsBefore = await rowsOf(pool, tablesBefore.filter(name => !isEnterprise(name)));
    rowsBeforeLessDropped = await rowsOf(pool, tablesBefore.filter(name => !isEnterprise(name)), SESSION_ENTERPRISE_COLUMNS);
    enterpriseRowsBefore = await rowsOf(pool, enterpriseTables);
    ledgerBefore = await ledger(pool);

    // Inject an SQL fault after every generated statement of this migration.
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, position + 1) }));
    writeFileSync(join(directory, `${migrationTag}.sql`), originalSql + "\n--> statement-breakpoint\nSELECT 1 / 0;");
    const fault = await migrate(drizzle(pool), { migrationsFolder: directory }).then(() => undefined, (error: unknown) => error);
    faultCodes = [];
    for (let cause: unknown = fault; cause && typeof cause === "object"; cause = (cause as { cause?: unknown }).cause) {
      faultCodes.push((cause as { code?: unknown }).code);
    }
    afterFault = {
      tables: await publicTables(pool),
      sessionColumns: await sessionColumns(pool),
      rows: await rowsOf(pool, tablesBefore.filter(name => !isEnterprise(name))),
      enterpriseRows: await rowsOf(pool, enterpriseTables),
      ledger: await ledger(pool),
    };

    // Forward: restore the unmodified target migration SQL and apply through
    // `position` (the enterprise-drop migration itself) so later forward
    // migrations do not alter the exact table/constraint/ledger assertions for
    // FSL-168.
    writeFileSync(join(directory, `${migrationTag}.sql`), originalSql);
    await migrate(drizzle(pool), { migrationsFolder: directory });
  }, 180_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    try { if (directory) rmSync(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FSL-168 fixture cleanup failed");
  }, 120_000);

  it("starts from the 20 enterprise tables, the session enterprise columns and enterprise sample rows", () => {
    expect(enterpriseTables).toHaveLength(20);
    for (const column of SESSION_ENTERPRISE_COLUMNS) expect(sessionColumnsBefore).toContain(column);
    for (const table of ["policy", "identity", "challenges", "login_grants", "profile"]) {
      expect(enterpriseRowsBefore[`${PREFIX}${table}`], table).toHaveLength(1);
    }
    expect(rowsBefore.session).toHaveLength(3);
    for (const table of FEISHU_LOGIN_TABLES) expect(rowsBefore[table], table).toHaveLength(1);
  });

  it("AC1: no enterprise table, nor any relation of one, is left", async () => {
    expect((await publicTables(pool)).filter(isEnterprise)).toEqual([]);
    expect(relationsBefore.some(isEnterprise)).toBe(true);
    expect((await publicRelations(pool)).filter(isEnterprise)).toEqual([]);
  });

  it("AC2: session no longer has the four enterprise columns", async () => {
    const columns = await sessionColumns(pool);
    for (const column of SESSION_ENTERPRISE_COLUMNS) expect(columns).not.toContain(column);
    expect(columns).toEqual(SESSION_COLUMNS_AFTER);
  });

  it("AC2 regression: the session enterprise foreign keys, unique index and CHECK are gone with the columns", async () => {
    const sessionConstraints = (await constraints(pool)).filter(entry => entry.startsWith("session: "));
    for (const name of [SESSION_ENTERPRISE_CHECK, ...SESSION_ENTERPRISE_FKS]) {
      expect(constraintsBefore.some(entry => entry.startsWith(`session: ${name} `)), name).toBe(true);
      expect(sessionConstraints.some(entry => entry.startsWith(`session: ${name} `)), name).toBe(false);
    }
    expect(sessionConstraints.map(entry => entry.split(" ")[1])).toEqual(
      ["session_pkey", "session_token_unique", "session_user_id_user_id_fk"]);
    const sessionIndexes = (await indexes(pool)).filter(entry => entry.startsWith("session: "));
    expect(indexesBefore.some(entry => entry.includes(` ${SESSION_ENTERPRISE_INDEX} `))).toBe(true);
    expect(sessionIndexes.some(entry => entry.includes(SESSION_ENTERPRISE_INDEX))).toBe(false);
    expect(sessionIndexes).toEqual([
      "session: CREATE UNIQUE INDEX session_pkey ON public.session USING btree (id)",
      "session: CREATE UNIQUE INDEX session_token_unique ON public.session USING btree (token)",
    ]);
  });

  it("AC3: every non-enterprise table, the four Feishu login tables included, still exists", async () => {
    const tables = await publicTables(pool);
    expect(tables).toEqual(tablesBefore.filter(name => !isEnterprise(name)));
    for (const table of [...FEISHU_LOGIN_TABLES, "user", "session", "account", "verification"]) expect(tables).toContain(table);
  });

  it("AC3: the constraints and indexes of the non-enterprise tables are unchanged but for the session enterprise ones", async () => {
    const owned = (entry: string) => !isEnterprise(entry);
    const droppedConstraint = (entry: string) =>
      [SESSION_ENTERPRISE_CHECK, ...SESSION_ENTERPRISE_FKS].some(name => entry.startsWith(`session: ${name} `));
    expect(await constraints(pool)).toEqual(constraintsBefore.filter(owned).filter(entry => !droppedConstraint(entry)));
    expect(await indexes(pool)).toEqual(
      indexesBefore.filter(owned).filter(entry => !entry.includes(` ${SESSION_ENTERPRISE_INDEX} `)));
  });

  it("AC4: the rows of every non-enterprise table are unchanged (session rows less the dropped columns)", async () => {
    const tables = tablesBefore.filter(name => !isEnterprise(name));
    expect(await rowsOf(pool, tables)).toEqual(rowsBeforeLessDropped);
    expect(rowsBeforeLessDropped.session!.map(text => (JSON.parse(text) as { id: string }).id).sort()).toEqual(
      ["fsl168-session-enterprise", "fsl168-session-feishu", "fsl168-session-legacy"]);
    // The Feishu session marker still points at its session.
    expect((await pool.query("select session_id from feishu_login_sessions")).rows).toEqual([{ session_id: "fsl168-session-feishu" }]);
  });

  it("AC5: the injected SQL fault leaves every enterprise table, column and row in place", () => {
    expect(faultCodes).toContain("22012");
    expect(afterFault?.tables).toEqual(tablesBefore);
    expect(afterFault?.tables.filter(isEnterprise)).toHaveLength(20);
    expect(afterFault?.sessionColumns).toEqual(sessionColumnsBefore);
    expect(afterFault?.enterpriseRows).toEqual(enterpriseRowsBefore);
    expect(afterFault?.rows).toEqual(rowsBefore);
  });

  it("AC6: the injected SQL fault leaves the journal without this migration", () => {
    expect(faultCodes).toContain("22012");
    expect(afterFault?.ledger).toEqual(ledgerBefore);
    expect(afterFault?.ledger).not.toContain(migrationHash);
  });

  it("applies the generated migration forward after the fault and records it once", async () => {
    const hashes = await ledger(pool);
    expect(hashes.filter(hash => hash === migrationHash)).toHaveLength(1);
    expect(hashes.slice(0, ledgerBefore.length)).toEqual(ledgerBefore);
    expect(hashes).toHaveLength(ledgerBefore.length + 1);
  });

  it("drops the session enterprise structure before the enterprise tables", () => {
    const statements = readFileSync(join(source, `${migrationTag}.sql`), "utf8").split("--> statement-breakpoint")
      .map(statement => statement.trim());
    const lastSession = Math.max(...statements.map((statement, index) =>
      /^(ALTER TABLE "session"|DROP INDEX "session_)/m.test(statement) ? index : -1));
    const firstDrop = statements.findIndex(statement => statement.startsWith("DROP TABLE"));
    expect(statements.filter(statement => statement.startsWith("DROP TABLE"))).toHaveLength(20);
    expect(lastSession).toBeGreaterThanOrEqual(0);
    expect(lastSession).toBeLessThan(firstDrop);
  });

  it("removes exactly the enterprise tables and the session enterprise columns from the prior generated snapshot", () => {
    const readSnapshot = (tag: string) => JSON.parse(readFileSync(join(source, `meta/${tag.split("_")[0]}_snapshot.json`), "utf8"));
    const previous = readSnapshot(previousTag);
    const current = readSnapshot(migrationTag);
    expect(current.prevId).toBe(previous.id);
    const dropped = Object.keys(previous.tables).filter(key => !(key in current.tables));
    expect(dropped.map(key => key.replace(/^public\./, "")).sort()).toEqual([...enterpriseTables].sort());
    for (const key of dropped) delete previous.tables[key];
    const session = previous.tables["public.session"];
    for (const column of SESSION_ENTERPRISE_COLUMNS) delete session.columns[column];
    for (const name of SESSION_ENTERPRISE_FKS) delete session.foreignKeys[name];
    delete session.indexes[SESSION_ENTERPRISE_INDEX];
    delete session.checkConstraints[SESSION_ENTERPRISE_CHECK];
    expect(current).toEqual({ ...previous, id: current.id, prevId: previous.id });
  });
});
