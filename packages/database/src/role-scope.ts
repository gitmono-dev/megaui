// megaui-only (FSL-158, FSL-162, GC-15): the database privilege isolation of the Web runtime role.
//
// The Web runtime role may only read and write rows: it gets `SELECT` / `INSERT` / `UPDATE` /
// `DELETE` and sequence `USAGE`, the tables belong to the migration role, and `db:migrate` runs
// as that migration role. This module reads what the connected role (and every role it may
// `SET ROLE` to) actually holds and decides whether the Web may start with it.
//
// The checked role set R is `current_user` plus every role it is a member of
// (`pg_has_role(current_user, oid, 'MEMBER')`, which covers both inherited and `NOINHERIT`
// memberships). The protected range is every schema of the current database except
// `pg_catalog`, `information_schema` and `pg_toast*`, with the objects in them. For each role of
// R these facts are checked:
//   1. `superuser` / `createdb`: `rolsuper` or `rolcreatedb` is set (`CREATEDB` is the role
//      attribute, not `has_database_privilege(..., 'CREATE')`);
//   2. `database_create`: `CREATE` on the current database (it may create schemas);
//   3. `schema_create`: `CREATE` on any schema of the protected range;
//   4. ownership (FSL-162): an owner may `ALTER` / `DROP` what it owns, so the role must own
//      nothing: `database_owner` (`pg_database.datdba` of the current database),
//      `schema_owner` (`pg_namespace.nspowner` of a schema of the protected range) and
//      `object_owner` (an owner dependency, `pg_shdepend.deptype = 'o'`, recorded for the current
//      database: tables, sequences, views, functions, types, collations, operators, text search
//      objects, extended statistics, schemas and every other object type that has an owner).
//      `pg_shdepend` records no dependency on a pinned role (the bootstrap superuser and the
//      predefined `pg_*` roles); the bootstrap superuser is caught by `superuser`, and the
//      schemas `pg_database_owner` owns by `schema_owner`.
//
// With `NODE_ENV=production` any fact refuses the startup with `DATABASE_ROLE_SCOPE_REJECTED`;
// in every other environment (tests and local development commonly use a superuser) it only
// prints `DATABASE_ROLE_SCOPE_WARNING`. Privileges that cannot be read count as a fact of their
// own (`unreadable`). The output carries role names and fact categories only: never a connection
// string, a password, an object or schema name, or a driver error. A role name that is not a
// plain identifier is printed quoted with `"`, the backslash, `;`, `=` and every character outside
// printable ASCII escaped, so it cannot split the line or forge another `role=` entry (FSL-162).
import type { QueryResultRow } from "pg";

/** A fact that makes a role too powerful for the Web runtime. */
export type RuntimeRoleFact =
  | "superuser"
  | "createdb"
  | "database_create"
  | "schema_create"
  | "database_owner"
  | "schema_owner"
  | "object_owner";

/** The facts of one role of the checked role set. */
export interface RuntimeRolePrivilege {
  readonly roleName: string;
  /** `rolsuper`. */
  readonly superuser: boolean;
  /** `rolcreatedb`, the role attribute. */
  readonly createDb: boolean;
  /** `CREATE` on the current database. */
  readonly databaseCreate: boolean;
  /** `CREATE` on at least one schema of the protected range. */
  readonly schemaCreate: boolean;
  /** Owns the current database (`pg_database.datdba`). */
  readonly databaseOwner: boolean;
  /** Owns at least one schema of the protected range (`pg_namespace.nspowner`). */
  readonly schemaOwner: boolean;
  /** Owns at least one object of the current database (an owner dependency in `pg_shdepend`). */
  readonly objectOwner: boolean;
}

/** What the connected role and every role it may `SET ROLE` to hold. */
export interface RuntimeRolePrivileges {
  /** `current_user` of the connection. */
  readonly currentUser: string;
  /** Every role of the checked role set, `current_user` included, ordered by name. */
  readonly roles: readonly RuntimeRolePrivilege[];
}

/** A role of the checked set together with the facts it hits. */
export interface RuntimeRoleScopeFinding {
  readonly roleName: string;
  readonly facts: readonly RuntimeRoleFact[];
}

export const DATABASE_ROLE_SCOPE_REJECTED = "DATABASE_ROLE_SCOPE_REJECTED";
export const DATABASE_ROLE_SCOPE_WARNING = "DATABASE_ROLE_SCOPE_WARNING";

/** The refusal of the Web startup; it carries role names and fact categories only. */
export class DatabaseRoleScopeError extends Error {
  readonly code = DATABASE_ROLE_SCOPE_REJECTED;
  /** The roles that hit a fact; empty when the privileges could not be read. */
  readonly findings: readonly RuntimeRoleScopeFinding[];
  /** True when the privileges could not be read. */
  readonly unreadable: boolean;

  constructor(findings: readonly RuntimeRoleScopeFinding[], unreadable: boolean) {
    super(`${DATABASE_ROLE_SCOPE_REJECTED}: ${describeOutcome(findings, unreadable)}`);
    this.name = "DatabaseRoleScopeError";
    this.findings = findings;
    this.unreadable = unreadable;
  }
}

/** Anything that runs a parameterless query, such as a `pg` `Pool` or `PoolClient`. */
export interface RoleScopeQueryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string): Promise<{ rows: R[] }>;
}

/** The schemas of the protected range, as a condition on `pg_namespace n`. */
const PROTECTED_SCHEMA = `n.nspname not in ('pg_catalog', 'information_schema')
              and n.nspname not like 'pg\\_toast%'`;

const READ_PRIVILEGES_SQL = `
  with current_db as (
    select d.oid, d.datdba from pg_catalog.pg_database d where d.datname = pg_catalog.current_database()
  )
  select r.rolname as role_name,
         r.rolname = current_user as is_current_user,
         r.rolsuper as superuser,
         r.rolcreatedb as create_db,
         pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CREATE') as database_create,
         exists (
           select 1
             from pg_catalog.pg_namespace n
            where ${PROTECTED_SCHEMA}
              and pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE')
         ) as schema_create,
         exists (select 1 from current_db c where c.datdba = r.oid) as database_owner,
         exists (
           select 1
             from pg_catalog.pg_namespace n
            where ${PROTECTED_SCHEMA}
              and n.nspowner = r.oid
         ) as schema_owner,
         exists (
           select 1
             from pg_catalog.pg_shdepend s
             join current_db c on s.dbid = c.oid
            where s.deptype = 'o'
              and s.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
              and s.refobjid = r.oid
         ) as object_owner
    from pg_catalog.pg_roles r
   where pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
   order by r.rolname`;

interface PrivilegeRow extends QueryResultRow {
  role_name: string;
  is_current_user: boolean;
  superuser: boolean;
  create_db: boolean;
  database_create: boolean;
  schema_create: boolean;
  database_owner: boolean;
  schema_owner: boolean;
  object_owner: boolean;
}

/**
 * Reads the facts of the checked role set of the connection. It only reads catalogs. It throws
 * when the query fails or when the result does not contain `current_user` itself.
 */
export async function readRuntimeRolePrivileges(queryable: RoleScopeQueryable): Promise<RuntimeRolePrivileges> {
  const { rows } = await queryable.query<PrivilegeRow>(READ_PRIVILEGES_SQL);
  const current = rows.find(row => row.is_current_user === true);
  if (!current) {
    throw new Error("[@megaui/database] the checked role set does not contain current_user.");
  }
  return {
    currentUser: current.role_name,
    roles: rows.map(row => ({
      roleName: row.role_name,
      superuser: row.superuser === true,
      createDb: row.create_db === true,
      databaseCreate: row.database_create === true,
      schemaCreate: row.schema_create === true,
      databaseOwner: row.database_owner === true,
      schemaOwner: row.schema_owner === true,
      objectOwner: row.object_owner === true,
    })),
  };
}

/** The roles of the checked set that hit a fact, with the facts they hit. */
export function findRuntimeRoleScopeViolations(privileges: RuntimeRolePrivileges): RuntimeRoleScopeFinding[] {
  const findings: RuntimeRoleScopeFinding[] = [];
  for (const role of privileges.roles) {
    const facts: RuntimeRoleFact[] = [];
    if (role.superuser) facts.push("superuser");
    if (role.createDb) facts.push("createdb");
    if (role.databaseCreate) facts.push("database_create");
    if (role.schemaCreate) facts.push("schema_create");
    if (role.databaseOwner) facts.push("database_owner");
    if (role.schemaOwner) facts.push("schema_owner");
    if (role.objectOwner) facts.push("object_owner");
    if (facts.length > 0) findings.push({ roleName: role.roleName, facts });
  }
  return findings;
}

/** Only `NODE_ENV=production` refuses; every other environment only warns. */
export function isProductionRoleScope(nodeEnv: string | undefined): boolean {
  return nodeEnv === "production";
}

/** A plain identifier is printed as it is. */
const PLAIN_ROLE_NAME = /^[A-Za-z0-9_.$-]+$/;
/** Every character that is not printable ASCII, plus `"`, the backslash, `;` and `=`. */
const ESCAPED_IN_ROLE_NAME = /[^\x20\x21\x23-\x3a\x3c\x3e-\x5b\x5d-\x7e]/g;

/**
 * Prints a role name on one line: a plain identifier as it is, anything else in double quotes
 * with `"`, the backslash, the separators `;` and `=` and every character that is not printable
 * ASCII as a `\uXXXX` escape, so the name can contain neither a line break, `; ` nor `role=`.
 */
function formatRoleNameForOutput(roleName: string): string {
  if (PLAIN_ROLE_NAME.test(roleName)) return roleName;
  const escaped = roleName.replace(ESCAPED_IN_ROLE_NAME, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${escaped}"`;
}

function describeOutcome(findings: readonly RuntimeRoleScopeFinding[], unreadable: boolean): string {
  if (unreadable) return "facts=unreadable";
  return findings
    .map(finding => `role=${formatRoleNameForOutput(finding.roleName)} facts=${finding.facts.join(",")}`)
    .join("; ");
}

export interface AssertRuntimeRoleScopeInput {
  /** The privileges of the checked role set, or `null` when they could not be read. */
  readonly privileges: RuntimeRolePrivileges | null;
  /** The `NODE_ENV` of the process. */
  readonly nodeEnv: string | undefined;
  /** Receives the single warning line outside production (default `console.warn`). */
  readonly warn?: (line: string) => void;
}

/**
 * Decides whether the Web may start with the given privileges. In production it throws a
 * `DatabaseRoleScopeError` (`DATABASE_ROLE_SCOPE_REJECTED`) when any role of the checked set hits
 * a fact or the privileges could not be read; elsewhere it prints one
 * `DATABASE_ROLE_SCOPE_WARNING` line instead and returns. It returns the findings.
 */
export function assertRuntimeRoleScope(input: AssertRuntimeRoleScopeInput): RuntimeRoleScopeFinding[] {
  const unreadable = input.privileges === null;
  const findings = input.privileges === null ? [] : findRuntimeRoleScopeViolations(input.privileges);
  if (!unreadable && findings.length === 0) return findings;
  if (isProductionRoleScope(input.nodeEnv)) throw new DatabaseRoleScopeError(findings, unreadable);
  (input.warn ?? (line => { console.warn(line); }))(`${DATABASE_ROLE_SCOPE_WARNING}: ${describeOutcome(findings, unreadable)}`);
  return findings;
}

/**
 * Reads the privileges of the connection and applies `assertRuntimeRoleScope`. A failed read
 * counts as `unreadable`; the driver error is dropped, because it may name the target.
 */
export async function checkRuntimeRoleScope(
  queryable: RoleScopeQueryable,
  options: Omit<AssertRuntimeRoleScopeInput, "privileges">,
): Promise<RuntimeRoleScopeFinding[]> {
  let privileges: RuntimeRolePrivileges | null;
  try {
    privileges = await readRuntimeRolePrivileges(queryable);
  } catch {
    privileges = null;
  }
  return assertRuntimeRoleScope({ ...options, privileges });
}
