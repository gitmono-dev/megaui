// FS-37: actual CLI, run-owned PostgreSQL, enforced read-only snapshot and no provider access.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { migrationUserVersion } from "./manifest";
import { runActorReservationMutation } from "./actor-reservations";
import { compatibilityEmail } from "./identity-key";
import { previewMigration, readMigrationSources, readMigrationUserSources } from "./migration-preview";
import { readScopeExpectation } from "@megaui/database";

const SCOPE = "fs37-instance", TENANT = "fs37-tenant", APP = "fs37-app";
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const CLI = fileURLToPath(new URL("../../cli/enterprise-admin.ts", import.meta.url));
const ENGINE_PACKAGE = fileURLToPath(new URL("../../../package.json", import.meta.url));

describe("migration preview actual CLI (FS-37)", () => {
  let isolated: IsolatedPostgres, pool: Pool, directory: string, preload: string;
  const scenario = (name: string, fn: () => Promise<void>) => it(name, fn, 60_000);
  async function seal(actors: { actor: string; owners: string[] }[] = [], observedAt = new Date(Date.now() - 10_000)) {
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, observedAt: observedAt.toISOString(), actors }));
    const client = await pool.connect();
    try {
      await client.query("begin");
      await runActorReservationMutation({ verb: "reserve-actors", operationId: randomUUID(),
        args: { target: SCOPE, digest: createHash("sha256").update(bytes).digest("hex") },
        files: { names: () => ["upstream"], bytes: () => bytes } }, client);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }
  async function member(id = "legacy-text-id", overrides: Record<string, unknown> = {}) {
    const result = await pool.query('select id,name,email,email_verified as "emailVerified",banned,' +
      'to_char(updated_at at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') as "updatedAt" from "user" where id=$1', [id]);
    return { local_user_id: id, tenant_key: TENANT, app_id: APP, open_id: "open-" + id,
      login_name: "alias-" + id, expected_user_version: migrationUserVersion(result.rows[0]), expected_identity_version: 0, ...overrides };
  }
  function input(members: unknown[]) {
    const base = join(directory, randomUUID());
    writeFileSync(base + "-input.json", JSON.stringify({ schemaVersion: 1, members }));
    return { manifest: base + "-input.json", out: base + "-out.json", trace: base + "-trace.jsonl" };
  }
  function run(files: ReturnType<typeof input>, options: { env?: NodeJS.ProcessEnv; args?: string[]; probe?: boolean } = {}) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", preload, CLI,
      ...(options.args ?? ["preview", "--target", SCOPE, "--manifest", files.manifest, "--out", files.out])], {
      cwd: ROOT, encoding: "utf8", timeout: 35_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", DATABASE_URL: isolated.databaseUrl,
        ENTERPRISE_DB_INSTANCE_ID: SCOPE, ENTERPRISE_PROCESS_ROLE: "test", ENTERPRISE_DEPLOYMENT_ROLE: "test",
        ENTERPRISE_OWNER_FINGERPRINT: "megaui", FEISHU_TENANT_KEY: TENANT, FEISHU_APP_ID: APP,
        FS37_TRACE: files.trace, FS37_PROBE: options.probe ? "1" : "0", ...options.env },
    });
    if (result.error) throw result.error;
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }
  async function stored() {
    const tables = (await pool.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows;
    const result: Record<string, unknown> = {};
    for (const { tablename } of tables) {
      const quoted = '"' + String(tablename).replaceAll('"', '""') + '"';
      result[tablename] = (await pool.query("select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as data from " + quoted + " t")).rows[0].data;
    }
    return result;
  }
  beforeAll(async () => {
    isolated = await createIsolatedPostgres(); await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl }); pool.on("error", () => {});
    directory = realpathSync(mkdtempSync(join(tmpdir(), "megaui-fs37-")));
    preload = join(directory, "observe.mjs");
    writeFileSync(preload, `import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
const pg = createRequire(${JSON.stringify(ENGINE_PACKAGE)})('pg');
const original = pg.Client.prototype.query;
const record = value => appendFileSync(process.env.FS37_TRACE, JSON.stringify(value)+'\\n');
let drifted = false;
globalThis.fetch = () => { record({network:true}); throw new Error('unexpected provider network'); };
pg.Client.prototype.query = async function(...args) {
  const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
  record({sql,batchSizes:Array.isArray(args[1]) ? args[1].filter(Array.isArray).map(value => value.length) : []});
  if (process.env.FS37_SLOW === '1') await original.call(this, 'select pg_sleep(4.5)');
  const result = await Reflect.apply(original,this,args);
  if (process.env.FS37_DRIFT === '1' && !drifted && sql.includes('from "user" where id=any')) {
    drifted = true;
    const writer = new pg.Client({connectionString:process.env.DATABASE_URL});
    await writer.connect();
    try { await original.call(writer, 'update "user" set updated_at=updated_at+interval \\'1 microsecond\\'; update enterprise_profile set notification_email=\\'external-change@example.test\\''); }
    finally { await writer.end(); }
    record({externalWriter:true});
  }
  if (/^begin/i.test(sql) && process.env.FS37_PROBE === '1') {
    const state = await original.call(this, "select current_setting('transaction_read_only') as readonly,current_setting('transaction_isolation') as isolation");
    record({transaction:state.rows[0]});
    await original.call(this,'savepoint readonly_probe');
    let code = null;
    try { await original.call(this, "insert into enterprise_quarantine(id,user_id,reason) values ('probe','legacy-text-id','probe')"); }
    catch(error) { code = error.code; }
    await original.call(this,'rollback to savepoint readonly_probe');
    await original.call(this,'release savepoint readonly_probe');
    record({writeRejected:code});
  }
  if (sql.includes('from enterprise_policy limit 2') && process.env.FS37_PROBE === '1') {
    const budgets = await original.call(this, "select current_setting('statement_timeout') as statement,current_setting('idle_in_transaction_session_timeout') as idle");
    record({budgets:budgets.rows[0]});
  }
  return result;
};
`);
  }, 120_000);
  beforeEach(async () => {
    await pool.query('delete from enterprise_actor_inventory; delete from enterprise_actor_reservations; ' +
      'delete from enterprise_batch_checkpoints; delete from enterprise_admin_operations; delete from enterprise_quarantine; delete from "user"; delete from enterprise_policy');
    await pool.query("insert into enterprise_policy(id,scope,owner_fingerprint,deployment_role,environment,auth_epoch,activation_state) " +
      "values ('policy',$1,'megaui','test','test',3,'maintenance')", [SCOPE]);
    await pool.query('insert into "user"(id,name,email,email_verified,updated_at) values ' +
      "('legacy-text-id','  Ada  ','ada@example.test',false,'2026-11-11T01:02:03.123456Z')," +
      "('outside','outside actor','outside@example.test',false,'2026-11-11T01:02:03.123456Z')");
    await seal([{ actor: "native", owners: ["native-owner"] }]);
  });
  afterAll(async () => {
    const errors: unknown[] = [];
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    try { if (directory) rmSync(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FS-37 cleanup failed");
  });
  scenario("previews without approval or provider credentials in one enforced read-only snapshot", async () => {
    const files = input([await member()]), before = await stored();
    const result = run(files, { probe: true });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ schemaVersion: 1, targetFingerprint: "megaui:" + SCOPE + ":test", policyEpoch: 3,
      status: "ready", counts: { total: 1, ready: 1, conflicts: 0 }, rows: [{ row: 1, status: "ready", conflictKeys: [] }] });
    expect(report.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(files.out, "utf8")).toBe(result.stdout);
    expect(statSync(files.out).mode & 0o777).toBe(0o600);
    expect(await stored()).toEqual(before);
    const trace = readFileSync(files.trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(trace).toContainEqual({ transaction: { readonly: "on", isolation: "repeatable read" } });
    expect(trace).toContainEqual({ budgets: { statement: "5s", idle: "5s" } });
    expect(trace).toContainEqual({ writeRejected: "25006" });
    const statements = trace.filter(event => event.sql).map(event => event.sql as string);
    expect(statements.filter(sql => /^begin/i.test(sql))).toHaveLength(1);
    expect(statements.every(sql => /^(select|begin|rollback)\b/i.test(sql))).toBe(true);
    expect(statements.some(sql => /\b(insert|update|delete|truncate|create|alter|drop)\b/i.test(sql.replace(/'(?:[^']|'')*'/g, "''")))).toBe(false);
    expect(trace.some(event => event.network)).toBe(false);
    for (const secret of ["legacy-text-id", "open-legacy", "  Ada  ", "ada@example.test", "outside actor"]) {
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
  });
  scenario("emits redacted conflicts with no digest or database changes", async () => {
    const files = input([await member("legacy-text-id", { expected_user_version: "f".repeat(64) })]);
    const before = await stored(), result = run(files);
    expect(result).toMatchObject({ code: 3, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "conflict", manifestDigest: null,
      rows: [{ row: 1, status: "conflict", conflictKeys: ["USER_VERSION_MISMATCH"] }] });
    expect(await stored()).toEqual(before);
    expect(existsSync(files.out)).toBe(true);
  });
  scenario("never replaces a missing explicit local ID with an existing same-source-version user", async () => {
    const files = input([{ ...await member(), local_user_id: "missing-local-id" }]), before = await stored();
    const result = run(files); expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ manifestDigest: null,
      rows: [{ row: 1, status: "conflict", conflictKeys: ["USER_MISSING"] }] });
    expect(await stored()).toEqual(before);
  });

  async function binding(id = "legacy-text-id", openId = "open-" + id, tenant = TENANT, app = APP) {
    await pool.query("insert into enterprise_identity(id,local_user_id,tenant_key,app_id,open_id) values ($1,$2,$3,$4,$5)",
      [randomUUID(), id, tenant, app, openId]);
  }
  async function profile(id = "legacy-text-id", alias = "alias-" + id, tenant = TENANT) {
    await pool.query("insert into enterprise_profile(user_id,tenant_key,login_name,backend_username,notification_email) " +
      "select id,$2,$3,name,'shared@example.test' from \"user\" where id=$1", [id, tenant, alias]);
  }
  async function expectConflict(expected: string, overrides: Record<string, unknown> = {}) {
    const files = input([await member("legacy-text-id", overrides)]), before = await stored();
    const result = run(files);
    expect(result).toMatchObject({ code: 3, stderr: "" });
    const report = JSON.parse(result.stdout);
    expect(report.manifestDigest).toBeNull();
    expect(report.rows[0].conflictKeys).toContain(expected);
    expect(await stored()).toEqual(before);
    return report;
  }
  scenario("reads 101 rows in bounded chunks and rejects duplicates across chunks before SQL", async () => {
    await pool.query('insert into "user"(id,name,email,email_verified) select ' +
      "'legacy-'||n,'actor-'||n,'user-'||n||'@example.test',false from generate_series(1,100) n");
    await seal();
    const members = [await member()];
    for (let n = 1; n <= 100; n++) members.push(await member("legacy-" + n));
    const files = input(members), before = await stored(), result = run(files);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).counts).toEqual({ total: 101, ready: 101, conflicts: 0 });
    const trace = readFileSync(files.trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const userReads = trace.filter(event => event.sql?.includes('from "user" where id=any'));
    expect(userReads.map(event => event.batchSizes)).toEqual([[100], [1]]);
    expect(trace.flatMap(event => event.batchSizes ?? []).every(size => size <= 100)).toBe(true);
    expect(await stored()).toEqual(before);
    for (const key of ["local_user_id", "open_id", "login_name"] as const) {
      const duplicate = input(members.map((row, index) => index === 100 ? { ...row, [key]: members[0]![key] } : row));
      expect(run(duplicate)).toMatchObject({ code: 2, stdout: "", stderr: "error: INVALID_ARGUMENT\n" });
      expect(existsSync(duplicate.out)).toBe(false); expect(existsSync(duplicate.trace)).toBe(false);
    }
  });
  scenario("retains the digest across source renewal and policy changes, but binds ownership", async () => {
    const members = [await member()], first = run(input(members));
    expect(first.code).toBe(0); const digest = JSON.parse(first.stdout).manifestDigest;
    for (const [state, epoch] of [["legacy", 0], ["enterprise", 4]] as const) {
      await pool.query("update enterprise_policy set activation_state=$1,auth_epoch=$2", [state, epoch]);
      await seal([{ actor: "native", owners: ["native-owner"] }], new Date(Date.now() - 1000));
      const result = run(input(members)); expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ policyEpoch: epoch, manifestDigest: digest });
    }
    await seal([{ actor: "new-native", owners: ["other-native-owner"] }], new Date(Date.now() - 500));
    const changed = run(input(members)); expect(changed.code).toBe(0);
    expect(JSON.parse(changed.stdout).manifestDigest).not.toBe(digest);
  });
  scenario("binds profile and identity microseconds and notification fields without merging shared names or email", async () => {
    await profile(); await profile("outside"); await binding();
    await pool.query('update "user" set name=\'  Ada  \' where id=\'outside\'');
    const members = [await member("legacy-text-id", { expected_identity_version: 1 }), await member("outside")];
    const first = run(input(members)); expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout).counts.ready).toBe(2);
    let digest = JSON.parse(first.stdout).manifestDigest;
    for (const sql of ["update enterprise_profile set notification_email='changed@example.test' where user_id='legacy-text-id'",
      "update enterprise_profile set updated_at=updated_at+interval '1 microsecond' where user_id='legacy-text-id'",
      "update enterprise_identity set updated_at=updated_at+interval '1 microsecond'",
      "update enterprise_identity set union_id='changed-union'"]) {
      await pool.query(sql); const result = run(input(members)); expect(result.code).toBe(0);
      const changed = JSON.parse(result.stdout).manifestDigest; expect(changed).not.toBe(digest); digest = changed;
    }
    await pool.query('update "user" set updated_at=updated_at+interval \'1 microsecond\' where id=\'legacy-text-id\'');
    const stale = run(input(members)); expect(stale.code).toBe(3);
    expect(JSON.parse(stale.stdout).rows[0].conflictKeys).toContain("USER_VERSION_MISMATCH");
  });
  scenario("refuses changed existing open ID or alias even when the supplied version matches", async () => {
    await binding("legacy-text-id", "different-open");
    await expectConflict("IDENTITY_BINDING_MISMATCH", { expected_identity_version: 1 });
    await pool.query("update enterprise_identity set open_id='open-legacy-text-id'");
    await profile("legacy-text-id", "different-alias");
    await expectConflict("PROFILE_ALIAS_MISMATCH", { expected_identity_version: 1 });
  });
  scenario("reads foreign-scope bindings and rejects occupied external triples and aliases", async () => {
    await binding("legacy-text-id", "foreign-open", "foreign-tenant");
    await expectConflict("IDENTITY_SCOPE_MISMATCH");
    await pool.query("delete from enterprise_identity");
    await binding("outside", "open-legacy-text-id");
    await expectConflict("EXTERNAL_IDENTITY_OCCUPIED");
    await profile("outside", "alias-legacy-text-id");
    await expectConflict("ALIAS_OCCUPIED");
    await pool.query("delete from enterprise_profile"); await profile("legacy-text-id", "alias-legacy-text-id", "foreign");
    await expectConflict("PROFILE_SCOPE_MISMATCH");
  });
  scenario("reports inactive identity, wrong identity version and quarantine", async () => {
    await binding(); await expectConflict("IDENTITY_VERSION_MISMATCH");
    for (const status of ["suspended", "resigned"]) {
      await pool.query("update enterprise_identity set status=$1", [status]);
      await expectConflict("IDENTITY_INACTIVE", { expected_identity_version: 1 });
    }
    await pool.query("insert into enterprise_quarantine(id,user_id,reason) values ('q','legacy-text-id','fixture')");
    await seal(); await expectConflict("QUARANTINED", { expected_identity_version: 1 });
  });
  scenario("rejects compatibility email takeover and malformed existing reserved-domain assignments", async () => {
    await pool.query('update "user" set email=$1 where id=\'outside\'', [compatibilityEmail("legacy-text-id")]);
    await expectConflict("COMPATIBILITY_EMAIL_CONFLICT");
    await pool.query('update "user" set email=\'outside@example.test\' where id=\'outside\'');
    await pool.query('update "user" set email=$1 where id=\'legacy-text-id\'', [compatibilityEmail("legacy-text-id")]);
    await expectConflict("COMPATIBILITY_EMAIL_CONFLICT");
    await binding(); await profile();
    const valid = run(input([await member("legacy-text-id", { expected_identity_version: 1 })])); expect(valid.code).toBe(0);
    await pool.query('update "user" set email=\'wrong@identity.invalid\' where id=\'legacy-text-id\'');
    await expectConflict("COMPATIBILITY_EMAIL_CONFLICT", { expected_identity_version: 1 });
  });
  scenario("reports missing, ambiguous and native actors without approving a mapping", async () => {
    await pool.query('update "user" set name=\' \',email=\'not-an-email\' where id=\'legacy-text-id\'');
    await seal(); await expectConflict("ACTOR_MISSING");
    await pool.query('delete from enterprise_quarantine; update "user" set name=\'outside actor\' where id=\'legacy-text-id\'');
    await seal(); await expectConflict("ACTOR_UNAVAILABLE");
    await pool.query('delete from enterprise_quarantine; update "user" set name=\'native\' where id=\'legacy-text-id\'');
    await seal([{ actor: "native", owners: ["native-owner"] }]); await expectConflict("ACTOR_UNAVAILABLE");
  });
  scenario("checks full inventory outside the manifest and refuses expired or future source", async () => {
    const members = [await member()];
    await pool.query('update "user" set name=\'changed outside\' where id=\'outside\'');
    let files = input(members);
    expect(run(files)).toMatchObject({ code: 3, stdout: "", stderr: "error: ACTOR_INVENTORY_REJECTED\n" });
    expect(existsSync(files.out)).toBe(false);
    await seal();
    for (const interval of ["-25 hours", "1 hour"]) {
      await pool.query("update enterprise_actor_inventory set observed_at=now()+$1::interval", [interval]);
      await pool.query("update enterprise_actor_reservations set source_observed_at=(select observed_at from enterprise_actor_inventory)");
      files = input(members);
      expect(run(files)).toMatchObject({ code: 3, stdout: "", stderr: "error: ACTOR_INVENTORY_REJECTED\n" });
    }
  });
  scenario("refuses missing or ambiguous policy, wrong SQL role and malformed source time", async () => {
    const members = [await member()];
    expect(run(input(members), { env: { ENTERPRISE_PROCESS_ROLE: "admin" } })).toMatchObject({ code: 3, stderr: "error: SCOPE_REJECTED\n" });
    await pool.query("insert into enterprise_policy(id,scope,owner_fingerprint,deployment_role,environment) values ('other','other','megaui','test','test')");
    expect(run(input(members))).toMatchObject({ code: 3, stderr: "error: SCOPE_REJECTED\n" });
    await pool.query("delete from enterprise_policy where id='other'");
    await pool.query('update "user" set updated_at=\'infinity\' where id=\'legacy-text-id\'');
    expect(run(input(members))).toMatchObject({ code: 3, stderr: "error: SOURCE_REJECTED\n" });
    await pool.query("delete from enterprise_actor_inventory; delete from enterprise_policy");
    expect(run(input(members))).toMatchObject({ code: 3, stderr: "error: SCOPE_REJECTED\n" });
  });
  scenario("rejects malformed inputs, symlinks, oversize bytes and existing output without overwrite", async () => {
    const members = [await member()], files = input(members);
    writeFileSync(files.out, "preserve");
    expect(run(files).code).toBe(2); expect(readFileSync(files.out, "utf8")).toBe("preserve");
    const linked = input(members); symlinkSync(files.out, linked.out);
    expect(run(linked).code).toBe(2); expect(readFileSync(files.out, "utf8")).toBe("preserve");
    const linkInput = input(members); rmSync(linkInput.manifest); symlinkSync(files.manifest, linkInput.manifest);
    expect(run(linkInput).code).toBe(2);
    for (const bytes of [Buffer.from([0xff]), Buffer.alloc(10 * 1024 * 1024 + 1)]) {
      const invalid = input(members); writeFileSync(invalid.manifest, bytes);
      expect(run(invalid)).toMatchObject({ code: 2, stdout: "", stderr: "error: INVALID_ARGUMENT\n" });
      expect(existsSync(invalid.out)).toBe(false);
    }
    const base = ["preview", "--target", SCOPE, "--manifest", files.manifest, "--out", files.out];
    for (const tail of [["--target", SCOPE], ["--tenant", TENANT], ["--approval", "ignored"], ["positional"]]) {
      expect(run(files, { args: [...base, ...tail] }).code).toBe(2);
    }
    expect(run(input(members), { env: { FEISHU_APP_ID: "" } }).code).toBe(2);
    expect(run(input(members), { env: { DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/invalid" } }))
      .toMatchObject({ code: 4, stdout: "", stderr: "error: DEPENDENCY_FAILED\n" });
  });
  scenario("preserves one snapshot when another connection changes sources between read chunks", async () => {
    await profile(); const members = [await member()];
    const initial = run(input(members)); expect(initial.code).toBe(0);
    const files = input(members), concurrent = run(files, { env: { FS37_DRIFT: "1" } });
    expect(concurrent.code).toBe(0);
    expect(JSON.parse(concurrent.stdout).manifestDigest).toBe(JSON.parse(initial.stdout).manifestDigest);
    expect(readFileSync(files.trace, "utf8")).toContain('"externalWriter":true');
    expect((await pool.query("select notification_email from enterprise_profile")).rows[0].notification_email).toBe("external-change@example.test");
    const afterward = run(input(members)); expect(afterward.code).toBe(3);
    expect(JSON.parse(afterward.stdout).rows[0].conflictKeys).toContain("USER_VERSION_MISMATCH");
  });
  scenario("reads user versions in bounded chunks without authority fields or losing microseconds", async () => {
    const ids = ["legacy-text-id", ...Array.from({ length: 100 }, (_, index) => "fs38-source-" + index)];
    await pool.query('insert into "user"(id,name,email,email_verified,updated_at) ' +
      "select id,id,id || '@example.test',false,'2026-11-11T01:02:03.123456Z'::timestamptz from unnest($1::text[]) as id", [ids.slice(1)]);
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      const queries: string[] = [];
      const counted = new Proxy(client, { get(target, key) {
        if (key !== "query") return Reflect.get(target, key);
        return (...args: unknown[]) => { queries.push(String(args[0])); return Reflect.apply(target.query, target, args); };
      } });
      const rows = await readMigrationUserSources(counted, ids);
      expect(queries).toHaveLength(2);
      expect(queries.every(sql => sql.includes('from "user" where id=any($1::text[])'))).toBe(true);
      expect(rows).toHaveLength(101);
      const legacy = rows.find(row => row.id === "legacy-text-id")!;
      expect(legacy.updatedAt).toBe("2026-11-11T01:02:03.123456Z");
      expect(migrationUserVersion(legacy)).toBe((await member()).expected_user_version);
      expect((await client.query("select current_setting('transaction_read_only') as readonly,current_setting('transaction_isolation') as isolation")).rows[0])
        .toEqual({ readonly: "on", isolation: "repeatable read" });
      await expect(client.query('delete from "user"')).rejects.toMatchObject({ code: "25006" });
    } finally { await client.query("rollback"); client.release(); }
  });

  scenario("shared source reader retains the caller transaction and does not compare initial versions", async () => {
    const members = [await member("legacy-text-id", { expected_user_version: "f".repeat(64) })];
    const client = await pool.connect();
    try {
      await client.query("begin isolation level read committed");
      const before = (await client.query("select pg_backend_pid() as pid, txid_current()::text as tx,current_setting('transaction_isolation') as isolation")).rows[0];
      const sources = await readMigrationSources(client, members, SCOPE, { tenantKey: TENANT, appId: APP });
      expect(sources.users).toHaveLength(1);
      expect(migrationUserVersion(sources.users[0]!)).not.toBe(members[0]!.expected_user_version);
      expect((await client.query("select pg_backend_pid() as pid, txid_current()::text as tx,current_setting('transaction_isolation') as isolation")).rows[0]).toEqual(before);
      await client.query("rollback");
    } finally { client.release(); }
  });
  scenario("rechecks inventory age at the end without renewing the approved observation", async () => {
    const members = [await member()], before = await stored(), initial = new Date(); let reads = 0;
    const expectation = readScopeExpectation({ ENTERPRISE_DB_INSTANCE_ID: SCOPE, ENTERPRISE_PROCESS_ROLE: "test", ENTERPRISE_DEPLOYMENT_ROLE: "test" })!;
    await expect(previewMigration({ bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, members })),
      databaseUrl: isolated.databaseUrl, expectation, authority: { tenantKey: TENANT, appId: APP }, deadline: performance.now() + 30_000,
      now: () => new Date(initial.getTime() + (++reads === 1 ? 0 : 86_400_000)),
    })).rejects.toThrow("ACTOR_INVENTORY_REJECTED");
    expect(reads).toBe(2); expect(await stored()).toEqual(before);
  });
  scenario("limits a blocked SQL statement to five seconds and closes the rejected connection", async () => {
    const files = input([await member()]), locker = await pool.connect();
    try {
      await locker.query("begin; lock table enterprise_policy in access exclusive mode");
      const start = performance.now(), result = run(files);
      expect(result).toMatchObject({ code: 4, stdout: "", stderr: "error: DEPENDENCY_FAILED\n" });
      expect(performance.now() - start).toBeLessThan(8000); expect(existsSync(files.out)).toBe(false);
    } finally { await locker.query("rollback"); locker.release(); }
    expect((await pool.query("select count(*)::int as count from pg_stat_activity where application_name='megaui-enterprise-preview'")).rows[0].count).toBe(0);
  });
  scenario("enforces the actual CLI total budget across individually bounded slow SQL reads", async () => {
    const files = input([await member()]), before = await stored(), start = performance.now();
    const result = run(files, { env: { FS37_SLOW: "1" } });
    expect(result).toMatchObject({ code: 4, stdout: "", stderr: "error: DEPENDENCY_FAILED\n" });
    expect(performance.now() - start).toBeLessThan(34_000); expect(existsSync(files.out)).toBe(false);
    expect(await stored()).toEqual(before);
  });
  scenario("caps URL timeout overrides and startup options without widening shorter server budgets", async () => {
    for (const timeout of [20000, 2500]) {
      const url = new URL(isolated.databaseUrl);
      for (const name of ["statement_timeout", "query_timeout", "idle_in_transaction_session_timeout"]) url.searchParams.set(name, String(timeout));
      url.searchParams.set("options", "-c statement_timeout=" + timeout + " -c idle_in_transaction_session_timeout=" + timeout);
      const files = input([await member()]), result = run(files, { probe: true, env: { DATABASE_URL: url.toString() } });
      expect(result.code).toBe(0);
      const trace = readFileSync(files.trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(trace).toContainEqual({ budgets: { statement: timeout > 5000 ? "5s" : "2500ms", idle: timeout > 5000 ? "5s" : "2500ms" } });
    }
    const optionsOnly = new URL(isolated.databaseUrl);
    optionsOnly.searchParams.set("options", "-c statement_timeout=2500 -c idle_in_transaction_session_timeout=2500");
    const files = input([await member()]);
    expect(run(files, { probe: true, env: { DATABASE_URL: optionsOnly.toString() } }).code).toBe(0);
    const trace = readFileSync(files.trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(trace).toContainEqual({ budgets: { statement: "2500ms", idle: "2500ms" } });
  });
  scenario("enforces five seconds for locked SQL even when DATABASE_URL requests twelve seconds", async () => {
    const files = input([await member()]), locker = await pool.connect();
    const url = new URL(isolated.databaseUrl);
    for (const name of ["statement_timeout", "query_timeout", "idle_in_transaction_session_timeout"]) url.searchParams.set(name, "12000");
    try {
      await locker.query("begin; lock table enterprise_policy in access exclusive mode");
      const start = performance.now(), result = run(files, { env: { DATABASE_URL: url.toString() } });
      expect(result).toMatchObject({ code: 4, stdout: "", stderr: "error: DEPENDENCY_FAILED\n" });
      expect(performance.now() - start).toBeLessThan(8000); expect(existsSync(files.out)).toBe(false);
    } finally { await locker.query("rollback"); locker.release(); }
  });
});
