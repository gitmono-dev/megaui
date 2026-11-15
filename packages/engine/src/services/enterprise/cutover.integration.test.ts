// FS-27: sticky activation on an isolated PostgreSQL target.
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import type { EnterpriseScopeExpectation } from "@megaui/database";
import type { GuardedWriteContext } from "../../cli/admin-approval";
import { runActorReservationMutation } from "./actor-reservations";
import { compatibilityEmail } from "./identity-key";
import { migrationUserVersion } from "./manifest";
import { previewMigration } from "./migration-preview";
import { createMigrationLedger } from "./migration-ledger";
import { runConversionMutation } from "./conversion";
import { runActivationMutation } from "./cutover";

const SCOPE = "fs27-instance";
const TENANT = "fs27-tenant";
const APP = "fs27-app";
const EXPECTATION: EnterpriseScopeExpectation = {
  processRole: "test", ownerFingerprint: "megaui", instanceId: SCOPE, environment: "test",
};
const previousEnv = { ...process.env };

describe("sticky activation (FS-27)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  let manifest: Buffer;
  let digest: string;

  function context(verb: "apply" | "convert" | "activate", batch?: number): GuardedWriteContext {
    const operationId = randomUUID();
    return {
      verb,
      operationId,
      args: {
        target: SCOPE,
        "operation-id": operationId,
        "expect-policy-epoch": 3,
        digest,
        ...(batch === undefined ? {} : { "batch-number": batch }),
      },
      files: {
        names: () => ["manifest"],
        bytes: (name) => name === "manifest" ? manifest : undefined,
      },
    };
  }

  async function reservation(): Promise<void> {
    const snapshot = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      observedAt: new Date(Date.now() - 60_000).toISOString(),
      actors: [{ actor: "Actor 1", owners: ["legacy-001"] }, { actor: "Actor 2", owners: ["legacy-002"] }],
    }));
    const client = await pool.connect();
    try {
      await client.query("begin");
      await runActorReservationMutation({
        verb: "reserve-actors",
        operationId: randomUUID(),
        args: { target: SCOPE, digest: createHash("sha256").update(snapshot).digest("hex") },
        files: { names: () => ["upstream"], bytes: () => snapshot },
      }, client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  function applyEnvironment(overrides: Record<string, string> = {}): void {
    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: isolated.databaseUrl,
      ENTERPRISE_DB_INSTANCE_ID: SCOPE,
      ENTERPRISE_PROCESS_ROLE: "test",
      ENTERPRISE_DEPLOYMENT_ROLE: "test",
      ENTERPRISE_OWNER_FINGERPRINT: "megaui",
      FEISHU_TENANT_KEY: TENANT,
      FEISHU_APP_ID: APP,
      FEISHU_DIRECTORY_DEPARTMENT_IDS: JSON.stringify(["dept-fs27"]),
      ENTERPRISE_WORKER_READY: "1",
      ENTERPRISE_COLLAB_POLICY_EPOCHS: "3,3",
      ...overrides,
    });
  }

  async function seed(): Promise<void> {
    await pool.query(
      'delete from enterprise_directory_identity_watermarks; delete from enterprise_directory_snapshots; ' +
        'delete from enterprise_directory_watermarks; delete from enterprise_batch_checkpoints; ' +
        'delete from enterprise_admin_operations; delete from enterprise_actor_inventory; ' +
        'delete from enterprise_actor_reservations; delete from enterprise_quarantine; ' +
        'delete from "session"; delete from enterprise_identity; delete from enterprise_profile; ' +
        'delete from "user"; delete from enterprise_policy',
    );
    await pool.query(
      "insert into enterprise_policy(id,scope,owner_fingerprint,deployment_role,environment,auth_epoch,activation_state) " +
        "values ('policy',$1,'megaui','test','test',3,'maintenance')", [SCOPE],
    );
    await pool.query(
      'insert into "user"(id,name,email,email_verified,updated_at) values ' +
        "('legacy-001','Actor 1','old-1@example.test',true,'2026-11-11T01:02:03.123456Z')," +
        "('legacy-002','Actor 2','old-2@example.test',true,'2026-11-11T01:02:03.123456Z')",
    );
    await reservation();

    const rows = (await pool.query(
      'select id,name,email,email_verified as "emailVerified",banned,' +
        'to_char(updated_at at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z\') as "updatedAt" ' +
        'from "user" order by id',
    )).rows;
    manifest = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      members: rows.map((row) => ({
        local_user_id: row.id,
        tenant_key: TENANT,
        app_id: APP,
        open_id: `open-${row.id}`,
        login_name: `alias-${row.id}`,
        expected_user_version: migrationUserVersion(row),
        expected_identity_version: 0,
      })),
    }));
    const report = await previewMigration({
      bytes: manifest,
      databaseUrl: isolated.databaseUrl,
      expectation: EXPECTATION,
      authority: { tenantKey: TENANT, appId: APP },
      deadline: performance.now() + 30_000,
    });
    expect(report.status).toBe("ready");
    digest = report.manifestDigest!;

    const scopeHash = createHash("sha256").update(`${TENANT}\u0000${APP}\u0000dept-fs27`).digest("hex");
    const observedAt = new Date(Date.now() - 60_000);
    await pool.query("insert into enterprise_directory_watermarks(id,scope_hash,generation) values ('wm',$1,1)", [scopeHash]);
    await pool.query(
      "insert into enterprise_directory_snapshots(id,scope_hash,generation,complete,member_count,observed_at,completed_at) " +
        "values ('snapshot',$1,1,true,2,$2,$2)", [scopeHash, observedAt],
    );
    applyEnvironment();
  }

  async function phase(verb: "apply" | "convert", batch = 0): Promise<void> {
    const client = await pool.connect();
    const current = context(verb, batch);
    const ledger = createMigrationLedger({ expectation: EXPECTATION, authority: { tenantKey: TENANT, appId: APP } });
    try {
      await client.query("begin");
      if (verb === "apply") {
        await ledger.executeBatch(current, client, async (transaction, members) => {
          for (const member of members) {
            await transaction.query(
              "insert into enterprise_identity(id,local_user_id,tenant_key,app_id,open_id,status,identity_version) " +
                "values ($1,$2,$3,$4,$5,'active',1)",
              [randomUUID(), member.local_user_id, TENANT, APP, member.open_id],
            );
            await transaction.query(
              "insert into enterprise_profile(user_id,tenant_key,login_name,backend_username,display_name) " +
                "values ($1,$2,$3,$4,$5)",
              [member.local_user_id, TENANT, member.login_name, member.backend_username, `Display ${member.local_user_id}`],
            );
          }
        });
      } else {
        await runConversionMutation(current, client);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async function activate(): Promise<unknown> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await runActivationMutation(context("activate"), client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      return error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
  }, 120_000);

  beforeEach(async () => {
    await seed();
  });

  it("preview-apply-convert-activate requires converted batches, then atomically activates and revokes every session", async () => {
    await phase("apply");
    await pool.query(
      'insert into "session"(id,expires_at,token,user_id) values ' +
        "('legacy-session',now()+interval '1 day','legacy-token','legacy-001')," +
        "('enterprise-session',now()+interval '1 day','enterprise-token','legacy-002')",
    );
    expect(await activate()).toMatchObject({ name: "ApprovedMutationRejection", key: "MIGRATION_REJECTED" });
    await phase("convert");
    expect(await activate()).toEqual({ activated: 1, sessionsRevoked: 2 });
    expect((await pool.query("select activation_state,auth_epoch,activated_at from enterprise_policy where scope=$1", [SCOPE])).rows[0])
      .toMatchObject({ activation_state: "enterprise", auth_epoch: 4 });
    expect((await pool.query('select count(*)::int as count from "session"')).rows[0].count).toBe(0);
    expect((await pool.query('select email,email_verified from "user" where id=\'legacy-001\'')).rows[0])
      .toEqual({ email: compatibilityEmail("legacy-001"), email_verified: false });
  }, 60_000);

  it("rejects production and canary targets before any policy or session write", async () => {
    await pool.query(
      'insert into "session"(id,expires_at,token,user_id) values (\'session-before-reject\',now()+interval \'1 day\',\'token-before-reject\',\'legacy-001\')',
    );
    const before = (await pool.query("select activation_state,auth_epoch,activated_at from enterprise_policy where scope=$1", [SCOPE])).rows[0];
    for (const role of ["production", "canary"]) {
      applyEnvironment({ ENTERPRISE_DEPLOYMENT_ROLE: role });
      expect(await activate()).toMatchObject({ name: "ApprovedMutationRejection", key: "INVALID_CONFIG" });
    }
    expect((await pool.query("select activation_state,auth_epoch,activated_at from enterprise_policy where scope=$1", [SCOPE])).rows[0]).toEqual(before);
    expect((await pool.query('select count(*)::int as count from "session"')).rows[0].count).toBe(1);
  }, 60_000);

  it("external-version-drift rejects stale readiness and poststate drift without changing the marker", async () => {
    await phase("apply");
    await phase("convert");
    const before = (await pool.query("select activation_state,auth_epoch,activated_at from enterprise_policy where scope=$1", [SCOPE])).rows[0];
    await pool.query("update enterprise_directory_snapshots set observed_at=now()-interval '16 minutes'");
    expect(await activate()).toMatchObject({ name: "ApprovedMutationRejection", key: "MIGRATION_REJECTED" });
    await pool.query("update enterprise_directory_snapshots set observed_at=now()-interval '1 minute'");
    await pool.query("update \"user\" set name='Actor 1 drift' where id='legacy-001'");
    expect(await activate()).toMatchObject({ name: "ApprovedMutationRejection", key: "MIGRATION_REJECTED" });
    expect((await pool.query("select activation_state,auth_epoch,activated_at from enterprise_policy where scope=$1", [SCOPE])).rows[0]).toEqual(before);
  }, 60_000);

  afterAll(async () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    await pool?.end();
    await isolated?.destroy();
  }, 120_000);
});
