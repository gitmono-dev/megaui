// megaui-only (FSL-158, GC-15): the privilege check of the Web runtime role against a one-shot
// PostgreSQL. A migration role (no superuser, no CREATEDB) applies the migration set and owns the
// tables; seven login roles are then built next to it, plus an injected read failure:
//   superuser, CREATEDB only, CREATE on the current database only, CREATE on `public` only,
//   CREATE on a non-public schema only, a member that may SET ROLE to a CREATEDB role, and a
//   role granted only DML and sequence USAGE.
// AC1-AC6: with NODE_ENV=production each of the first six (and the read failure) is refused with
// DATABASE_ROLE_SCOPE_REJECTED and the DML-only role passes. AC7: in development and test each
// of them only prints DATABASE_ROLE_SCOPE_WARNING.
// FSL-162 (ownership and output redaction): seven more roles, each owning exactly one thing and
// holding nothing else unless stated: a non-public schema, a table, a collation, a text search
// configuration, the current database, a NOINHERIT member that may SET ROLE to the table owner,
// and the migration role itself. AC1-AC4: with NODE_ENV=production each is refused with
// DATABASE_ROLE_SCOPE_REJECTED and hits exactly its ownership facts. AC5/AC6: the refusal and the
// warning are captured and equal `role=<name> facts=<categories>` exactly, without the connection
// string, the password, the host or any object or schema name; a role name that is not a plain
// identifier cannot split the line. It needs a docker daemon: without one the run fails instead
// of passing quietly.
import { randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DATABASE_ROLE_SCOPE_REJECTED,
  DATABASE_ROLE_SCOPE_WARNING,
  DatabaseRoleScopeError,
  assertRuntimeRoleScope,
  checkRuntimeRoleScope,
  findRuntimeRoleScopeViolations,
  readRuntimeRolePrivileges,
  type RoleScopeQueryable,
  type RuntimeRoleFact,
} from "./role-scope";
import {
  createIsolatedPostgres,
  isDockerAvailable,
  resolveMigrationsFolder,
  type IsolatedPostgres,
} from "./test-support/isolated-pg";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error("[@megaui/database] role-scope.test.ts: a docker daemon is required (the fixture owns its own Postgres).");
}

const PASSWORD = randomBytes(16).toString("hex");

let isolated: IsolatedPostgres | undefined;
const pools: Pool[] = [];

function createPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString, max: 1 });
  pool.on("error", () => {});
  pools.push(pool);
  return pool;
}

/** The connection string of the one-shot database as `role`. */
function urlAs(role: string): string {
  const url = new URL(isolated!.databaseUrl);
  url.username = role;
  url.password = PASSWORD;
  return url.toString();
}

/** A pool of the one-shot database as `role`. */
const poolAs = (role: string) => createPool(urlAs(role));

interface RoleCase {
  readonly label: string;
  readonly login: string;
  /** The roles of the checked set that hit a fact, with exactly the facts they hit. */
  readonly expected: Readonly<Record<string, readonly RuntimeRoleFact[]>>;
}

/** The six roles that hold too much (AC1-AC4), each with the findings it produces. */
const TOO_POWERFUL: readonly RoleCase[] = [
  { label: "AC1 superuser", login: "rs_super", expected: {} },
  { label: "AC2 CREATEDB only", login: "rs_createdb", expected: { rs_createdb: ["createdb"] } },
  { label: "AC3 CREATE on the current database only", login: "rs_dbcreate", expected: { rs_dbcreate: ["database_create"] } },
  { label: "AC4 CREATE on schema public only", login: "rs_public", expected: { rs_public: ["schema_create"] } },
  { label: "AC4 CREATE on a non-public schema only", login: "rs_other", expected: { rs_other: ["schema_create"] } },
  { label: "AC2 member that may SET ROLE to a CREATEDB role", login: "rs_member", expected: { rs_creator: ["createdb"] } },
];

/**
 * FSL-162: the roles that own something (AC1-AC4). Owning a schema also grants `CREATE` on it;
 * the owner of the database also holds `CREATE` on it and is a member of `pg_database_owner`, the
 * owner of `public`.
 */
const OWNERS: readonly RoleCase[] = [
  {
    label: "FSL-162 AC1 owns a non-public schema",
    login: "rs_schema_owner",
    expected: { rs_schema_owner: ["schema_create", "schema_owner", "object_owner"] },
  },
  { label: "FSL-162 AC2 owns a table", login: "rs_table_owner", expected: { rs_table_owner: ["object_owner"] } },
  { label: "FSL-162 AC2 owns a collation", login: "rs_collation_owner", expected: { rs_collation_owner: ["object_owner"] } },
  {
    label: "FSL-162 AC2 owns a text search configuration",
    login: "rs_tsconfig_owner",
    expected: { rs_tsconfig_owner: ["object_owner"] },
  },
  {
    label: "FSL-162 AC3 owns the current database",
    login: "rs_db_owner",
    expected: {
      pg_database_owner: ["schema_create", "schema_owner"],
      rs_db_owner: ["database_create", "schema_create", "database_owner"],
    },
  },
  {
    label: "FSL-162 AC4 NOINHERIT member that may SET ROLE to the table owner",
    login: "rs_noinherit_owner",
    expected: { rs_table_owner: ["object_owner"] },
  },
  {
    label: "FSL-162 AC2 the migration role used as the runtime role",
    login: "rs_migrator",
    expected: { rs_migrator: ["database_create", "schema_create", "schema_owner", "object_owner"] },
  },
];

/** The object and schema names of the ownership fixture; no output may name them. */
const OBJECT_NAMES = ["rs_objects", "rs_owned_schema", "rs_owned_table", "rs_owned_collation", "rs_owned_tsconfig", "drizzle", "feishu_"];

/** The exact output of `findings`, in the order of the checked role set. */
function rendered(expected: RoleCase["expected"]): string {
  return Object.entries(expected).map(([role, facts]) => `role=${role} facts=${facts.join(",")}`).join("; ");
}

/** AC5/AC6: no connection string, password, host, database, object or schema name. */
function expectRedacted(output: string, login: string): void {
  const url = new URL(isolated!.databaseUrl);
  for (const leak of [PASSWORD, urlAs(login), isolated!.databaseUrl, url.host, isolated!.databaseName, ...OBJECT_NAMES]) {
    expect(output).not.toContain(leak);
  }
}

describe("FSL-158 Web runtime role privilege isolation", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    const admin = createPool(isolated.databaseUrl);
    const db = `"${isolated.databaseName}"`;
    // The migration role may run DDL in this database and owns what the migrations create; it is
    // neither a superuser nor CREATEDB.
    await admin.query(`create role rs_migrator login password '${PASSWORD}'`);
    await admin.query(`grant create on database ${db} to rs_migrator`);
    await admin.query("grant create on schema public to rs_migrator");
    const migrator = poolAs("rs_migrator");
    await drizzleMigrate(drizzle(migrator), { migrationsFolder: resolveMigrationsFolder() });

    // Every login role may connect (PUBLIC already holds CONNECT and TEMP) and use `public`.
    for (const role of ["rs_super", "rs_createdb", "rs_dbcreate", "rs_public", "rs_other", "rs_member", "rs_runtime"]) {
      const attributes = role === "rs_super" ? " superuser" : role === "rs_createdb" ? " createdb" : "";
      await admin.query(`create role ${role} login${attributes} password '${PASSWORD}'`);
      await admin.query(`grant usage on schema public to ${role}`);
    }
    await admin.query(`grant create on database ${db} to rs_dbcreate`);
    await admin.query("grant create on schema public to rs_public");
    // `drizzle` holds the migration ledger and belongs to the migration role.
    await migrator.query("grant usage, create on schema drizzle to rs_other");
    await admin.query("create role rs_creator nologin createdb");
    await admin.query("grant rs_creator to rs_member");
    // An indirect membership (rs_indirect -> rs_mid -> rs_creator) and a NOINHERIT one.
    await admin.query("create role rs_mid nologin");
    await admin.query("grant rs_creator to rs_mid");
    await admin.query(`create role rs_indirect login password '${PASSWORD}'`);
    await admin.query("grant rs_mid to rs_indirect");
    await admin.query(`create role rs_noinherit login noinherit password '${PASSWORD}'`);
    await admin.query("grant rs_creator to rs_noinherit");
    // The runtime role of a deployment: DML on the tables of the migration role, sequence USAGE.
    await migrator.query("grant select, insert, update, delete on all tables in schema public to rs_runtime");
    await migrator.query("grant usage on all sequences in schema public to rs_runtime");

    // FSL-162: `rs_objects` belongs to the admin (the bootstrap superuser, whose ownership
    // `pg_shdepend` does not record) and holds one object of each kind, each owned by a role that
    // holds nothing else.
    for (const role of ["rs_schema_owner", "rs_table_owner", "rs_collation_owner", "rs_tsconfig_owner", "rs_db_owner"]) {
      await admin.query(`create role ${role} login password '${PASSWORD}'`);
    }
    await admin.query("create schema rs_owned_schema authorization rs_schema_owner");
    await admin.query("create schema rs_objects");
    await admin.query("create table rs_objects.rs_owned_table (id int)");
    await admin.query("alter table rs_objects.rs_owned_table owner to rs_table_owner");
    await admin.query("create collation rs_objects.rs_owned_collation (provider = libc, locale = 'C')");
    await admin.query("alter collation rs_objects.rs_owned_collation owner to rs_collation_owner");
    await admin.query("create text search configuration rs_objects.rs_owned_tsconfig (copy = pg_catalog.simple)");
    await admin.query("alter text search configuration rs_objects.rs_owned_tsconfig owner to rs_tsconfig_owner");
    await admin.query(`alter database ${db} owner to rs_db_owner`);
    await admin.query(`create role rs_noinherit_owner login noinherit password '${PASSWORD}'`);
    await admin.query("grant rs_table_owner to rs_noinherit_owner");
    await admin.query("grant usage on schema rs_objects to rs_table_owner, rs_noinherit_owner");
  }, 180_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const pool of pools) {
      try { await pool.end(); } catch (error) { errors.push(error); }
    }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FSL-158 role-scope cleanup failed");
  }, 120_000);

  it("the tables of the migration set belong to the migration role", async () => {
    const owners = await poolAs("rs_runtime").query<{ owner: string }>(
      "select distinct tableowner as owner from pg_catalog.pg_tables where schemaname = 'public'",
    );
    expect(owners.rows.map(row => row.owner)).toEqual(["rs_migrator"]);
  });

  it.each(TOO_POWERFUL)("$label: the checked role set hits exactly its facts", async ({ login, expected }) => {
    const privileges = await readRuntimeRolePrivileges(poolAs(login));
    expect(privileges.currentUser).toBe(login);
    const findings = findRuntimeRoleScopeViolations(privileges);
    if (login === "rs_super") {
      // `SUPERUSER` does not set `rolcreatedb`, but a superuser holds every privilege; it is also
      // a member of every role, so the CREATEDB role of another case is in its checked set.
      expect(findings.find(finding => finding.roleName === login)?.facts)
        .toEqual(["superuser", "database_create", "schema_create"]);
      expect(findings.find(finding => finding.roleName === "rs_creator")?.facts).toEqual(["createdb"]);
      return;
    }
    expect(Object.fromEntries(findings.map(finding => [finding.roleName, finding.facts]))).toEqual(expected);
  });

  it("AC2: the checked role set of a member contains the role it may SET ROLE to", async () => {
    const privileges = await readRuntimeRolePrivileges(poolAs("rs_member"));
    expect(privileges.roles.map(role => role.roleName)).toEqual(["rs_creator", "rs_member"]);
    // The member itself holds nothing; only the role it may switch to does.
    expect(privileges.roles.find(role => role.roleName === "rs_member")).toEqual({
      roleName: "rs_member", superuser: false, createDb: false, databaseCreate: false, schemaCreate: false,
      databaseOwner: false, schemaOwner: false, objectOwner: false,
    });
  });

  it.each([
    ["an indirect member", "rs_indirect", ["rs_creator", "rs_indirect", "rs_mid"]],
    ["a NOINHERIT member", "rs_noinherit", ["rs_creator", "rs_noinherit"]],
  ] as const)("AC2: the checked role set of %s contains the CREATEDB role and production refuses", async (_label, login, set) => {
    const privileges = await readRuntimeRolePrivileges(poolAs(login));
    expect(privileges.roles.map(role => role.roleName)).toEqual(set);
    expect(findRuntimeRoleScopeViolations(privileges)).toEqual([{ roleName: "rs_creator", facts: ["createdb"] }]);
    await expect(checkRuntimeRoleScope(poolAs(login), { nodeEnv: "production" }))
      .rejects.toMatchObject({ code: DATABASE_ROLE_SCOPE_REJECTED, findings: [{ roleName: "rs_creator", facts: ["createdb"] }] });
  });

  it.each(TOO_POWERFUL)("$label: NODE_ENV=production refuses with DATABASE_ROLE_SCOPE_REJECTED", async ({ login }) => {
    const warnings: string[] = [];
    const refusal = await checkRuntimeRoleScope(poolAs(login), { nodeEnv: "production", warn: line => warnings.push(line) })
      .then(() => undefined, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(DatabaseRoleScopeError);
    expect(refusal).toMatchObject({ code: DATABASE_ROLE_SCOPE_REJECTED, unreadable: false });
    const message = (refusal as Error).message;
    expect(message.startsWith(`${DATABASE_ROLE_SCOPE_REJECTED}: `)).toBe(true);
    // Role names and fact categories only: no connection string, password or schema name.
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain(isolated!.databaseName);
    expect(message).not.toContain("127.0.0.1");
    expect(message).not.toContain("drizzle");
    expect(warnings).toEqual([]);
  });

  it("AC5: NODE_ENV=production refuses when the privileges cannot be read", async () => {
    const failing: RoleScopeQueryable = { query: () => Promise.reject(new Error(`connect failed ${urlAs("rs_runtime")}`)) };
    const refusal = await checkRuntimeRoleScope(failing, { nodeEnv: "production" }).then(() => undefined, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(DatabaseRoleScopeError);
    expect(refusal).toMatchObject({ code: DATABASE_ROLE_SCOPE_REJECTED, unreadable: true, findings: [] });
    expect((refusal as Error).message).toBe(`${DATABASE_ROLE_SCOPE_REJECTED}: facts=unreadable`);
  });

  it("AC5: a result without current_user counts as unreadable", async () => {
    const empty: RoleScopeQueryable = { query: () => Promise.resolve({ rows: [] }) };
    await expect(readRuntimeRolePrivileges(empty)).rejects.toThrow(/current_user/);
    await expect(checkRuntimeRoleScope(empty, { nodeEnv: "production" }))
      .rejects.toMatchObject({ code: DATABASE_ROLE_SCOPE_REJECTED, unreadable: true });
  });

  it("AC7: any NODE_ENV other than production, unset included, only warns", async () => {
    for (const nodeEnv of [undefined, "", "staging", "Production"]) {
      const warnings: string[] = [];
      await expect(checkRuntimeRoleScope(poolAs("rs_public"), { nodeEnv, warn: line => warnings.push(line) }))
        .resolves.toEqual([{ roleName: "rs_public", facts: ["schema_create"] }]);
      expect(warnings).toEqual([`${DATABASE_ROLE_SCOPE_WARNING}: role=rs_public facts=schema_create`]);
    }
  });

  it("AC6: NODE_ENV=production accepts a role granted only DML and sequence USAGE", async () => {
    const pool = poolAs("rs_runtime");
    const privileges = await readRuntimeRolePrivileges(pool);
    expect(privileges.currentUser).toBe("rs_runtime");
    expect(privileges.roles).toEqual([{
      roleName: "rs_runtime", superuser: false, createDb: false, databaseCreate: false, schemaCreate: false,
      databaseOwner: false, schemaOwner: false, objectOwner: false,
    }]);
    const warnings: string[] = [];
    await expect(checkRuntimeRoleScope(pool, { nodeEnv: "production", warn: line => warnings.push(line) })).resolves.toEqual([]);
    expect(warnings).toEqual([]);
    // The role still reads and writes rows of the migration role's tables.
    await pool.query("delete from feishu_login_codes");
    await expect(pool.query("create table rs_probe (id int)")).rejects.toThrow();
  });

  describe.each(["development", "test"])("AC7: NODE_ENV=%s", nodeEnv => {
    it.each(TOO_POWERFUL)("$label: prints DATABASE_ROLE_SCOPE_WARNING and continues", async ({ login, expected }) => {
      const warnings: string[] = [];
      const findings = await checkRuntimeRoleScope(poolAs(login), { nodeEnv, warn: line => warnings.push(line) });
      expect(findings.length).toBeGreaterThan(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.startsWith(`${DATABASE_ROLE_SCOPE_WARNING}: `)).toBe(true);
      for (const [role, facts] of Object.entries(expected)) {
        expect(warnings[0]).toContain(`role=${role} facts=${facts.join(",")}`);
      }
      expect(warnings[0]).not.toContain(PASSWORD);
      expect(warnings[0]).not.toContain(isolated!.databaseName);
    });

    it("an unreadable read prints DATABASE_ROLE_SCOPE_WARNING and continues", async () => {
      const warnings: string[] = [];
      const failing: RoleScopeQueryable = { query: () => Promise.reject(new Error("boom")) };
      await expect(checkRuntimeRoleScope(failing, { nodeEnv, warn: line => warnings.push(line) })).resolves.toEqual([]);
      expect(warnings).toEqual([`${DATABASE_ROLE_SCOPE_WARNING}: facts=unreadable`]);
    });

    it("the DML-only role prints nothing", async () => {
      const warnings: string[] = [];
      await expect(checkRuntimeRoleScope(poolAs("rs_runtime"), { nodeEnv, warn: line => warnings.push(line) })).resolves.toEqual([]);
      expect(warnings).toEqual([]);
    });
  });

  it.each(OWNERS)("$label: the checked role set hits exactly its facts", async ({ login, expected }) => {
    const privileges = await readRuntimeRolePrivileges(poolAs(login));
    expect(privileges.currentUser).toBe(login);
    expect(Object.fromEntries(findRuntimeRoleScopeViolations(privileges).map(finding => [finding.roleName, finding.facts])))
      .toEqual(expected);
  });

  it("FSL-162 AC4: the NOINHERIT member may not alter the table itself but may after SET ROLE", async () => {
    const pool = poolAs("rs_noinherit_owner");
    const privileges = await readRuntimeRolePrivileges(pool);
    expect(privileges.roles.map(role => role.roleName)).toEqual(["rs_noinherit_owner", "rs_table_owner"]);
    expect(privileges.roles.find(role => role.roleName === "rs_noinherit_owner")).toEqual({
      roleName: "rs_noinherit_owner", superuser: false, createDb: false, databaseCreate: false, schemaCreate: false,
      databaseOwner: false, schemaOwner: false, objectOwner: false,
    });
    await pool.query("begin");
    try {
      await expect(pool.query("alter table rs_objects.rs_owned_table add column rs_probe int")).rejects.toThrow(/must be owner/);
    } finally {
      await pool.query("rollback");
    }
    await pool.query("begin");
    try {
      await pool.query("set local role rs_table_owner");
      await pool.query("alter table rs_objects.rs_owned_table add column rs_probe int");
    } finally {
      await pool.query("rollback");
    }
  });

  it.each(OWNERS)("$label: NODE_ENV=production refuses with exactly the role names and fact categories", async ({ login, expected }) => {
    const warnings: string[] = [];
    const refusal = await checkRuntimeRoleScope(poolAs(login), { nodeEnv: "production", warn: line => warnings.push(line) })
      .then(() => undefined, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(DatabaseRoleScopeError);
    const error = refusal as DatabaseRoleScopeError;
    expect(error).toMatchObject({ code: DATABASE_ROLE_SCOPE_REJECTED, unreadable: false });
    expect(error.message).toBe(`${DATABASE_ROLE_SCOPE_REJECTED}: ${rendered(expected)}`);
    expect(error.cause).toBeUndefined();
    // AC5: the message, its string form, its stack and its serialized fields carry nothing else.
    for (const output of [error.message, String(error), error.stack ?? "", JSON.stringify(error)]) {
      expectRedacted(output, login);
    }
    expect(warnings).toEqual([]);
  });

  it("FSL-162 AC5: a refused read prints no driver error, connection string or password", async () => {
    const failing: RoleScopeQueryable = {
      query: () => Promise.reject(new Error(`password authentication failed: ${urlAs("rs_runtime")}`)),
    };
    const refusal = await checkRuntimeRoleScope(failing, { nodeEnv: "production" }).then(() => undefined, (error: unknown) => error);
    const error = refusal as DatabaseRoleScopeError;
    expect(error.message).toBe(`${DATABASE_ROLE_SCOPE_REJECTED}: facts=unreadable`);
    expect(error.cause).toBeUndefined();
    for (const output of [error.message, String(error), error.stack ?? "", JSON.stringify(error)]) {
      expectRedacted(output, "rs_runtime");
      expect(output).not.toContain("password authentication");
    }
  });

  describe.each(["development", "test"])("FSL-162 AC6: NODE_ENV=%s", nodeEnv => {
    it.each(OWNERS)("$label: prints exactly one redacted DATABASE_ROLE_SCOPE_WARNING line", async ({ login, expected }) => {
      const warnings: string[] = [];
      await expect(checkRuntimeRoleScope(poolAs(login), { nodeEnv, warn: line => warnings.push(line) }))
        .resolves.toEqual(Object.entries(expected).map(([roleName, facts]) => ({ roleName, facts })));
      expect(warnings).toEqual([`${DATABASE_ROLE_SCOPE_WARNING}: ${rendered(expected)}`]);
      expectRedacted(warnings[0]!, login);
    });

    it("an unreadable read prints no driver error, connection string or password", async () => {
      const warnings: string[] = [];
      const failing: RoleScopeQueryable = {
        query: () => Promise.reject(new Error(`password authentication failed: ${urlAs("rs_runtime")}`)),
      };
      await expect(checkRuntimeRoleScope(failing, { nodeEnv, warn: line => warnings.push(line) })).resolves.toEqual([]);
      expect(warnings).toEqual([`${DATABASE_ROLE_SCOPE_WARNING}: facts=unreadable`]);
    });
  });

  it("FSL-162 AC5/AC6: a role name that is not a plain identifier is quoted and escaped on one line", () => {
    const owner = (roleName: string) => ({
      roleName, superuser: false, createDb: false, databaseCreate: false, schemaCreate: false,
      databaseOwner: false, schemaOwner: false, objectOwner: true,
    });
    const privileges = {
      currentUser: "rs_odd",
      roles: [owner('rs odd\nDATABASE_ROLE_SCOPE_WARNING: role=x facts=none; "q" \\ é'), owner("rs_plain.name-1$")],
    };
    const expected = "role=\"rs odd\\u000aDATABASE_ROLE_SCOPE_WARNING: role\\u003dx facts\\u003dnone\\u003b \\u0022q\\u0022 \\u005c \\u00e9\" "
      + "facts=object_owner; "
      + "role=rs_plain.name-1$ facts=object_owner";
    const warnings: string[] = [];
    assertRuntimeRoleScope({ privileges, nodeEnv: "test", warn: line => warnings.push(line) });
    expect(warnings).toEqual([`${DATABASE_ROLE_SCOPE_WARNING}: ${expected}`]);
    expect(warnings[0]).not.toContain("\n");
    // Exactly two entries: the name forges neither a separator nor a `role=` entry.
    expect(warnings[0]!.split("; ")).toHaveLength(2);
    expect(warnings[0]!.match(/role=/g)).toHaveLength(2);
    let refusal: unknown;
    try {
      assertRuntimeRoleScope({ privileges, nodeEnv: "production" });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(DatabaseRoleScopeError);
    expect((refusal as Error).message).toBe(`${DATABASE_ROLE_SCOPE_REJECTED}: ${expected}`);
    expect((refusal as Error).message).not.toContain("\n");
    // The structured findings keep the role name as it is.
    expect((refusal as DatabaseRoleScopeError).findings[0]!.roleName).toContain("\n");
  });

  it("assertRuntimeRoleScope prints to console.warn by default outside production", () => {
    const lines: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      assertRuntimeRoleScope({ privileges: null, nodeEnv: "test" });
    } finally {
      console.warn = original;
    }
    expect(lines).toEqual([`${DATABASE_ROLE_SCOPE_WARNING}: facts=unreadable`]);
  });
});
