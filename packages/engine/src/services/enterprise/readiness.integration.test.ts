// FS-52: actual read-only ready-check, complete synthetic migration inventory,
// directory freshness and CLI output contract.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { readScopeExpectation, type EnterpriseScopeExpectation } from "@megaui/database";
import { actorInventoryDigests, readActorInventoryState } from "./actor-reservations";
import { readMigrationUserSources } from "./migration-preview";
import { migrationUserVersion } from "./manifest";
import { scopeHashOf } from "./feishu/directory";
import { runReadinessCheck, type ReadinessOptions } from "./readiness";

const SCOPE = "fs52-instance";
const TENANT = "fs52-tenant";
const APP = "fs52-app";
const DEPARTMENTS = ["dept-a", "dept-b"];
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const CLI = fileURLToPath(new URL("../../cli/enterprise-admin.ts", import.meta.url));

describe("enterprise ready-check (FS-52)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  let directory: string;
  let expectation: EnterpriseScopeExpectation;
  let manifestBytes: Uint8Array;
  let manifestDigest: string;
  let baseOptions: ReadinessOptions;

  async function snapshot(): Promise<Record<string, unknown>> {
    const tables = [
      "enterprise_policy",
      "enterprise_admin_operations",
      "enterprise_actor_inventory",
      "enterprise_actor_reservations",
      "enterprise_quarantine",
      "enterprise_directory_watermarks",
      "enterprise_directory_snapshots",
    ];
    const result: Record<string, unknown> = {};
    for (const table of tables) {
      result[table] = (await pool.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as data from "${table}" t`)).rows[0].data;
    }
    return result;
  }

  async function seed() {
    await pool.query(
      "delete from enterprise_directory_identity_watermarks; delete from enterprise_directory_snapshots; " +
      "delete from enterprise_directory_watermarks; delete from enterprise_actor_inventory; " +
      "delete from enterprise_actor_reservations; delete from enterprise_batch_checkpoints; " +
      "delete from enterprise_admin_operations; delete from enterprise_quarantine; " +
      "delete from enterprise_identity; delete from enterprise_profile; delete from \"user\"; delete from enterprise_policy",
    );
    await pool.query(
      "insert into enterprise_policy(id,scope,owner_fingerprint,deployment_role,environment,auth_epoch,activation_state) " +
      "values ('policy',$1,'megaui','test','test',3,'maintenance')",
      [SCOPE],
    );
    await pool.query(
      "insert into \"user\"(id,name,email,email_verified,updated_at) values ('user-1','Ada','ada@example.test',false,'2026-11-11T01:02:03.123456Z')",
    );
    await pool.query(
      "insert into enterprise_identity(id,local_user_id,tenant_key,app_id,open_id,identity_version,status) " +
      "values ('identity-1','user-1',$1,$2,'open-1',1,'active')",
      [TENANT, APP],
    );
    await pool.query(
      "insert into enterprise_profile(user_id,tenant_key,login_name,backend_username,display_name,notification_email) " +
      "values ('user-1',$1,'alice','Ada','Ada','notify@example.test')",
      [TENANT],
    );

    const observedAt = new Date(Date.now() - 60_000);
    const sourceDigest = "a".repeat(64);
    const upstream = [{ actor: "Ada", owners: ["user-1"] }];
    await pool.query(
      "insert into enterprise_actor_reservations(id,backend_username,actor_state,local_user_id,quarantined,source_snapshot_digest,source_observed_at) " +
      "values ($1,'Ada','reserved','user-1',false,$2,$3)",
      [randomUUID(), sourceDigest, observedAt],
    );
    const client = await pool.connect();
    try {
      const state = await readActorInventoryState(client, SCOPE);
      const digests = actorInventoryDigests(state.subjects, upstream, state.rows);
      await pool.query(
        "insert into enterprise_actor_inventory(scope,operation_id,source_digest,subjects_digest,ownership_digest,observed_at,upstream_actors) " +
        "values ($1,$2,$3,$4,$5,$6,$7::jsonb)",
        [SCOPE, randomUUID(), sourceDigest, digests.subjectsDigest, digests.ownershipDigest, observedAt, JSON.stringify(upstream)],
      );
    } finally {
      client.release();
    }

    const directoryScopeHash = scopeHashOf({ tenantKey: TENANT, appId: APP, departmentIds: DEPARTMENTS });
    await pool.query(
      "insert into enterprise_directory_watermarks(id,scope_hash,generation) values ('watermark',$1,1)",
      [directoryScopeHash],
    );
    await pool.query(
      "insert into enterprise_directory_snapshots(id,scope_hash,generation,complete,member_count,observed_at,completed_at) " +
      "values ('snapshot',$1,1,true,1,$2,$2)",
      [directoryScopeHash, observedAt],
    );

    const sourceClient = await pool.connect();
    try {
      const [user] = await readMigrationUserSources(sourceClient, ["user-1"]);
      const expectedUserVersion = migrationUserVersion(user!);
      const manifest = {
        schemaVersion: 1,
        members: [{
          local_user_id: "user-1",
          tenant_key: TENANT,
          app_id: APP,
          open_id: "open-1",
          login_name: "alice",
          expected_user_version: expectedUserVersion,
          expected_identity_version: 1,
        }],
      };
      manifestBytes = Buffer.from(JSON.stringify(manifest));
      manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
    } finally {
      sourceClient.release();
    }
    baseOptions = {
      bytes: manifestBytes,
      databaseUrl: isolated.databaseUrl,
      expectation,
      authority: { tenantKey: TENANT, appId: APP },
      directoryScopeHash,
      workerReady: true,
      collabPolicyEpochs: [3, 3],
    };
  }

  function runCli(outputPath: string, env: Record<string, string | undefined> = {}, digest = manifestDigest) {
    const manifestPath = join(directory, "manifest.json");
    writeFileSync(manifestPath, manifestBytes);
    return spawnSync(process.execPath, ["--import", "tsx", CLI, "ready-check", "--target", SCOPE,
      "--manifest", manifestPath, "--digest", digest, "--out", outputPath], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 35_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "test",
        DATABASE_URL: isolated.databaseUrl,
        ENTERPRISE_DB_INSTANCE_ID: SCOPE,
        ENTERPRISE_PROCESS_ROLE: "test",
        ENTERPRISE_OWNER_FINGERPRINT: "megaui",
        ENTERPRISE_DEPLOYMENT_ROLE: "test",
        FEISHU_TENANT_KEY: TENANT,
        FEISHU_APP_ID: APP,
        FEISHU_DIRECTORY_DEPARTMENT_IDS: JSON.stringify(DEPARTMENTS),
        ENTERPRISE_WORKER_READY: "1",
        ENTERPRISE_COLLAB_POLICY_EPOCHS: "3,3",
        ...env,
      },
    });
  }

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    directory = realpathSync(mkdtempSync(join(tmpdir(), "megaui-fs52-")));
    expectation = readScopeExpectation({
      ENTERPRISE_DB_INSTANCE_ID: SCOPE,
      ENTERPRISE_PROCESS_ROLE: "test",
      ENTERPRISE_OWNER_FINGERPRINT: "megaui",
      ENTERPRISE_DEPLOYMENT_ROLE: "test",
    })!;
  }, 120_000);

  beforeEach(async () => {
    await seed();
  });

  afterAll(async () => {
    await pool?.end();
    await isolated?.destroy();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("passes the complete contract, writes a redacted 0600 report, and proves read-only SQL", async () => {
    const before = await snapshot();
    const trace: string[] = [];
    const report = await runReadinessCheck({ ...baseOptions, onQuery: (sql) => trace.push(sql) });
    expect(report).toMatchObject({
      schemaVersion: 1,
      targetFingerprint: `megaui:${SCOPE}:test`,
      policyEpoch: 3,
      status: "ready",
      counts: { total: 1, ready: 1, conflicts: 0, unquarantinedSubjects: 0, activeActorConflicts: 0 },
      checks: { actorInventory: "ready", directory: "ready", worker: "ready", collab: "ready", database: "read-only" },
      failures: [],
    });
    expect(report.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(trace.some((sql) => /^begin\b/i.test(sql))).toBe(true);
    expect(trace.some((sql) => /^rollback\b/i.test(sql))).toBe(true);
    expect(trace.every((sql) => /^(select|begin|rollback)\b/i.test(sql.trim()))).toBe(true);
    expect(trace.some((sql) => /^\s*(insert|update|delete|truncate|create|alter|drop)\b/i.test(sql))).toBe(false);
    expect(await snapshot()).toEqual(before);

    const outputPath = join(directory, "ready.json");
    const cli = runCli(outputPath);
    expect(cli).toMatchObject({ status: 0, stdout: expect.stringContaining('"status":"ready"'), stderr: "" });
    expect(readFileSync(outputPath, "utf8")).toBe(cli.stdout);
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    for (const secret of ["user-1", "Ada", "ada@example.test", "open-1"]) {
      expect(cli.stdout + cli.stderr).not.toContain(secret);
    }
  }, 60_000);

  it("rejects an incomplete, stale, or generation-mismatched directory snapshot", async () => {
    await pool.query("update enterprise_directory_snapshots set complete=false");
    await expect(runReadinessCheck(baseOptions)).resolves.toMatchObject({ status: "conflict", failures: ["DIRECTORY_INCOMPLETE"] });
    await pool.query("update enterprise_directory_snapshots set complete=true,observed_at=now()-interval '16 minutes'");
    await expect(runReadinessCheck(baseOptions)).resolves.toMatchObject({ status: "conflict", failures: ["DIRECTORY_STALE"] });
    await pool.query("update enterprise_directory_snapshots set complete=true,observed_at=now(),completed_at=now()");
    await pool.query("update enterprise_directory_watermarks set generation=2");
    await expect(runReadinessCheck(baseOptions)).resolves.toMatchObject({ status: "conflict", failures: ["DIRECTORY_GENERATION_MISMATCH"] });
  });

  it("rejects an unquarantined subject and active actor claim conflict", async () => {
    await pool.query("insert into \"user\"(id,name,email,email_verified) values ('user-2','Bob','bob@example.test',false)");
    const missing = await runReadinessCheck(baseOptions);
    expect(missing.failures).toEqual(expect.arrayContaining(["UNQUARANTINED_SUBJECT", "ACTOR_INVENTORY_INCOMPLETE"]));
    await pool.query("update enterprise_actor_reservations set actor_state='ambiguous' where backend_username='Ada'");
    const conflict = await runReadinessCheck(baseOptions);
    expect(conflict.failures).toEqual(expect.arrayContaining(["ACTIVE_ACTOR_CONFLICT"]));
    expect(conflict.status).toBe("conflict");
  });

  it("rejects target database mismatch before admitting the rehearsal", async () => {
    const wrongTarget = { ...baseOptions, expectation: { ...expectation, instanceId: "other-instance" } };
    await expect(runReadinessCheck(wrongTarget)).rejects.toMatchObject({ name: "ReadinessError", exitCode: 3, message: "SCOPE_REJECTED" });
  });

  it("rejects an unready worker and collab policy epoch", async () => {
    await expect(runReadinessCheck({ ...baseOptions, workerReady: false })).resolves.toMatchObject({
      status: "conflict", failures: ["WORKER_NOT_READY"],
    });
    await expect(runReadinessCheck({ ...baseOptions, collabPolicyEpochs: [3, 4] })).resolves.toMatchObject({
      status: "conflict", failures: ["COLLAB_EPOCH_MISMATCH"],
    });
  });

  it("returns a stable CLI conflict for a mismatched manifest digest without creating output", async () => {
    const outputPath = join(directory, "digest-mismatch.json");
    const result = runCli(outputPath, { ENTERPRISE_COLLAB_POLICY_EPOCHS: "3,4" }, "0".repeat(64));
    expect(result).toMatchObject({ status: 3, stdout: "", stderr: "error: APPROVAL_MANIFEST_MISMATCH\n" });
    expect(() => readFileSync(outputPath)).toThrow();
  });
});
