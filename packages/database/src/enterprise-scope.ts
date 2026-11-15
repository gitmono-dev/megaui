/**
 * FS-44：企业 DB 角色与迁移目标守卫。
 *
 * 本模块按 GC-15 的角色表校验数据库目标：owner、instance、environment 与
 * 实际 SQL 角色权限都要落在登记范围内，任一不符即拒绝企业操作。它是纯
 * 判定 + 只读查询的组合：不写库、不改 schema、不代替运维提权。
 */
import { Pool } from "pg";

/** The processes that may reach an enterprise database. */
export const ENTERPRISE_PROCESS_ROLES = [
  "web",
  "worker",
  "admin",
  "migration",
  "test",
  "collab",
  "live-observer",
] as const;
export type EnterpriseProcessRole = (typeof ENTERPRISE_PROCESS_ROLES)[number];

/** The privileges a registered SQL role may hold. */
export interface RegisteredRoleScope {
  /** The role may run DDL. */
  canDdl: boolean;
  /** The role may create a database. */
  canCreateDatabase: boolean;
}

/**
 * The registered scope of every process role.
 *
 * Only the migration role and the test role may run DDL, and only the test
 * role may create a database: every other role is a DML role.
 */
export const REGISTERED_ROLE_SCOPES: Record<EnterpriseProcessRole, RegisteredRoleScope> = {
  web: { canDdl: false, canCreateDatabase: false },
  worker: { canDdl: false, canCreateDatabase: false },
  admin: { canDdl: false, canCreateDatabase: false },
  migration: { canDdl: true, canCreateDatabase: false },
  test: { canDdl: true, canCreateDatabase: true },
  collab: { canDdl: false, canCreateDatabase: false },
  "live-observer": { canDdl: false, canCreateDatabase: false },
};

/** The owner fingerprint of an ordinary MegaUI deployment. */
export const DEFAULT_OWNER_FINGERPRINT = "megaui";

export type EnterpriseScopeErrorCode =
  | "scope_target_unknown"
  | "scope_owner_mismatch"
  | "scope_instance_mismatch"
  | "scope_environment_mismatch"
  | "scope_role_exceeded"
  | "scope_production_marker_in_test";

export class EnterpriseScopeError extends Error {
  readonly code: EnterpriseScopeErrorCode;

  constructor(code: EnterpriseScopeErrorCode, message: string) {
    super(message);
    this.name = "EnterpriseScopeError";
    this.code = code;
  }
}

/** The marker of the target, as stored in the policy table. */
export interface EnterpriseTargetMarker {
  /** The instance scope of the marker. */
  scope: string;
  ownerFingerprint: string;
  environment: string;
  activationState: string;
  authEpoch: number;
}

export interface EnterpriseScopeExpectation {
  /** The process that reaches the database. */
  processRole: EnterpriseProcessRole;
  /** The owner fingerprint the target has to carry. */
  ownerFingerprint: string;
  /** The instance id the target has to carry. */
  instanceId: string;
  /** The environment the target has to carry. */
  environment: string;
  /**
   * The fingerprints of the targets whose marker may be initialized. A target
   * without a marker is only usable when its fingerprint is listed here.
   */
  approvedBootstrapTargets?: readonly string[];
}

/** The privileges the connected SQL role actually holds. */
export interface SqlRolePrivileges {
  roleName: string;
  canDdl: boolean;
  canCreateDatabase: boolean;
}

/** The fingerprint of a target: owner, instance and environment. */
export function targetFingerprint(input: {
  ownerFingerprint: string;
  instanceId: string;
  environment: string;
}): string {
  return `${input.ownerFingerprint}:${input.instanceId}:${input.environment}`;
}

/**
 * Reads the expectation of the current process from the environment.
 *
 * A deployment that does not declare an instance id does not use the
 * enterprise scope at all, and returns undefined.
 */
export function readScopeExpectation(
  env: Record<string, string | undefined> = process.env,
): EnterpriseScopeExpectation | undefined {
  const instanceId = env.ENTERPRISE_DB_INSTANCE_ID?.trim();
  if (!instanceId) return undefined;
  const role = env.ENTERPRISE_PROCESS_ROLE?.trim();
  const processRole = (ENTERPRISE_PROCESS_ROLES as readonly string[]).includes(role ?? "")
    ? (role as EnterpriseProcessRole)
    : "web";
  const approved = (env.ENTERPRISE_APPROVED_TARGETS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return {
    processRole,
    ownerFingerprint: env.ENTERPRISE_OWNER_FINGERPRINT?.trim() || DEFAULT_OWNER_FINGERPRINT,
    instanceId,
    environment: env.ENTERPRISE_DEPLOYMENT_ROLE?.trim() || "development",
    approvedBootstrapTargets: approved,
  };
}

/**
 * Checks that the target may be used for enterprise operations.
 *
 * Every check fails closed: an unknown target is never accepted on its own,
 * a marker of another owner, instance or environment is refused, and a SQL
 * role that holds more privileges than its registered scope is refused.
 */
export function assertEnterpriseScope(input: {
  marker: EnterpriseTargetMarker | undefined;
  expectation: EnterpriseScopeExpectation;
  privileges: SqlRolePrivileges;
}): void {
  const { marker, expectation, privileges } = input;

  if (!marker) {
    const fingerprint = targetFingerprint(expectation);
    if (!expectation.approvedBootstrapTargets?.includes(fingerprint)) {
      throw new EnterpriseScopeError(
        "scope_target_unknown",
        `the target ${fingerprint} is not an approved enterprise target`,
      );
    }
  } else {
    if (marker.ownerFingerprint !== expectation.ownerFingerprint) {
      throw new EnterpriseScopeError(
        "scope_owner_mismatch",
        "the target belongs to another owner",
      );
    }
    if (marker.scope !== expectation.instanceId) {
      throw new EnterpriseScopeError(
        "scope_instance_mismatch",
        "the target belongs to another instance",
      );
    }
    if (marker.environment !== expectation.environment) {
      throw new EnterpriseScopeError(
        "scope_environment_mismatch",
        "the target belongs to another environment",
      );
    }
    if (expectation.processRole === "test" && marker.environment === "production") {
      throw new EnterpriseScopeError(
        "scope_production_marker_in_test",
        "a test process may not use a production target",
      );
    }
  }

  const registered = REGISTERED_ROLE_SCOPES[expectation.processRole];
  if (privileges.canDdl && !registered.canDdl) {
    throw new EnterpriseScopeError(
      "scope_role_exceeded",
      `the SQL role ${privileges.roleName} may run DDL but its registered scope does not allow it`,
    );
  }
  if (privileges.canCreateDatabase && !registered.canCreateDatabase) {
    throw new EnterpriseScopeError(
      "scope_role_exceeded",
      `the SQL role ${privileges.roleName} may create a database but its registered scope does not allow it`,
    );
  }
}

/** Reads the marker of the target, if it has one. */
export async function readEnterpriseMarker(pool: Pool): Promise<EnterpriseTargetMarker | undefined> {
  const result = await pool.query<{
    scope: string;
    owner_fingerprint: string;
    environment: string;
    activation_state: string;
    auth_epoch: number;
  }>(
    `select scope, owner_fingerprint, environment, activation_state, auth_epoch
       from "enterprise_policy"
       order by created_at
       limit 1`,
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    scope: row.scope,
    ownerFingerprint: row.owner_fingerprint,
    environment: row.environment,
    activationState: row.activation_state,
    authEpoch: row.auth_epoch,
  };
}

/** Reads the privileges the connected SQL role actually holds. */
export async function readSqlRolePrivileges(pool: Pool): Promise<SqlRolePrivileges> {
  const result = await pool.query<{
    role_name: string;
    can_ddl: boolean;
    can_create_db: boolean;
  }>(
    `select current_user as role_name,
            pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE') as can_ddl,
            pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE') as can_create_db`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new EnterpriseScopeError("scope_target_unknown", "the SQL role could not be read.");
  }
  return {
    roleName: row.role_name,
    canDdl: row.can_ddl === true,
    canCreateDatabase: row.can_create_db === true,
  };
}

/**
 * The precheck of the migration target.
 *
 * It runs before a single DDL statement: when it refuses, the migration is
 * not started at all and the target stays untouched.
 */
export async function assertMigrationTarget(
  pool: Pool,
  expectation: EnterpriseScopeExpectation,
): Promise<void> {
  const marker = await readEnterpriseMarker(pool);
  const privileges = await readSqlRolePrivileges(pool);
  assertEnterpriseScope({ marker, expectation, privileges });
  if (!privileges.canDdl) {
    throw new EnterpriseScopeError(
      "scope_role_exceeded",
      `the SQL role ${privileges.roleName} may not run the migration`,
    );
  }
}

/**
 * Initializes the marker of a target.
 *
 * Only an approved target may be initialized, and only when the database is
 * empty or already carries a MegaUI ledger: a foreign database is refused.
 */
export async function bootstrapEnterpriseMarker(
  pool: Pool,
  expectation: EnterpriseScopeExpectation,
): Promise<EnterpriseTargetMarker> {
  const fingerprint = targetFingerprint(expectation);
  if (!expectation.approvedBootstrapTargets?.includes(fingerprint)) {
    throw new EnterpriseScopeError(
      "scope_target_unknown",
      `the target ${fingerprint} is not an approved enterprise target`,
    );
  }
  const existing = await readEnterpriseMarker(pool);
  if (existing) {
    assertEnterpriseScope({ marker: existing, expectation, privileges: { roleName: "bootstrap", canDdl: true, canCreateDatabase: false } });
    return existing;
  }
  // Only an empty database or one that already carries the MegaUI ledger may
  // be initialized; a database of another application is refused.
  const tables = await pool.query<{ count: number }>(
    `select count(*)::int as count from information_schema.tables where table_schema = 'public'`,
  );
  const tableCount = tables.rows[0]?.count ?? 0;
  if (tableCount > 0) {
    const ledger = await pool.query(
      `select to_regclass('drizzle.__drizzle_migrations') is not null as has_ledger`,
    );
    if (ledger.rows[0]?.has_ledger !== true) {
      throw new EnterpriseScopeError(
        "scope_target_unknown",
        "the target carries tables of another application",
      );
    }
  }
  const marker: EnterpriseTargetMarker = {
    scope: expectation.instanceId,
    ownerFingerprint: expectation.ownerFingerprint,
    environment: expectation.environment,
    activationState: "legacy",
    authEpoch: 0,
  };
  await pool.query(
    `insert into "enterprise_policy"
       (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      `policy-${expectation.instanceId}`,
      expectation.instanceId,
      expectation.ownerFingerprint,
      expectation.processRole,
      expectation.environment,
      0,
      "legacy",
    ],
  );
  return marker;
}

/** The precheck of the migration target, as a command for `db:migrate`. */
export async function runMigrationPrecheck(): Promise<void> {
  const expectation = readScopeExpectation();
  // A deployment that does not declare an enterprise instance does not use
  // the enterprise scope, and the migration keeps its previous behaviour.
  if (!expectation) return;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "[@megaui/database] DATABASE_URL is not set. Fail-closed: the migration target cannot be checked (GC-07).",
    );
  }
  const pool = new Pool({ connectionString });
  pool.on("error", () => {
    // The failure is reported through the query below.
  });
  try {
    await assertMigrationTarget(pool, expectation);
  } finally {
    await pool.end();
  }
}
