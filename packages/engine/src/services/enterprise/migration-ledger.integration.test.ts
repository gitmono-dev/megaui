// FS-61: signed approved transactions and run-owned PostgreSQL, without provider access.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { targetFingerprint, type EnterpriseScopeExpectation } from "@megaui/database";
import type { ApprovalBundle, GuardedWriteContext } from "../../cli/admin-approval";
import { payloadDigest } from "../../cli/admin-payload";
import { runApprovedMutation, type ApplyMutationResult } from "../../cli/admin-mutation";
import { runActorReservationMutation } from "./actor-reservations";
import { migrationUserVersion, type MigrationEnvelopeMember } from "./manifest";
import { previewMigration } from "./migration-preview";
import { compatibilityEmail } from "./identity-key";
import { createMigrationLedger, migrationRunId, type MigrationBatchResult } from "./migration-ledger";

const SCOPE = "fs61-instance", TENANT = "fs61-tenant", APP = "fs61-app";
const EXPECTATION: EnterpriseScopeExpectation = {
  processRole: "test", ownerFingerprint: "megaui", instanceId: SCOPE, environment: "test",
};
const AUTHORITY = { tenantKey: TENANT, appId: APP };
const SIGNER = fileURLToPath(new URL("../../cli/admin-approval.fixture-signer.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const previousEnv = { ...process.env };

describe("migration phase ledger (FS-61)", () => {
  let isolated: IsolatedPostgres, pool: Pool, directory: string;
  let bytes: Buffer, digest: string, initialUsers: unknown[];
  const scenario = (name: string, fn: () => Promise<void>) => it(name, fn, 60_000);
  function barrier() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  }
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 3000;
    while (!await check()) {
      if (Date.now() >= deadline) throw new Error("fixture barrier timeout");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  function signBundle(operation: ApprovalBundle["operations"][number]): ApprovalBundle {
    const name = join(directory, randomUUID());
    writeFileSync(name + "-request.json", JSON.stringify({ schemaVersion: 1, approvalId: randomUUID(),
      approvedBy: "fixture-authority", issuedAt: 1_700_000_000, expiresAt: 1_899_000_000,
      operations: [operation], signature: "" }));
    const signed = spawnSync(process.execPath, ["--import", "tsx", SIGNER, join(directory, "private.pem"),
      join(directory, "public.pem"), name + "-request.json", name + "-signed.json"], {
      cwd: ROOT, encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test" },
    });
    expect(signed.status).toBe(0);
    return JSON.parse(readFileSync(name + "-signed.json", "utf8")) as ApprovalBundle;
  }
  async function seal() {
    const snapshot = Buffer.from(JSON.stringify({ schemaVersion: 1,
      observedAt: new Date(Date.now() - 1000).toISOString(), actors: [] }));
    const client = await pool.connect();
    try {
      await client.query("begin");
      await runActorReservationMutation({ verb: "reserve-actors", operationId: randomUUID(),
        args: { target: SCOPE, digest: createHash("sha256").update(snapshot).digest("hex") },
        files: { names: () => ["upstream"], bytes: () => snapshot } }, client);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }
  async function writer(verb: string, client: PoolClient, members: readonly MigrationEnvelopeMember[]) {
    for (const member of members) {
      if (verb === "apply") {
        await client.query("insert into enterprise_identity(id,local_user_id,tenant_key,app_id,open_id,status,identity_version) " +
          "values ($1,$2,$3,$4,$5,'active',1) on conflict (local_user_id,tenant_key,app_id) do nothing",
        [randomUUID(), member.local_user_id, TENANT, APP, member.open_id]);
        await client.query("insert into enterprise_profile(user_id,tenant_key,login_name,backend_username,display_name) " +
          "values ($1,$2,$3,$4,'fixture display') on conflict (user_id) do nothing",
        [member.local_user_id, TENANT, member.login_name, member.backend_username]);
      } else {
        await client.query('update enterprise_profile p set notification_email=coalesce(p.notification_email,u.email),updated_at=now() ' +
          'from "user" u where p.user_id=u.id and u.id=$1 and u.email<>$2', [member.local_user_id, compatibilityEmail(member.local_user_id)]);
        await client.query('update "user" set email=$2,email_verified=false,updated_at=now() where id=$1',
          [member.local_user_id, compatibilityEmail(member.local_user_id)]);
      }
    }
  }
  async function execute(verb: "apply" | "convert" | "activate", batch = 0, options: {
    operationId?: string; mutate?: typeof writer; beforeCommit?: () => Promise<void>;
    manifest?: Buffer; approvedDigest?: string; invalidSignature?: boolean; databaseUrl?: string;
    now?: () => Date; beforePort?: (client: PoolClient) => Promise<void>;
  } = {}) {
    const operationId = options.operationId ?? randomUUID(), content = options.manifest ?? bytes;
    const manifestDigest = options.approvedDigest ?? digest;
    const context: GuardedWriteContext = { verb, operationId,
      args: { target: SCOPE, "operation-id": operationId, "expect-policy-epoch": 3,
        digest: manifestDigest, ...(verb === "activate" ? {} : { "batch-number": batch }) },
      files: { names: () => ["manifest"], bytes: name => name === "manifest" ? Buffer.from(content) : undefined } };
    const operation = { verb, operationId, targetFingerprint: targetFingerprint(EXPECTATION), deploymentRole: "test",
      manifestDigest, expectedPolicyEpoch: 3, payloadDigest: payloadDigest({ verb, operationId,
        targetFingerprint: targetFingerprint(EXPECTATION), deploymentRole: "test", expectedPolicyEpoch: 3,
        args: context.args, inputFiles: { manifest: createHash("sha256").update(content).digest("hex") } }) };
    const bundle = signBundle(operation);
    if (options.invalidSignature) bundle.signature = Buffer.alloc(64).toString("base64");
    Object.assign(process.env, { NODE_ENV: "test", DATABASE_URL: options.databaseUrl ?? isolated.databaseUrl,
      ENTERPRISE_APPROVAL_PUBLIC_KEY: readFileSync(join(directory, "public.pem"), "utf8"),
      ENTERPRISE_DB_INSTANCE_ID: SCOPE, ENTERPRISE_PROCESS_ROLE: "test", ENTERPRISE_DEPLOYMENT_ROLE: "test",
      ENTERPRISE_OWNER_FINGERPRINT: "megaui" });
    const ledger = createMigrationLedger({ expectation: EXPECTATION, authority: AUTHORITY, now: options.now });
    let batchResult: MigrationBatchResult | undefined;
    const result = await runApprovedMutation({ bundle, operationId, manifestDigest, expectedPolicyEpoch: 3, context,
      beforeCommit: options.beforeCommit,
      async handler(approved, client): Promise<Record<string, number> | ApplyMutationResult> {
        await options.beforePort?.(client);
        if (verb === "activate") { await ledger.assertConverted(approved, client); return { ready: 1 }; }
        batchResult = await ledger.executeBatch(approved, client,
          (transaction, members) => (options.mutate ?? writer)(verb, transaction, members));
        return verb === "apply" ? { resultCounts: { bound: batchResult.processed },
          applied: batchResult.localUserIds.map((localUserId, index) => ({ row: batch * 100 + index + 1, localUserId })) } :
          { processed: batchResult.processed };
      } });
    return { result, batchResult, operationId };
  }
  async function storedRun() {
    return (await pool.query("select * from enterprise_admin_operations where operation_id=$1",
      [migrationRunId(targetFingerprint(EXPECTATION), digest)])).rows[0];
  }
  async function state() {
    const snapshot: Record<string, unknown> = {};
    for (const table of ["user", "enterprise_identity", "enterprise_profile", "enterprise_admin_operations", "enterprise_batch_checkpoints"]) {
      snapshot[table] = (await pool.query('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),\'[]\'::jsonb) as data from "' + table + '" t')).rows[0].data;
    }
    return snapshot;
  }
  beforeAll(async () => {
    isolated = await createIsolatedPostgres(); await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl }); pool.on("error", () => {});
    directory = mkdtempSync(join(tmpdir(), "megaui-fs61-"));
  }, 120_000);
  beforeEach(async () => {
    await pool.query('delete from enterprise_batch_checkpoints; delete from enterprise_admin_operations; ' +
      'delete from enterprise_actor_inventory; delete from enterprise_actor_reservations; delete from enterprise_quarantine; ' +
      'delete from "user"; delete from enterprise_policy');
    await pool.query("insert into enterprise_policy(id,scope,owner_fingerprint,deployment_role,environment,auth_epoch,activation_state) " +
      "values ('policy',$1,'megaui','test','test',3,'maintenance')", [SCOPE]);
    await pool.query('insert into "user"(id,name,email,email_verified,updated_at) ' +
      "select 'legacy-'||lpad(i::text,3,'0'),' Actor '||i||' ','old-'||i||'@example.test',true,'2026-11-11T01:02:03.123456Z' " +
      "from generate_series(1,101) i");
    await seal();
    const users = (await pool.query('select id,name,email,email_verified as "emailVerified",banned,' +
      'to_char(updated_at at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') as "updatedAt" from "user" order by id')).rows;
    initialUsers = users;
    bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, members: users.map(row => ({ local_user_id: row.id,
      tenant_key: TENANT, app_id: APP, open_id: "open-" + row.id, login_name: "alias-" + row.id,
      expected_user_version: migrationUserVersion(row), expected_identity_version: 0 })) }));
    const report = await previewMigration({ bytes, databaseUrl: isolated.databaseUrl,
      expectation: EXPECTATION, authority: AUTHORITY, deadline: performance.now() + 30_000 });
    expect(report.status).toBe("ready"); expect(report.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    digest = report.manifestDigest!;
  });
  afterAll(async () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    const failures: unknown[] = [];
    try { await pool?.end(); } catch (error) { failures.push(error); }
    try { await isolated?.destroy(); } catch (error) { failures.push(error); }
    try { if (directory) rmSync(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "FS61 cleanup failed");
  }, 120_000);

  scenario("freezes the complete initial approval and records only this batch's legal poststate", async () => {
    const applied = await execute("apply");
    expect(typeof applied.result).toBe("object");
    expect(applied.batchResult).toMatchObject({ processed: 100, batchNumber: 0, phase: "bound", replayed: false });
    const run = await storedRun();
    expect(run.operation_id).toBe(run.id); expect(run.verb).toBe("internal:migration-run:v1");
    expect(run.manifest_digest).toBe(digest); expect(run.expected_user_version).toBeNull();
    expect(run.result.initialEnvelope.members).toHaveLength(101);
    expect(run.result.rows.filter((row: { stage: string }) => row.stage === "bound")).toHaveLength(100);
    expect(run.result.rows[100].stage).toBe("pending"); expect(run.state).toBe("running");
    expect(JSON.stringify(run.result)).not.toContain("@example.test");
    expect((await pool.query("select batch_number,processed from enterprise_batch_checkpoints where operation_id=$1",
      [applied.operationId])).rows).toEqual([{ batch_number: 0, processed: 100 }]);
    expect((await pool.query('select id,name,email,email_verified as "emailVerified",banned,' +
      'to_char(updated_at at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') as "updatedAt" from "user" order by id')).rows).toEqual(initialUsers);
  });
  scenario("rolls back a failed second batch, resumes the same digest and converts both batches", async () => {
    expect(typeof (await execute("apply")).result).toBe("object");
    const before = await storedRun();
    const failed = await execute("apply", 1, { async mutate(verb, client, members) {
      await writer(verb, client, members); throw new Error("fixture second batch failure");
    } });
    expect(failed.result).toBe("DEPENDENCY_FAILED");
    expect(await storedRun()).toEqual(before);
    expect((await pool.query("select count(*)::int as n from enterprise_identity")).rows[0].n).toBe(100);
    expect(typeof (await execute("apply", 1)).result).toBe("object");
    expect((await execute("activate")).result).toBe("DEPENDENCY_FAILED");
    expect(typeof (await execute("convert", 0)).result).toBe("object");
    expect((await execute("activate")).result).toBe("DEPENDENCY_FAILED");
    const convertedFirst = await state();
    expect((await execute("convert", 1, { async mutate(verb, client, members) {
      await writer(verb, client, members); throw new Error("fixture second conversion failure");
    } })).result).toBe("DEPENDENCY_FAILED");
    expect(await state()).toEqual(convertedFirst);
    expect(typeof (await execute("convert", 1)).result).toBe("object");
    expect((await storedRun()).state).toBe("completed");
    expect((await storedRun()).manifest_digest).toBe(digest);
    expect(typeof (await execute("activate")).result).toBe("object");
  });
  scenario("requires every batch bound and maintenance mode before accepting a legal conversion", async () => {
    expect(typeof (await execute("apply")).result).toBe("object");
    const pending = await state();
    expect((await execute("convert")).result).toBe("DEPENDENCY_FAILED");
    expect(await state()).toEqual(pending);
    expect(typeof (await execute("apply", 1)).result).toBe("object");
    await pool.query("update enterprise_policy set activation_state='enterprise' where scope=$1", [SCOPE]);
    const bound = await state();
    expect((await execute("convert")).result).toBe("DEPENDENCY_FAILED");
    expect(await state()).toEqual(bound);
    await pool.query("update enterprise_policy set activation_state='maintenance' where scope=$1", [SCOPE]);
    expect((await execute("convert", 0, { async mutate(verb, client, members) {
      await writer(verb, client, members);
      await client.query("update enterprise_profile set notification_email='replacement@example.test' where user_id='legacy-001'");
    } })).result).toBe("DEPENDENCY_FAILED");
    expect(await state()).toEqual(bound);
    expect(typeof (await execute("convert")).result).toBe("object");
    const converted = await storedRun();
    const replay = await execute("convert", 0, { async mutate() { throw new Error("replay must skip business SQL"); } });
    expect(replay.batchResult?.replayed).toBe(true);
    expect(await storedRun()).toEqual(converted);
  });
  scenario("preserves preexisting notification, display and frozen actor throughout binding and conversion", async () => {
    await pool.query("insert into enterprise_profile(user_id,tenant_key,login_name,backend_username,display_name,notification_email) " +
      "values ('legacy-001',$1,'alias-legacy-001',' Actor 1 ','preserved display','notify@example.test')", [TENANT]);
    const preview = await previewMigration({ bytes, databaseUrl: isolated.databaseUrl,
      expectation: EXPECTATION, authority: AUTHORITY, deadline: performance.now() + 30_000 });
    expect(preview.status).toBe("ready"); digest = preview.manifestDigest!;
    for (const batch of [0, 1]) expect(typeof (await execute("apply", batch)).result).toBe("object");
    expect(typeof (await execute("convert")).result).toBe("object");
    expect((await pool.query("select display_name,notification_email,backend_username from enterprise_profile where user_id='legacy-001'")).rows)
      .toEqual([{ display_name: "preserved display", notification_email: "notify@example.test", backend_username: " Actor 1 " }]);
    expect((await pool.query('select email,email_verified from "user" where id=\'legacy-001\'')).rows)
      .toEqual([{ email: compatibilityEmail("legacy-001"), email_verified: false }]);
  });
  scenario("checks the full initial user and identity versions before the first batch", async () => {
    const original = await state();
    expect((await execute("apply", 0, { approvedDigest: "f".repeat(64) })).result).toBe("DEPENDENCY_FAILED");
    expect(await state()).toEqual(original);
    await pool.query('update "user" set updated_at=updated_at+interval \'1 microsecond\' where id=\'legacy-101\'');
    const drifted = await state();
    expect((await execute("apply")).result).toBe("DEPENDENCY_FAILED");
    expect(await state()).toEqual(drifted);
    await pool.query('update "user" set updated_at=updated_at-interval \'1 microsecond\' where id=\'legacy-101\'');
    const document = JSON.parse(bytes.toString()); document.members[100].expected_identity_version = 1;
    expect((await execute("apply", 0, { manifest: Buffer.from(JSON.stringify(document)) })).result).toBe("DEPENDENCY_FAILED");
    expect(await state()).toEqual(original);
  });
  scenario("supports same-operation replay and fresh approved retries without rewriting poststates", async () => {
    const first = await execute("apply");
    const run = await storedRun();
    const never = async () => { throw new Error("replay must not mutate"); };
    const same = await execute("apply", 0, { operationId: first.operationId, mutate: never });
    expect(same.result).toMatchObject({ replayed: true }); expect(same.batchResult).toBeUndefined();
    const fresh = await execute("apply", 0, { mutate: never,
      manifest: Buffer.from(JSON.stringify(JSON.parse(bytes.toString()), null, 2)) });
    expect(fresh.result).toMatchObject({ replayed: false });
    expect(fresh.batchResult).toMatchObject({ replayed: true, processed: 100 });
    expect(fresh.batchResult?.localUserIds).toEqual(first.batchResult?.localUserIds);
    expect(await storedRun()).toEqual(run);
    expect((await pool.query("select count(*)::int as n from enterprise_admin_operations where verb='apply'")).rows[0].n).toBe(2);
    expect((await pool.query("select count(*)::int as n from enterprise_batch_checkpoints where manifest_digest=$1", [digest])).rows[0].n).toBe(2);
  });
  scenario("rejects unapproved calls, missing runs and invalid fixed batch numbers with zero writes", async () => {
    const before = await state(); let calls = 0;
    const mutate = async () => { calls++; };
    expect((await execute("apply", 0, { invalidSignature: true, mutate })).result).toBe("APPROVAL_SIGNATURE_INVALID");
    expect(calls).toBe(0);
    for (const batch of [-1, 0.5, 2, Number.MAX_SAFE_INTEGER]) {
      expect((await execute("apply", batch, { mutate })).result).toBe("INVALID_ARGUMENT");
    }
    expect((await execute("convert", 0, { mutate })).result).toBe("DEPENDENCY_FAILED");
    expect((await execute("activate")).result).toBe("DEPENDENCY_FAILED");
    expect(calls).toBe(0); expect(await state()).toEqual(before);
  });
  scenario("rejects malformed persisted envelopes, rows and namespace columns before business SQL", async () => {
    expect(typeof (await execute("apply")).result).toBe("object");
    const original = await storedRun(); let calls = 0;
    const variants: ((value: typeof original.result) => void)[] = [
      value => { value.schemaVersion = 2; }, value => { value.kind = "ordinary"; }, value => { value.extra = true; },
      value => { delete value.rows; }, value => { value.rows.pop(); }, value => { value.rows[1].row = 1; },
      value => { value.rows[0].stage = "future"; }, value => { value.rows[0].userVersion = "F".repeat(64); },
      value => { value.rows[100].userVersion = "f".repeat(64); }, value => { value.rows[100].lastOperationId = randomUUID(); },
      value => { value.rows[0].lastOperationId = null; }, value => { value.rows[0].extra = true; },
      value => { value.initialEnvelope.members[0].backend_username = "different actor"; },
      value => { value.initialEnvelope.members[0].expected_user_version = "0".repeat(64); },
      value => { value.initialEnvelope.members[1].local_user_id = value.initialEnvelope.members[0].local_user_id; },
      value => { value.initialEnvelope.extra = true; }, value => { value.manifestDigest = "0".repeat(64); },
      value => { value.targetFingerprint = "megaui:other:test"; }, value => { value.migrationRunId = "migration-run:" + "0".repeat(64); },
      value => { value.rows[0].stage = "pending"; }, value => { value.rows.reverse(); },
    ];
    for (const corrupt of variants) {
      const bad = structuredClone(original.result); corrupt(bad);
      await pool.query("update enterprise_admin_operations set result=$2::jsonb where id=$1", [original.id, JSON.stringify(bad)]);
      const before = await state();
      expect((await execute("apply", 1, { mutate: async () => { calls++; } })).result).toBe("DEPENDENCY_FAILED");
      expect(await state()).toEqual(before);
    }
    await pool.query("update enterprise_admin_operations set result=$2::jsonb where id=$1", [original.id, JSON.stringify(original.result)]);
    for (const [column, bad] of [["id", "wrong-internal-id"], ["verb", "apply"], ["manifest_digest", "0".repeat(64)],
      ["state", "completed"], ["expected_user_version", 1], ["expected_identity_version", 1]] as const) {
      await pool.query('update enterprise_admin_operations set "' + column + '"=$2 where operation_id=$1', [original.operation_id, bad]);
      const before = await state();
      expect((await execute("apply", 1, { mutate: async () => { calls++; } })).result).toBe("DEPENDENCY_FAILED");
      expect(await state()).toEqual(before);
      await pool.query('update enterprise_admin_operations set "' + column + '"=$2 where operation_id=$1', [original.operation_id, original[column]]);
    }
    expect(calls).toBe(0);
    expect(typeof (await execute("apply", 1)).result).toBe("object");
  });
  scenario("detects notification and microsecond drift after a legal phase, including untouched batches", async () => {
    expect(typeof (await execute("apply")).result).toBe("object");
    await pool.query("update enterprise_profile set notification_email='outside-change@example.test' where user_id='legacy-001'");
    let before = await state();
    expect((await execute("apply", 1)).result).toBe("DEPENDENCY_FAILED"); expect(await state()).toEqual(before);
    await pool.query("update enterprise_profile set notification_email=null where user_id='legacy-001'");
    await pool.query("update enterprise_identity set updated_at=updated_at+interval '1 microsecond' where local_user_id='legacy-001'");
    before = await state();
    expect((await execute("apply", 1)).result).toBe("DEPENDENCY_FAILED"); expect(await state()).toEqual(before);
    await pool.query("update enterprise_identity set updated_at=updated_at-interval '1 microsecond' where local_user_id='legacy-001'");
    await pool.query('update "user" set updated_at=updated_at+interval \'1 microsecond\' where id=\'legacy-101\'');
    before = await state();
    expect((await execute("apply", 0)).result).toBe("DEPENDENCY_FAILED"); expect(await state()).toEqual(before);
  });
  scenario("rejects replacement full manifests and global ownership drift even when this batch is unchanged", async () => {
    expect(typeof (await execute("apply")).result).toBe("object");
    const document = JSON.parse(bytes.toString()); document.members[100].login_name = "replacement-alias";
    let before = await state();
    expect((await execute("apply", 1, { manifest: Buffer.from(JSON.stringify(document)) })).result).toBe("DEPENDENCY_FAILED");
    expect(await state()).toEqual(before);
    await pool.query('insert into "user"(id,name,email,email_verified) values (\'outside\',\'outside actor\',\'outside@example.test\',false)');
    await seal(); before = await state();
    expect((await execute("apply", 1)).result).toBe("DEPENDENCY_FAILED"); expect(await state()).toEqual(before);
  });
  scenario("rolls back business writes, phase ledger and checkpoint when the FS-81 commit fails", async () => {
    const before = await state();
    expect((await execute("apply", 0, { beforeCommit: async () => { throw new Error("fixture outer commit failure"); } })).result).toBe("DEPENDENCY_FAILED");
    expect(await state()).toEqual(before);
    expect(typeof (await execute("apply")).result).toBe("object");
  });
  scenario("refuses illegal poststates, out-of-batch edits and inventory expiry at the end", async () => {
    const before = await state();
    expect((await execute("apply", 0, { mutate: async () => {} })).result).toBe("DEPENDENCY_FAILED");
    expect(await state()).toEqual(before);
    expect((await execute("apply", 0, { async mutate(verb, client, members) {
      await writer(verb, client, members);
      await client.query('update "user" set updated_at=updated_at+interval \'1 microsecond\' where id=\'legacy-101\'');
    } })).result).toBe("DEPENDENCY_FAILED");
    expect(await state()).toEqual(before);
    let ticks = 0; const at = Date.now();
    expect((await execute("apply", 0, { now: () => new Date(at + (ticks++ ? 25 * 60 * 60_000 : 0)) })).result).toBe("DEPENDENCY_FAILED");
    expect(await state()).toEqual(before);
  });
  scenario("rechecks freshness after writing the checkpoint, before returning to the outer transaction", async () => {
    const before = await state(), at = Date.now(); let ticks = 0;
    expect((await execute("apply", 0, { now: () => new Date(at + (ticks++ >= 2 ? 25 * 60 * 60_000 : 0)) })).result).toBe("DEPENDENCY_FAILED");
    expect(await state()).toEqual(before);
  });
  scenario("retains all source table locks until the FS-81 outer transaction commits", async () => {
    const reached = barrier(), finish = barrier(), outsider = await pool.connect();
    let mainPid = 0, blocked: Promise<unknown> | undefined;
    const approved = execute("apply", 0, {
      async beforePort(client) { mainPid = (await client.query("select pg_backend_pid() as pid")).rows[0].pid; },
      async beforeCommit() { reached.release(); await finish.promise; },
    });
    try {
      await reached.promise;
      const locks = (await pool.query("select c.relname from pg_locks l join pg_class c on c.oid=l.relation " +
        "where l.pid=$1 and l.mode='ShareLock' and l.granted order by c.relname", [mainPid])).rows.map(row => row.relname);
      expect(locks).toEqual(["enterprise_actor_reservations", "enterprise_identity", "enterprise_profile", "enterprise_quarantine", "user"]);
      const pid = (await outsider.query("select pg_backend_pid() as pid")).rows[0].pid;
      await outsider.query("begin");
      blocked = outsider.query('update "user" set updated_at=updated_at+interval \'1 microsecond\' where id=\'legacy-101\'');
      await until(async () => (await pool.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type === "Lock");
      finish.release();
      expect(typeof (await approved).result).toBe("object");
      await blocked;
    } finally {
      finish.release(); await Promise.allSettled([approved, blocked]);
      await outsider.query("rollback"); outsider.release();
    }
  });
  scenario("reads after the source barrier and rejects an earlier writer's committed drift", async () => {
    const outsider = await pool.connect(), entered = barrier(); let mainPid = 0, calls = 0;
    await outsider.query("begin");
    await outsider.query('update "user" set updated_at=updated_at+interval \'1 microsecond\' where id=\'legacy-101\'');
    const approved = execute("apply", 0, {
      async beforePort(client) { mainPid = (await client.query("select pg_backend_pid() as pid")).rows[0].pid; entered.release(); },
      mutate: async () => { calls++; },
    });
    try {
      await entered.promise;
      await until(async () => (await pool.query("select wait_event_type from pg_stat_activity where pid=$1", [mainPid])).rows[0]?.wait_event_type === "Lock");
      await outsider.query("commit");
      expect((await approved).result).toBe("DEPENDENCY_FAILED"); expect(calls).toBe(0);
      expect(await storedRun()).toBeUndefined();
      expect((await pool.query("select count(*)::int as n from enterprise_identity")).rows[0].n).toBe(0);
    } finally { await outsider.query("rollback"); outsider.release(); await Promise.allSettled([approved]); }
  });
  scenario("serializes concurrent approved operations for the same run without duplicate business writes", async () => {
    const reached = barrier(), finish = barrier(); let calls = 0;
    const mutate: typeof writer = async (verb, client, members) => { calls++; await writer(verb, client, members); };
    const first = execute("apply", 0, { mutate, async beforeCommit() { reached.release(); await finish.promise; } });
    let second: ReturnType<typeof execute> | undefined;
    try {
      await reached.promise;
      second = execute("apply", 0, { mutate });
      await until(async () => (await pool.query("select count(*)::int as n from pg_stat_activity " +
        "where wait_event_type='Lock' and query like '%enterprise_policy%'")).rows[0].n > 0);
      finish.release();
      expect(typeof (await first).result).toBe("object");
      const replay = await second;
      expect(typeof replay.result).toBe("object"); expect(replay.batchResult?.replayed).toBe(true); expect(calls).toBe(1);
    } finally { finish.release(); await Promise.allSettled([first, second]); }
  });
  scenario("requires a caller-owned READ COMMITTED transaction", async () => {
    const url = new URL(isolated.databaseUrl);
    url.searchParams.set("options", "-c default_transaction_isolation=serializable");
    let seen = false;
    expect(typeof (await execute("apply", 0, { databaseUrl: url.toString(), async beforePort(client) {
      expect((await client.query("show transaction_isolation")).rows[0].transaction_isolation).toBe("read committed"); seen = true;
    } })).result).toBe("object");
    expect(seen).toBe(true);
    const before = await state();
    const client = await pool.connect(), operationId = randomUUID();
    const context: GuardedWriteContext = { verb: "apply", operationId, args: { target: SCOPE, "operation-id": operationId,
      "expect-policy-epoch": 3, digest, "batch-number": 0 }, files: { names: () => ["manifest"], bytes: () => bytes } };
    try {
      const ledger = createMigrationLedger({ expectation: EXPECTATION, authority: AUTHORITY });
      await expect(ledger.executeBatch(context, client, async () => {})).rejects.toMatchObject({ code: "25P01" });
      await client.query("begin isolation level serializable");
      await expect(ledger.executeBatch(context, client, async () => {})).rejects.toThrow("MIGRATION_TRANSACTION_REJECTED");
    } finally { await client.query("rollback"); client.release(); }
    expect(await state()).toEqual(before);
  });
  scenario("bounds real source lock waits at five seconds and preserves shorter effective timeouts", async () => {
    const outsider = await pool.connect(), before = await state();
    await outsider.query("begin"); await outsider.query('update "user" set name=name where id=\'legacy-001\'');
    const started = Date.now();
    try {
      expect((await execute("apply", 0, { async beforePort(client) {
        await client.query("select set_config('statement_timeout','20000',true),set_config('lock_timeout','15000',true)," +
          "set_config('idle_in_transaction_session_timeout','12000',true)");
      } })).result).toBe("DEPENDENCY_FAILED");
      expect(Date.now() - started).toBeLessThan(8500);
    } finally { await outsider.query("rollback"); outsider.release(); }
    expect(await state()).toEqual(before);
    let observed = false;
    expect(typeof (await execute("apply", 0, { async beforePort(client) {
      await client.query("select set_config(name,'1200',true) from pg_settings " +
        "where name in ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout')");
    }, async mutate(verb, client, members) {
      const settings = (await client.query("select name,setting from pg_settings " +
        "where name in ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout')")).rows;
      expect(settings).toHaveLength(3); expect(settings.every(row => row.setting === "1200")).toBe(true);
      observed = true; await writer(verb, client, members);
    } })).result).toBe("object");
    expect(observed).toBe(true);
  });
});
