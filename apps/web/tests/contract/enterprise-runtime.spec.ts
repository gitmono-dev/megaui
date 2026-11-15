// megaui-only (FS-93): the real public Web assembly against an owned PG target.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "@megaui/database";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { getAuth, initializeEnterpriseWebRuntime } from "@/lib/auth";
import { closeEnterpriseWebRuntime, getReadyWebAssembly } from "@/lib/enterprise-runtime";

const registryKey = Symbol.for("megaui.web.enterprise-runtime");
const scopeKeys = ["ENTERPRISE_PROCESS_ROLE", "ENTERPRISE_OWNER_FINGERPRINT", "ENTERPRISE_DB_INSTANCE_ID",
  "ENTERPRISE_DEPLOYMENT_ROLE", "ENTERPRISE_APPROVED_TARGETS"];
let owned: IsolatedPostgres;
let admin: DatabaseClient;
let webUrl: string;

async function marker(activation = "enterprise", scope = "fs93", environment = "test", owner = "owned") {
  await admin.pool.query(`insert into enterprise_policy
    (id,scope,owner_fingerprint,deployment_role,environment,activation_state,auth_epoch)
    values ($1,$2,$3,$4,$4,$5,$6)`, [`policy-${scope}`, scope, owner, environment, activation, activation === "legacy" ? 0 : 1]);
}
async function backends() {
  return (await admin.pool.query<{ count: number }>(`select count(*)::int as count from pg_stat_activity
    where usename='fs93_web' and datname=current_database()`)).rows[0]!.count;
}
async function expectNoBackends() {
  await expect.poll(backends, { timeout: 3000, interval: 25 }).toBe(0);
}

beforeAll(async () => {
  owned = await createIsolatedPostgres();
  try {
    await owned.migrate();
    admin = createDatabaseClient({ connectionString: owned.databaseUrl });
    const database = decodeURIComponent(new URL(owned.databaseUrl).pathname.slice(1)).replaceAll('"', '""');
    await admin.pool.query(`create role fs93_web login password 'synthetic-fs93-password';
      revoke create on schema public from public;
      revoke create on database "${database}" from public;
      grant connect on database "${database}" to fs93_web;
      grant usage on schema public to fs93_web;
      grant select,insert,update,delete on all tables in schema public to fs93_web;
      grant usage,select on all sequences in schema public to fs93_web`);
    const url = new URL(owned.databaseUrl);
    url.username = "fs93_web"; url.password = "synthetic-fs93-password";
    webUrl = url.toString();
  } catch (error) {
    const cleanup = await Promise.allSettled([admin?.close(), owned.destroy()]);
    const failures = cleanup.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError([error, ...failures], "FS93 fixture setup/cleanup failed", { cause: error });
    throw error;
  }
}, 120_000);

beforeEach(async () => {
  Reflect.deleteProperty(globalThis, registryKey); // Each case represents a fresh host, never an application restart API.
  await admin.pool.query("truncate enterprise_policy cascade");
  await marker();
  const source = { AUTH_MODE: "enterprise", DATABASE_URL: webUrl, ENTERPRISE_PROCESS_ROLE: "web",
    ENTERPRISE_OWNER_FINGERPRINT: "owned", ENTERPRISE_DB_INSTANCE_ID: "fs93", ENTERPRISE_DEPLOYMENT_ROLE: "test",
    FEISHU_TENANT_KEY: "tenant", FEISHU_APP_ID: "app", ENTERPRISE_IP_HMAC_MASTER_KEY: Buffer.alloc(32, 7).toString("base64url"),
    ENTERPRISE_TRUSTED_PROXY_CIDRS: "[]", BETTER_AUTH_URL: "http://127.0.0.1:3000", APP_BASE_URL: "http://127.0.0.1:3000",
    BETTER_AUTH_SECRET: "synthetic-fs93-auth-at-least-32-bytes", EMAIL_PROVIDER: "test", EMAIL_DEFAULT_FROM: "owned@example.test" };
  for (const [key, value] of Object.entries(source)) vi.stubEnv(key, value);
  vi.stubEnv("ENTERPRISE_APPROVED_TARGETS", undefined);
});
afterEach(async () => {
  try { await closeEnterpriseWebRuntime(); await expectNoBackends(); }
  finally { vi.unstubAllEnvs(); Reflect.deleteProperty(globalThis, registryKey); }
});
afterAll(async () => {
  const errors: unknown[] = [];
  try { await admin?.close(); } catch (error) { errors.push(error); }
  try { await owned?.destroy(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "FS93 fixture cleanup failed");
}, 120_000);

describe("real Web runtime assembly", () => {
  it("publishes one Auth, public pairing service and native DML Pool after preflight", async () => {
    expect(() => getAuth()).toThrow("ENTERPRISE_WEB_UNAVAILABLE");
    const first = initializeEnterpriseWebRuntime();
    expect(initializeEnterpriseWebRuntime()).toBe(first);
    const assembly = await first;
    expect(getAuth()).toBe(assembly.auth);
    expect(await initializeEnterpriseWebRuntime()).toBe(assembly);
    expect(getReadyWebAssembly()).toBe(assembly);
    expect(assembly.database.pool.listenerCount("connect")).toBe(0);
    expect(assembly.database.pool.listenerCount("acquire")).toBe(0);
    expect(assembly.pairing.kind).toBe("enabled");
    if (assembly.pairing.kind !== "enabled") throw new Error("pairing was disabled");
    const response = await assembly.pairing.service.request({ loginName: "unknown", flowHash: "a".repeat(64), transport: { peerAddress: "127.0.0.1" } });
    expect(response.kind).toBe("accepted");
    expect((await admin.pool.query("select count(*)::int as count from enterprise_pairings")).rows[0].count).toBe(1);
    const health = await assembly.auth.handler(new Request("http://127.0.0.1:3000/api/auth/ok"));
    expect(health.status).toBe(404);
    const privileges = (await assembly.database.pool.query(`select current_user as name,
      has_schema_privilege(current_user,'public','CREATE') as ddl,
      has_database_privilege(current_user,current_database(),'CREATE') as create_db`)).rows[0];
    expect(privileges).toEqual({ name: "fs93_web", ddl: false, create_db: false });
    expect(assembly.database.pool.options.max).toBe(10);
    expect(assembly.database.pool.options.connectionTimeoutMillis).toBe(1000);
  });

  it("pins effective PG session limits despite URL overrides and PGOPTIONS", async () => {
    vi.stubEnv("PGOPTIONS", "-c statement_timeout=0 -c lock_timeout=0 -c idle_in_transaction_session_timeout=0");
    vi.stubEnv("DATABASE_URL", webUrl + "?statement_timeout=0&query_timeout=0&lock_timeout=0&options=evil&pipeline=true");
    const { database } = await initializeEnterpriseWebRuntime();
    const settings = (await database.pool.query(`select current_setting('statement_timeout') as statement,
      current_setting('lock_timeout') as lock, current_setting('idle_in_transaction_session_timeout') as idle`)).rows[0];
    expect(settings).toEqual({ statement: "3s", lock: "1s", idle: "5s" });
    const client = await database.pool.connect();
    try {
      expect(Number(Reflect.get(Reflect.get(client, "connectionParameters"), "query_timeout"))).toBe(3000);
      expect(client.pipeline).toBe(false);
    } finally { client.release(); }
  });

  it.each(["legacy", "maintenance"])("disables pairing for configured %s without inactive capability secrets", async mode => {
    vi.stubEnv("AUTH_MODE", mode);
    vi.stubEnv("ENTERPRISE_IP_HMAC_MASTER_KEY", undefined);
    vi.stubEnv("ENTERPRISE_TRUSTED_PROXY_CIDRS", undefined);
    vi.stubEnv("FEISHU_APP_ID", undefined);
    if (mode === "legacy") await admin.pool.query("update enterprise_policy set activation_state='legacy',auth_epoch=0");
    expect((await initializeEnterpriseWebRuntime()).pairing.kind).toBe("disabled");
  });

  it("assembles enterprise capability in maintenance but current policy still refuses requests", async () => {
    await admin.pool.query("update enterprise_policy set activation_state='maintenance'");
    const assembly = await initializeEnterpriseWebRuntime();
    expect(assembly.effectiveModeAtStartup).toBe("maintenance");
    if (assembly.pairing.kind !== "enabled") throw new Error("pairing was disabled");
    expect((await assembly.pairing.service.request({ loginName: "unknown", flowHash: "b".repeat(64), transport: { peerAddress: "127.0.0.1" } })).kind).toBe("unavailable");
  });

  it("selects the exact scope rather than accepting a first marker", async () => {
    await marker("maintenance", "earlier-other", "production", "other-owner");
    await admin.pool.query("update enterprise_policy set created_at='2000-01-01' where scope='earlier-other'");
    expect((await initializeEnterpriseWebRuntime()).scope?.instanceId).toBe("fs93");
  });

  it.each(["missing", "owner", "environment", "deployment", "sql-role", "mode", "cidr", "sql-denied"])("rejects %s preflight and never recovers by clearing environment", async kind => {
    if (kind === "missing") await admin.pool.query("delete from enterprise_policy");
    if (kind === "owner") await admin.pool.query("update enterprise_policy set owner_fingerprint='other'");
    if (kind === "environment") await admin.pool.query("update enterprise_policy set environment='production'");
    if (kind === "deployment") await admin.pool.query("update enterprise_policy set deployment_role='production'");
    if (kind === "sql-role") vi.stubEnv("DATABASE_URL", owned.databaseUrl);
    if (kind === "mode") vi.stubEnv("AUTH_MODE", "legacy");
    if (kind === "cidr") vi.stubEnv("ENTERPRISE_TRUSTED_PROXY_CIDRS", '["not-a-cidr"]');
    if (kind === "sql-denied") await admin.pool.query("revoke select on enterprise_policy from fs93_web");
    try {
      await expect(initializeEnterpriseWebRuntime()).rejects.toThrow("ENTERPRISE_WEB_UNAVAILABLE");
      for (const key of scopeKeys) vi.stubEnv(key, undefined);
      vi.stubEnv("AUTH_MODE", "legacy");
      expect(() => getAuth()).toThrow("ENTERPRISE_WEB_UNAVAILABLE");
      await expect(initializeEnterpriseWebRuntime()).rejects.toThrow("ENTERPRISE_WEB_UNAVAILABLE");
    } finally { if (kind === "sql-denied") await admin.pool.query("grant select on enterprise_policy to fs93_web"); }
  });

  it("refuses standard unscoped legacy startup against activated rows", async () => {
    for (const key of scopeKeys) vi.stubEnv(key, undefined);
    vi.stubEnv("AUTH_MODE", "legacy");
    await expect(initializeEnterpriseWebRuntime()).rejects.toThrow("ENTERPRISE_WEB_UNAVAILABLE");
  });
  it.each(["createdb", "createrole", "set-role", "set-schema", "object-owner"])("rejects latent DDL privilege: %s", async kind => {
    if (kind === "createdb") await admin.pool.query("alter role fs93_web createdb");
    if (kind === "createrole") await admin.pool.query("alter role fs93_web createrole");
    if (kind === "set-role") await admin.pool.query("create role fs93_high createdb; grant fs93_high to fs93_web with inherit false, set true");
    if (kind === "set-schema") await admin.pool.query("create role fs93_high; grant create on schema public to fs93_high; grant fs93_high to fs93_web with inherit false, set true");
    if (kind === "object-owner") await admin.pool.query("create table fs93_owned_table(id int); alter table fs93_owned_table owner to fs93_web");
    try {
      await expect(initializeEnterpriseWebRuntime()).rejects.toThrow("ENTERPRISE_WEB_UNAVAILABLE");
    } finally {
      if (kind === "createdb") await admin.pool.query("alter role fs93_web nocreatedb");
      if (kind === "createrole") await admin.pool.query("alter role fs93_web nocreaterole");
      if (kind === "set-role") await admin.pool.query("revoke fs93_high from fs93_web; drop role fs93_high");
      if (kind === "set-schema") await admin.pool.query("revoke fs93_high from fs93_web; revoke create on schema public from fs93_high; drop role fs93_high");
      if (kind === "object-owner") await admin.pool.query("drop table fs93_owned_table");
    }
  });
  it("permits an ordinary DML group membership without ownership or high role attributes", async () => {
    await admin.pool.query("create role fs93_dml_group; grant select on enterprise_policy to fs93_dml_group; grant fs93_dml_group to fs93_web");
    try { expect((await initializeEnterpriseWebRuntime()).mode).toBe("enterprise"); }
    finally { await admin.pool.query("revoke fs93_dml_group from fs93_web; revoke select on enterprise_policy from fs93_dml_group; drop role fs93_dml_group"); }
  });
  it.each(["operator-owner", "publication-owner", "program-role", "set-program-role", "monitor-role"])("rejects additional real privileged capability: %s", async kind => {
    const database = decodeURIComponent(new URL(owned.databaseUrl).pathname.slice(1)).replaceAll('"', '""');
    if (kind === "operator-owner") await admin.pool.query(`grant create on schema public to fs93_web;
      create operator public.=== (function=pg_catalog.int4eq,leftarg=integer,rightarg=integer);
      alter operator public.=== (integer,integer) owner to fs93_web;
      revoke create on schema public from fs93_web`);
    if (kind === "publication-owner") await admin.pool.query(`grant create on database "${database}" to fs93_web;
      create publication fs93_owned_publication;
      alter publication fs93_owned_publication owner to fs93_web;
      revoke create on database "${database}" from fs93_web`);
    if (kind === "program-role") await admin.pool.query("grant pg_execute_server_program to fs93_web");
    if (kind === "set-program-role") await admin.pool.query("grant pg_execute_server_program to fs93_web with inherit false, set true");
    if (kind === "monitor-role") await admin.pool.query("grant pg_monitor to fs93_web");
    try {
      await expect(initializeEnterpriseWebRuntime()).rejects.toThrow("ENTERPRISE_WEB_UNAVAILABLE");
    } finally {
      if (kind === "operator-owner") await admin.pool.query("drop operator if exists public.=== (integer,integer)");
      else if (kind === "publication-owner") await admin.pool.query("drop publication if exists fs93_owned_publication");
      else if (kind === "monitor-role") await admin.pool.query("revoke pg_monitor from fs93_web");
      else await admin.pool.query("revoke pg_execute_server_program from fs93_web");
    }
  });
  it("limits ownership inspection to the selected database", async () => {
    // The separate database is still inside this case's owned PostgreSQL container.
    const other = await admin.pool.query<{ name: string; owner: string }>(`select datname as name,
      pg_catalog.pg_get_userbyid(datdba) as owner from pg_catalog.pg_database
      where datname='postgres' and datname<>current_database()`);
    expect(other.rows).toHaveLength(1);
    const { name, owner } = other.rows[0]!;
    const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    await admin.pool.query(`alter database ${quote(name)} owner to fs93_web`);
    try { expect((await initializeEnterpriseWebRuntime()).mode).toBe("enterprise"); }
    finally { await admin.pool.query(`alter database ${quote(name)} owner to ${quote(owner)}`); }
  });
  it.each(["direct", "set-actor", "dml-group"])("rejects role administration without initial inherited or SET privileges: %s", async kind => {
    if (kind === "direct") await admin.pool.query("grant pg_execute_server_program to fs93_web with admin true, inherit false, set false");
    if (kind === "set-actor") await admin.pool.query(`create role fs93_admin_actor;
      grant pg_execute_server_program to fs93_admin_actor with admin true, inherit false, set false;
      grant fs93_admin_actor to fs93_web with inherit false, set true`);
    if (kind === "dml-group") await admin.pool.query(`create role fs93_admin_target;
      grant select on enterprise_policy to fs93_admin_target;
      grant fs93_admin_target to fs93_web with admin true, inherit false, set false`);
    try { await expect(initializeEnterpriseWebRuntime()).rejects.toThrow("ENTERPRISE_WEB_UNAVAILABLE"); }
    finally {
      if (kind === "direct") await admin.pool.query("revoke pg_execute_server_program from fs93_web");
      if (kind === "set-actor") await admin.pool.query(`revoke fs93_admin_actor from fs93_web;
        revoke pg_execute_server_program from fs93_admin_actor; drop role fs93_admin_actor`);
      if (kind === "dml-group") await admin.pool.query(`revoke fs93_admin_target from fs93_web;
        revoke select on enterprise_policy from fs93_admin_target; drop role fs93_admin_target`);
    }
  });
  it.each(["object-owner", "predefined", "administration"])("rejects authority inherited after switching roles: %s", async kind => {
    await admin.pool.query(`create role fs93_mixed_a; create role fs93_mixed_b;
      grant fs93_mixed_b to fs93_mixed_a with inherit true, set false;
      grant fs93_mixed_a to fs93_web with inherit false, set true`);
    if (kind === "object-owner") await admin.pool.query(`create table fs93_mixed_owned(id int);
      alter table fs93_mixed_owned owner to fs93_mixed_b`);
    if (kind === "predefined") await admin.pool.query("grant pg_execute_server_program to fs93_mixed_b with inherit true, set false");
    if (kind === "administration") await admin.pool.query("grant pg_execute_server_program to fs93_mixed_b with admin true, inherit false, set false");
    try { await expect(initializeEnterpriseWebRuntime()).rejects.toThrow("ENTERPRISE_WEB_UNAVAILABLE"); }
    finally {
      if (kind === "object-owner") await admin.pool.query("drop table fs93_mixed_owned");
      else await admin.pool.query("revoke pg_execute_server_program from fs93_mixed_b");
      await admin.pool.query(`revoke fs93_mixed_a from fs93_web; revoke fs93_mixed_b from fs93_mixed_a;
        drop role fs93_mixed_b; drop role fs93_mixed_a`);
    }
  });
  it("permits completely inaccessible predefined membership without ADMIN OPTION", async () => {
    await admin.pool.query("grant pg_execute_server_program to fs93_web with admin false, inherit false, set false");
    try { expect((await initializeEnterpriseWebRuntime()).mode).toBe("enterprise"); }
    finally { await admin.pool.query("revoke pg_execute_server_program from fs93_web"); }
  });
  it.each(["createdb", "superuser"])("does not treat an inherited but non-SET role's %s attribute as usable", async attribute => {
    await admin.pool.query(`create role fs93_mixed_a; create role fs93_mixed_b ${attribute};
      grant fs93_mixed_b to fs93_mixed_a with inherit true, set false;
      grant fs93_mixed_a to fs93_web with inherit false, set true`);
    try {
      const assembly = await initializeEnterpriseWebRuntime();
      expect(assembly.mode).toBe("enterprise");
      const client = await assembly.database.pool.connect();
      try {
        await client.query("set role fs93_mixed_a");
        const privileges = (await client.query(`select
          pg_catalog.has_database_privilege(current_user,current_database(),'CREATE') as database_create,
          pg_catalog.has_schema_privilege(current_user,'public','CREATE') as schema_create,
          pg_catalog.pg_has_role(session_user,'fs93_mixed_b','SET') as can_set_b`)).rows[0];
        expect(privileges).toEqual({ database_create: false, schema_create: false, can_set_b: false });
      } finally { client.release(true); } // Discard this deliberately changed session identity.
    }
    finally {
      await admin.pool.query(`revoke fs93_mixed_a from fs93_web; revoke fs93_mixed_b from fs93_mixed_a;
        drop role fs93_mixed_b; drop role fs93_mixed_a`);
    }
  });
  it("pins new connections against driver-env changes and seals the next getter until restart", async () => {
    const assembly = await initializeEnterpriseWebRuntime();
    const held = await assembly.database.pool.connect();
    const changes = { PGSSLMODE: "require", PGSSLNEGOTIATION: "direct", PGCLIENT_ENCODING: "LATIN1", PGREPLICATION: "database", PGBINARY: "true" };
    try {
      for (const [key, value] of Object.entries(changes)) vi.stubEnv(key, value);
      // An already admitted operation may still borrow from the captured Pool;
      // fixed URL parameters must win even before a getter notices the drift.
      const late = await assembly.database.pool.connect();
      try {
        expect(late.ssl).toBe(false);
        expect(Reflect.get(late, "binary")).toBe(false);
        expect((await late.query("show client_encoding")).rows[0].client_encoding).toBe("UTF8");
        expect(Reflect.get(Reflect.get(late, "connectionParameters"), "replication")).toBe("false");
        expect(Reflect.get(Reflect.get(late, "connectionParameters"), "sslnegotiation")).toBe("postgres");
      } finally { late.release(); }
    } finally { held.release(); }
    expect(() => getAuth()).toThrow("ENTERPRISE_WEB_UNAVAILABLE");
    for (const key of Object.keys(changes)) vi.stubEnv(key, undefined);
    await expect(initializeEnterpriseWebRuntime()).rejects.toThrow("ENTERPRISE_WEB_UNAVAILABLE");
  });
  it("permits standard unscoped legacy only after the actual persistent precheck", async () => {
    for (const key of scopeKeys) vi.stubEnv(key, undefined);
    vi.stubEnv("AUTH_MODE", "legacy");
    await admin.pool.query("delete from enterprise_policy");
    const assembly = await initializeEnterpriseWebRuntime();
    expect(assembly.mode).toBe("legacy");
    expect(assembly.pairing.kind).toBe("disabled");
    expect(getAuth()).toBe(assembly.auth);
  });

  it("bounds a locked preflight and closes its borrowed connection", async () => {
    const blocker = await admin.pool.connect();
    try {
      await blocker.query("begin; lock table enterprise_policy in access exclusive mode");
      const started = Date.now();
      await expect(initializeEnterpriseWebRuntime()).rejects.toThrow("ENTERPRISE_WEB_UNAVAILABLE");
      expect(Date.now() - started).toBeLessThan(4500);
      expect(await closeEnterpriseWebRuntime()).toEqual({ kind: "closed" });
      await expectNoBackends();
    } finally { await blocker.query("rollback"); blocker.release(); }
  }, 10_000);

  it("seals configuration drift, including attempted downgrade, until host restart", async () => {
    await initializeEnterpriseWebRuntime();
    vi.stubEnv("AUTH_MODE", "legacy");
    for (const key of scopeKeys) vi.stubEnv(key, undefined);
    expect(() => getAuth()).toThrow("ENTERPRISE_WEB_UNAVAILABLE");
    vi.stubEnv("AUTH_MODE", "enterprise");
    vi.stubEnv("ENTERPRISE_PROCESS_ROLE", "web"); vi.stubEnv("ENTERPRISE_OWNER_FINGERPRINT", "owned");
    vi.stubEnv("ENTERPRISE_DB_INSTANCE_ID", "fs93"); vi.stubEnv("ENTERPRISE_DEPLOYMENT_ROLE", "test");
    expect(() => getAuth()).toThrow("ENTERPRISE_WEB_UNAVAILABLE");
    await expect(initializeEnterpriseWebRuntime()).rejects.toThrow("ENTERPRISE_WEB_UNAVAILABLE");
  });

  it("shares close, immediately seals getters/captured pairing, and proves backend departure", async () => {
    const assembly = await initializeEnterpriseWebRuntime();
    const first = closeEnterpriseWebRuntime();
    expect(closeEnterpriseWebRuntime()).toBe(first);
    expect(() => getAuth()).toThrow("ENTERPRISE_WEB_UNAVAILABLE");
    if (assembly.pairing.kind !== "enabled") throw new Error("pairing was disabled");
    expect((await assembly.pairing.service.request({ loginName: "unknown", flowHash: "c".repeat(64), transport: { peerAddress: "127.0.0.1" } })).kind).toBe("unavailable");
    expect(await first).toEqual({ kind: "closed" });
    await expectNoBackends();
    await expect(initializeEnterpriseWebRuntime()).rejects.toThrow("ENTERPRISE_WEB_UNAVAILABLE");
  });

  it("reports cleanup-pending for an outstanding borrower and never rewrites that result", async () => {
    const assembly = await initializeEnterpriseWebRuntime();
    const borrower = await assembly.database.pool.connect();
    try {
      const started = Date.now();
      const result = await closeEnterpriseWebRuntime();
      expect(result).toEqual({ kind: "cleanup-pending" });
      expect(Date.now() - started).toBeLessThan(6500);
      expect(() => getAuth()).toThrow("ENTERPRISE_WEB_UNAVAILABLE");
      expect(await backends()).toBe(1);
    } finally { borrower.release(); }
    await expectNoBackends();
    expect(await closeEnterpriseWebRuntime()).toEqual({ kind: "cleanup-pending" });
  }, 10_000);
});
