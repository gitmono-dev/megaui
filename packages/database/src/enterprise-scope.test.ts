// FS-44：企业 DB 角色与迁移目标守卫。
//
// The suite proves the guard of GC-15: a target of another owner, instance
// or environment is refused, a SQL role that holds more privileges than its
// registered scope is refused, an unknown target is never initialized on its
// own, and a refused migration target stays without a single DDL.
//
// It needs a docker daemon: without one the run fails instead of passing
// quietly.
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_OWNER_FINGERPRINT,
  EnterpriseScopeError,
  REGISTERED_ROLE_SCOPES,
  assertEnterpriseScope,
  assertMigrationTarget,
  bootstrapEnterpriseMarker,
  readEnterpriseMarker,
  readScopeExpectation,
  readSqlRolePrivileges,
  targetFingerprint,
  type EnterpriseScopeExpectation,
  type EnterpriseTargetMarker,
} from "./enterprise-scope";
import { createEnterpriseDatabaseClient } from "./client";
import { createIsolatedPostgres, isDockerAvailable } from "./test-support/isolated-pg";

const dockerAvailable = await isDockerAvailable();

if (!dockerAvailable) {
  throw new Error(
    "[@megaui/database] enterprise-scope.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

const MARKER: EnterpriseTargetMarker = {
  scope: "instance-1",
  ownerFingerprint: DEFAULT_OWNER_FINGERPRINT,
  environment: "development",
  activationState: "legacy",
  authEpoch: 0,
};

const EXPECTATION: EnterpriseScopeExpectation = {
  processRole: "web",
  ownerFingerprint: DEFAULT_OWNER_FINGERPRINT,
  instanceId: "instance-1",
  environment: "development",
  approvedBootstrapTargets: [targetFingerprint({
    ownerFingerprint: DEFAULT_OWNER_FINGERPRINT,
    instanceId: "instance-1",
    environment: "development",
  })],
};

const DML_PRIVILEGES = { roleName: "megaui_web", canDdl: false, canCreateDatabase: false };

describe("enterprise database scope guard (FS-44)", () => {
  it("refuses an initialized target of another owner", () => {
    expect(() =>
      assertEnterpriseScope({
        marker: MARKER,
        expectation: { ...EXPECTATION, ownerFingerprint: "another-owner" },
        privileges: DML_PRIVILEGES,
      }),
    ).toThrow(EnterpriseScopeError);
    try {
      assertEnterpriseScope({
        marker: MARKER,
        expectation: { ...EXPECTATION, ownerFingerprint: "another-owner" },
        privileges: DML_PRIVILEGES,
      });
    } catch (error) {
      expect((error as EnterpriseScopeError).code).toBe("scope_owner_mismatch");
    }
  });

  it("refuses a target of another instance", () => {
    try {
      assertEnterpriseScope({
        marker: MARKER,
        expectation: { ...EXPECTATION, instanceId: "instance-2" },
        privileges: DML_PRIVILEGES,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as EnterpriseScopeError).code).toBe("scope_instance_mismatch");
    }
  });

  it("refuses a target of another environment", () => {
    try {
      assertEnterpriseScope({
        marker: MARKER,
        expectation: { ...EXPECTATION, environment: "production" },
        privileges: DML_PRIVILEGES,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as EnterpriseScopeError).code).toBe("scope_environment_mismatch");
    }
  });

  it("refuses a SQL role whose privileges exceed the registered scope", () => {
    expect(REGISTERED_ROLE_SCOPES.web.canDdl).toBe(false);
    expect(REGISTERED_ROLE_SCOPES.worker.canDdl).toBe(false);
    expect(REGISTERED_ROLE_SCOPES.admin.canDdl).toBe(false);
    expect(REGISTERED_ROLE_SCOPES.migration.canDdl).toBe(true);

    for (const privileges of [
      { roleName: "megaui_web", canDdl: true, canCreateDatabase: false },
      { roleName: "megaui_web", canDdl: false, canCreateDatabase: true },
    ]) {
      try {
        assertEnterpriseScope({
          marker: MARKER,
          expectation: EXPECTATION,
          privileges,
        });
        expect.unreachable();
      } catch (error) {
        expect((error as EnterpriseScopeError).code).toBe("scope_role_exceeded");
      }
    }

    // The registered scope of the role itself is accepted.
    expect(() =>
      assertEnterpriseScope({
        marker: MARKER,
        expectation: { ...EXPECTATION, processRole: "migration" },
        privileges: { roleName: "megaui_ddl", canDdl: true, canCreateDatabase: false },
      }),
    ).not.toThrow();
  });

  it("refuses a production marker for a test process", () => {
    try {
      assertEnterpriseScope({
        marker: { ...MARKER, environment: "production" },
        expectation: { ...EXPECTATION, processRole: "test", environment: "production" },
        privileges: { roleName: "megaui_test", canDdl: true, canCreateDatabase: true },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as EnterpriseScopeError).code).toBe("scope_production_marker_in_test");
    }
  });

  it("never initializes the marker of an unknown target", () => {
    try {
      assertEnterpriseScope({
        marker: undefined,
        expectation: { ...EXPECTATION, approvedBootstrapTargets: [] },
        privileges: DML_PRIVILEGES,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as EnterpriseScopeError).code).toBe("scope_target_unknown");
    }

    // An approved target may be initialized, and only that one.
    expect(() =>
      assertEnterpriseScope({
        marker: undefined,
        expectation: EXPECTATION,
        privileges: DML_PRIVILEGES,
      }),
    ).not.toThrow();
  });

  it("reads the expectation of the current process from the environment", () => {
    expect(readScopeExpectation({})).toBeUndefined();
    const expectation = readScopeExpectation({
      ENTERPRISE_DB_INSTANCE_ID: "instance-9",
      ENTERPRISE_PROCESS_ROLE: "worker",
      ENTERPRISE_DEPLOYMENT_ROLE: "test",
      ENTERPRISE_APPROVED_TARGETS: "a:b:c, d:e:f",
    });
    expect(expectation?.processRole).toBe("worker");
    expect(expectation?.instanceId).toBe("instance-9");
    expect(expectation?.environment).toBe("test");
    expect(expectation?.ownerFingerprint).toBe(DEFAULT_OWNER_FINGERPRINT);
    expect(expectation?.approvedBootstrapTargets).toEqual(["a:b:c", "d:e:f"]);
    // An unknown process role falls back to the least privileged one.
    expect(readScopeExpectation({ ENTERPRISE_DB_INSTANCE_ID: "i" })?.processRole).toBe("web");
  });

  describe("against a real database", () => {
    let isolated: Awaited<ReturnType<typeof createIsolatedPostgres>>;
    let pool: Pool;

    beforeAll(async () => {
      isolated = await createIsolatedPostgres();
      await isolated.migrate();
      pool = new Pool({ connectionString: isolated.databaseUrl });
      pool.on("error", () => {});
    }, 120_000);

    afterAll(async () => {
      if (pool) await pool.end();
      if (isolated) await isolated.destroy();
    }, 120_000);

    it("reads the marker and the privileges of the connected role", async () => {
      expect(await readEnterpriseMarker(pool)).toBeUndefined();
      const privileges = await readSqlRolePrivileges(pool);
      expect(privileges.roleName.length).toBeGreaterThan(0);
      expect(typeof privileges.canDdl).toBe("boolean");
    });

    it("initializes the marker only for an approved target", async () => {
      const approved = {
        ...EXPECTATION,
        instanceId: "instance-bootstrap",
        approvedBootstrapTargets: [
          targetFingerprint({
            ownerFingerprint: DEFAULT_OWNER_FINGERPRINT,
            instanceId: "instance-bootstrap",
            environment: "development",
          }),
        ],
      };
      const marker = await bootstrapEnterpriseMarker(pool, approved);
      expect(marker.scope).toBe("instance-bootstrap");
      expect(marker.ownerFingerprint).toBe(DEFAULT_OWNER_FINGERPRINT);

      await expect(
        bootstrapEnterpriseMarker(pool, { ...approved, approvedBootstrapTargets: [] }),
      ).rejects.toThrow(/not an approved enterprise target/);
    });

    it("runs the migration precheck without a single DDL when it refuses", async () => {
      const before = await pool.query<{ count: number }>(
        `select count(*)::int as count from information_schema.tables where table_schema = 'public'`,
      );
      const wrong = { ...EXPECTATION, instanceId: "another-instance" };
      await expect(assertMigrationTarget(pool, wrong)).rejects.toThrow(EnterpriseScopeError);
      const after = await pool.query<{ count: number }>(
        `select count(*)::int as count from information_schema.tables where table_schema = 'public'`,
      );
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    });

    it("runs the scope guard before the enterprise client is returned", async () => {
      await expect(
        createEnterpriseDatabaseClient({
          connectionString: isolated.databaseUrl,
          scope: { ...EXPECTATION, instanceId: "another-instance" },
        }),
      ).rejects.toThrow(EnterpriseScopeError);

      // A role with DML only is the registered scope of the web process.
      await pool.query(`drop role if exists megaui_web`);
      await pool.query(`create role megaui_web login password 'megaui'`);
      await pool.query(
        `grant connect on database "${isolated.databaseName}" to megaui_web`,
      );
      await pool.query(`grant usage on schema public to megaui_web`);
      await pool.query(
        `grant select, insert, update, delete on all tables in schema public to megaui_web`,
      );
      const dmlConnection = new URL(isolated.databaseUrl);
      dmlConnection.username = "megaui_web";
      dmlConnection.password = "megaui";
      const dmlUrl = dmlConnection.toString();

      // The expectation follows the marker the database actually carries.
      const marker = await readEnterpriseMarker(pool);
      const scope = marker ? { ...EXPECTATION, instanceId: marker.scope } : EXPECTATION;

      const client = await createEnterpriseDatabaseClient({
        connectionString: dmlUrl,
        scope,
      });
      try {
        const result = await client.pool.query("select 1 as one");
        expect(result.rows[0]?.one).toBe(1);
      } finally {
        await client.close();
      }
    });
  });
});
