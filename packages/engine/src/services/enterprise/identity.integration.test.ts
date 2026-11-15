// FS-05: strict approved manifest bytes, then real signed CLI/Mock/PG integration.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { payloadDigest } from "../../cli/admin-payload";
import { runApprovedMutation } from "../../cli/admin-mutation";
import { readApprovedFileBytes } from "../../cli/enterprise-admin";
import { runActorReservationMutation, checkActorReservationCoverage } from "./actor-reservations";
import { parseProvisionManifest } from "./provision-input";

const member = (overrides: Record<string, unknown> = {}) => ({
  tenant_key: "tenant_mock_megaui", app_id: "cli_mock_megaui",
  open_id: "ou_mock_alice", login_name: "alice", ...overrides,
});
const manifest = (members: unknown[] = [member()], extra: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ schemaVersion: 1, members, ...extra }));

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const CLI = fileURLToPath(new URL("../../cli/enterprise-admin.ts", import.meta.url));
const SIGNER = fileURLToPath(new URL("../../cli/admin-approval.fixture-signer.ts", import.meta.url));
const SCOPE = "fs05-instance";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("signed provision command with real Mock HTTP and PostgreSQL (FS-05)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  let directory: string;
  let privatePath: string;
  let publicPath: string;
  let child: ChildProcess;
  let receiver: Server;
  let runtimeFile: string;
  let runtime: { schemaVersion: number; baseUrl: string; callbackUrl: string; appId: string;
    tenantKey: string; adminToken: string; appSecret: string };
  const scenario = (name: string, fn: () => Promise<void>) => it(name, fn, 60_000);

  async function control(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(runtime.baseUrl + path, { method,
      headers: { authorization: "Bearer " + runtime.adminToken, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000) });
    const result = await response.json();
    if (!response.ok) throw new Error("mock control request failed");
    return result;
  }

  function command(bytes = manifest(), options: { operationId?: string; epoch?: number; digest?: string } = {}) {
    const operationId = options.operationId ?? randomUUID();
    const epoch = options.epoch ?? 3;
    const base = join(directory, randomUUID());
    const manifestPath = base + "-manifest.json", payloadPath = base + "-payload.json";
    const requestPath = base + "-request.json", bundlePath = base + "-bundle.json";
    const digest = options.digest ?? hash(bytes);
    writeFileSync(manifestPath, bytes);
    const payload = { verb: "provision", targetFingerprint: "megaui:" + SCOPE + ":test", deploymentRole: "test",
      operationId, expectedPolicyEpoch: epoch,
      args: { target: SCOPE, "operation-id": operationId, "expect-policy-epoch": epoch, manifest: manifestPath, digest },
      inputFiles: { manifest: hash(bytes) } };
    writeFileSync(payloadPath, JSON.stringify({ schemaVersion: 1, ...payload }));
    writeFileSync(requestPath, JSON.stringify({ schemaVersion: 1, approvalId: randomUUID(), approvedBy: "fs05-fixture",
      issuedAt: Math.floor(Date.now() / 1000) - 60, expiresAt: Math.floor(Date.now() / 1000) + 7200,
      operations: [{ verb: "provision", targetFingerprint: payload.targetFingerprint, deploymentRole: "test", operationId,
        expectedPolicyEpoch: epoch, manifestDigest: digest, payloadDigest: payloadDigest(payload) }], signature: "" }));
    const signer = spawnSync(process.execPath, ["--import", "tsx", SIGNER, privatePath, publicPath, requestPath, bundlePath],
      { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
    if (signer.error || signer.status !== 0) throw new Error("fixture signing failed");
    const baseArgs = ["provision", "--target", SCOPE, "--operation-id", operationId, "--expect-policy-epoch", String(epoch),
      "--manifest", manifestPath, "--digest", digest];
    return { operationId, manifestPath, payloadPath, bundlePath, baseArgs,
      argv: [...baseArgs, "--approval", bundlePath, "--approved-payload", payloadPath] };
  }

  function run(input: ReturnType<typeof command>, options: { env?: NodeJS.ProcessEnv; args?: string[]; preload?: string } = {}) {
    const result = spawnSync(process.execPath, ["--import", "tsx", ...(options.preload ? ["--import", options.preload] : []), CLI, ...(options.args ?? input.argv)], {
      cwd: ROOT, encoding: "utf8", timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", AUTH_MODE: "enterprise",
        DATABASE_URL: isolated.databaseUrl, ENTERPRISE_APPROVAL_PUBLIC_KEY: readFileSync(publicPath, "utf8"),
        ENTERPRISE_DB_INSTANCE_ID: SCOPE, ENTERPRISE_PROCESS_ROLE: "test", ENTERPRISE_DEPLOYMENT_ROLE: "test",
        ENTERPRISE_OWNER_FINGERPRINT: "megaui", FEISHU_PROVIDER: "simulator", FEISHU_SIMULATOR_ORIGIN: runtime.baseUrl,
        FEISHU_TENANT_KEY: runtime.tenantKey, FEISHU_APP_ID: runtime.appId, FEISHU_APP_SECRET: runtime.appSecret,
        FEISHU_DIRECTORY_DEPARTMENT_IDS: '["od_mock_engineering","od_mock_operations"]', ...options.env },
    });
    if (result.error) throw result.error;
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  async function stored() {
    const result: Record<string, unknown[]> = {};
    for (const table of ["user", "enterprise_identity", "enterprise_profile", "enterprise_actor_reservations",
      "enterprise_actor_inventory", "enterprise_admin_operations", "enterprise_batch_checkpoints", "account", "session"]) {
      result[table] = (await pool.query('select * from "' + table + '" order by 1')).rows;
    }
    return result;
  }

  async function waitExit(ms: number): Promise<boolean> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { child.off("exit", done); resolve(false); }, ms);
      child.once("exit", done);
    });
  }

  beforeAll(async () => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "megaui-fs05-")));
    privatePath = join(directory, "authority-private.pem"); publicPath = join(directory, "authority-public.pem");
    const keys = generateKeyPairSync("ed25519");
    writeFileSync(privatePath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(publicPath, keys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
    receiver = createServer((request, response) => { request.resume(); request.on("end", () => response.end("{}")); });
    await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve));
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("missing fixture receiver");
    const callbackUrl = "http://127.0.0.1:" + address.port + "/api/integrations/feishu/events";
    // Frozen CLI/IPC protocol only: engine tests never import apps or Mock source.
    child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "apps/feishu-mock/src/index.ts")], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { NODE_ENV: "test", FEISHU_SIMULATOR_ENABLED: "1", FEISHU_SIMULATOR_PORT: "0", FEISHU_SIMULATOR_CALLBACK_URL: callbackUrl },
    });
    child.stderr?.resume();
    const ready = await new Promise<{ baseUrl: string; runtimeFile: string }>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("mock startup timeout")), 15_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("mock exited before ready")); });
      child.stdout?.on("data", chunk => {
        output += String(chunk);
        const end = output.indexOf("\n");
        if (end < 0) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(output.slice(0, end))); } catch { reject(new Error("invalid mock receipt")); }
      });
    });
    runtimeFile = ready.runtimeFile;
    runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
    expect(runtime).toMatchObject({ schemaVersion: 1, baseUrl: ready.baseUrl, callbackUrl,
      appId: "cli_mock_megaui", tenantKey: "tenant_mock_megaui" });
    const health = await fetch(runtime.baseUrl + "/health", { signal: AbortSignal.timeout(3000) });
    await health.arrayBuffer(); expect(health.ok).toBe(true);
    isolated = await createIsolatedPostgres(); await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl }); pool.on("error", () => {});
  }, 120_000);

  beforeEach(async () => {
    await control("/__mock/reset", {});
    await pool.query('truncate "user", enterprise_actor_inventory, enterprise_actor_reservations, ' +
      'enterprise_admin_operations, enterprise_batch_checkpoints, enterprise_policy cascade');
    await pool.query("insert into enterprise_policy (id,scope,owner_fingerprint,deployment_role,environment,auth_epoch,activation_state) " +
      "values ('fs05-policy',$1,'megaui','test','test',3,'enterprise')", [SCOPE]);
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, observedAt: new Date(Date.now() - 1000).toISOString(), actors: [] }));
    const client = await pool.connect();
    try {
      await client.query("begin");
      await runActorReservationMutation({ verb: "reserve-actors", operationId: randomUUID(), args: { target: SCOPE, digest: hash(bytes) },
        files: { names: () => ["upstream"], bytes: () => bytes } }, client);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try { if (runtime) await control("/__mock/reset", {}); } catch (error) { errors.push(error); }
    try { if (receiver) await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve())); }
    catch (error) { errors.push(error); }
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (!await waitExit(3000)) { child.kill("SIGKILL"); if (!await waitExit(3000)) throw new Error("mock did not stop"); }
      if (runtimeFile && existsSync(runtimeFile)) throw new Error("mock runtime file leaked");
    } catch (error) { errors.push(error); }
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    try { if (directory) rmSync(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FS-05 cleanup failed");
  });

  async function rejectWithoutWrites(input: ReturnType<typeof command>, key: string, code: number, options: Parameters<typeof run>[1] = {}) {
    const before = await stored();
    expect(run(input, options)).toEqual({ code, stdout: "", stderr: "error: " + key + "\n" });
    expect(await stored()).toEqual(before);
  }

  scenario("replays the original complete mapping without provider config or provider calls", async () => {
    const input = command(manifest([member(), member({ open_id: "ou_mock_bob", login_name: "bob" })]));
    const first = run(input);
    expect(first.code).toBe(0);
    const original = JSON.parse(first.stdout);
    const before = await stored();
    await control("/__mock/faults", { target: "user", kind: "403", count: 1 });
    const state = await control("/__mock/state");
    const replay = run(input, { env: { FEISHU_APP_SECRET: undefined, FEISHU_DIRECTORY_DEPARTMENT_IDS: undefined,
      FEISHU_PROVIDER: undefined, FEISHU_SIMULATOR_ORIGIN: undefined } });
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.stdout)).toEqual({ ...original, replayed: true });
    expect(await control("/__mock/state")).toEqual(state);
    expect(await stored()).toEqual(before);
  });

  for (const corruption of ["missing", "truncated", "count", "duplicate", "row", "uuid", "oversized"]) {
    scenario("rejects corrupted persisted mappings: " + corruption, async () => {
      const input = command(manifest([member(), member({ open_id: "ou_mock_bob", login_name: "bob" })]));
      expect(run(input).code).toBe(0);
      const result = (await pool.query("select result from enterprise_admin_operations where operation_id=$1", [input.operationId])).rows[0]?.result;
      if (corruption === "missing") delete result.provisioned;
      if (corruption === "truncated") { result.provisioned = result.provisioned.slice(0, 1); result.resultCounts.created = 1; }
      if (corruption === "count") result.resultCounts.created = 1;
      if (corruption === "duplicate") result.provisioned[1].localUserId = result.provisioned[0].localUserId;
      if (corruption === "row") result.provisioned[1].row = 3;
      if (corruption === "uuid") result.provisioned[0].localUserId = "invalid";
      if (corruption === "oversized") {
        result.provisioned = Array.from({ length: 101 }, (_, i) => ({ row: i + 1, localUserId: randomUUID() }));
        result.resultCounts.created = 101;
      }
      await pool.query("update enterprise_admin_operations set result=$2::jsonb where operation_id=$1", [input.operationId, JSON.stringify(result)]);
      await rejectWithoutWrites(input, "OPERATION_PAYLOAD_MISMATCH", 3);
    });
  }

  scenario("refuses rebinding an external identity in another operation instead of merging by email or name", async () => {
    expect(run(command()).code).toBe(0);
    await rejectWithoutWrites(command(manifest([member({ login_name: "another" })])), "PROVISION_REJECTED", 3);
  });

  scenario("refuses modified payloads, epoch and target before business writes", async () => {
    const input = command();
    expect(run(input).code).toBe(0);
    await rejectWithoutWrites(command(manifest([member({ display_name: "Different" })]), { operationId: input.operationId }), "OPERATION_PAYLOAD_MISMATCH", 3);
    await rejectWithoutWrites(command(manifest(), { epoch: 2 }), "EPOCH_CAS_MISMATCH", 3);
    await rejectWithoutWrites(command(manifest(), { digest: "a".repeat(64) }), "APPROVAL_DIGEST_MISMATCH", 3);
    const fresh = command();
    await rejectWithoutWrites(fresh, "APPROVAL_TARGET_MISMATCH", 3, { args: fresh.argv.map(value => value === SCOPE ? "other-instance" : value) });
    writeFileSync(fresh.manifestPath, manifest([member({ display_name: "Changed after signing" })]));
    await rejectWithoutWrites(fresh, "APPROVAL_DIGEST_MISMATCH", 3);
  });

  scenario("rejects invalid deployment configuration without accepting manifest authority overrides", async () => {
    for (const env of [
      { FEISHU_DIRECTORY_DEPARTMENT_IDS: undefined }, { FEISHU_DIRECTORY_DEPARTMENT_IDS: '["a","a"]' },
      { FEISHU_APP_SECRET: undefined }, { FEISHU_PROVIDER: "unknown" },
      { FEISHU_SIMULATOR_ORIGIN: "http://localhost:3000" },
      { FEISHU_TENANT_KEY: " " }, { FEISHU_APP_ID: " spaced " }, { AUTH_MODE: "invalid" },
    ]) await rejectWithoutWrites(command(), "INVALID_CONFIG", 2, { env });
    await rejectWithoutWrites(command(manifest([member({ department_ids: ["od_mock_engineering"] })])), "INVALID_ARGUMENT", 2);
    await rejectWithoutWrites(command(manifest([member({ tenant_key: "other-tenant" })])), "INVALID_ARGUMENT", 2);
    await rejectWithoutWrites(command(manifest([member({ app_id: "other-app" })])), "INVALID_ARGUMENT", 2);
    await rejectWithoutWrites(command(), "PROVISION_REJECTED", 3, { env: { AUTH_MODE: "legacy" } });
  });

  scenario("rejects out-of-scope, missing and provider-denied members", async () => {
    await rejectWithoutWrites(command(manifest([member({ open_id: "ou_mock_carol" })])), "PROVISION_REJECTED", 3,
      { env: { FEISHU_DIRECTORY_DEPARTMENT_IDS: '["od_mock_engineering"]' } });
    await rejectWithoutWrites(command(manifest([member({ open_id: "ou_missing" })])), "PROVISION_REJECTED", 3);
    await control("/__mock/faults", { target: "user", kind: "403", count: 1 });
    await rejectWithoutWrites(command(), "PROVISION_REJECTED", 3);
  });

  scenario("refuses suspended and resigned members from authoritative Mock HTTP", async () => {
    for (const status of ["suspended", "resigned"]) {
      await control("/__mock/users/ou_mock_alice", { status }, "PATCH");
      await rejectWithoutWrites(command(), "PROVISION_REJECTED", 3);
    }
  });

  scenario("refuses a permanently reserved alias without creating another subject", async () => {
    expect(run(command()).code).toBe(0);
    const actor = (await pool.query("select backend_username from enterprise_profile")).rows[0]?.backend_username;
    await rejectWithoutWrites(command(manifest([member({ open_id: "ou_mock_bob", login_name: actor })])), "PROVISION_REJECTED", 3);
  });

  scenario("performs exactly one barrier with all directory reads and subject creation before it", async () => {
    const tracePath = join(directory, "barrier-trace.json");
    const preload = join(directory, "observe-barrier.mjs");
    const pgUrl = new URL("../../../node_modules/pg/lib/index.js", import.meta.url).href;
    writeFileSync(preload, "import pg from " + JSON.stringify(pgUrl) + "; import {writeFileSync} from 'node:fs';\n" +
      "const state={barriers:0,reads:0,lateReads:0,creates:0,lateCreates:0}; const query=pg.Client.prototype.query;\n" +
      "pg.Client.prototype.query=function(...args){const sql=typeof args[0]==='string'?args[0]:''; " +
      "if (/^lock table /i.test(sql)) state.barriers++; " +
      "if (/^insert into (?:\\\"user\\\"|enterprise_identity|enterprise_profile) /i.test(sql)) { state.creates++; if(state.barriers) state.lateCreates++; } " +
      "return query.apply(this,args);}; const originalFetch=globalThis.fetch; " +
      "globalThis.fetch=(...args)=>{state.reads++;if(state.barriers)state.lateReads++;return originalFetch(...args);}; " +
      "process.on('exit',()=>writeFileSync(" + JSON.stringify(tracePath) + ",JSON.stringify(state)));\n");
    const input = command(manifest([member(), member({ open_id: "ou_mock_bob", login_name: "bob" })]));
    expect(run(input, { preload })).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(readFileSync(tracePath, "utf8"))).toEqual({ barriers: 1, reads: 3, lateReads: 0, creates: 6, lateCreates: 0 });
  });

  scenario("rejects malformed or oversized signed manifests with zero writes", async () => {
    for (const bytes of [Buffer.from([255]), manifest([]), manifest([member({ role: "admin" })]),
      manifest(Array.from({ length: 101 }, (_, i) => member({ open_id: "ou_" + i, login_name: "alias" + i }))),
      Buffer.alloc(1024 * 1024 + 1, 32)]) await rejectWithoutWrites(command(bytes), "INVALID_ARGUMENT", 2);
  });

  scenario("rejects an oversized inode before the pinned file read handshake", async () => {
    const path = join(directory, "oversized-manifest.json");
    writeFileSync(path, Buffer.alloc(1024 * 1024 + 1, 32));
    let readStarted = false;
    const result = await readApprovedFileBytes(path, () => { readStarted = true; }, "python3", 10_000, directory, 1024 * 1024);
    expect(typeof result === "string" ? result : "bytes-were-read").toBe("INVALID_ARGUMENT");
    expect(readStarted).toBe(false);
  });

  scenario("requires persistent enterprise activation and complete fresh actor inventory", async () => {
    await pool.query("update enterprise_policy set activation_state='maintenance'");
    await rejectWithoutWrites(command(), "PROVISION_REJECTED", 3);
    await pool.query("update enterprise_policy set activation_state='enterprise'");
    await pool.query("update enterprise_actor_inventory set observed_at=now()-interval '25 hours'");
    await rejectWithoutWrites(command(), "PROVISION_REJECTED", 3);
  });

  for (const table of ["user", "enterprise_identity", "enterprise_profile", "enterprise_actor_reservations",
    "enterprise_actor_inventory", "enterprise_batch_checkpoints", "enterprise_admin_operations"]) {
    scenario("rolls the entire batch back when writing " + table + " fails", async () => {
      const condition = table === "enterprise_identity" ? "if NEW.open_id <> 'ou_mock_bob' then return NEW; end if; " : "";
      await pool.query("create function fs05_reject() returns trigger language plpgsql as $$ begin " + condition +
        "raise exception 'fixture-only private SQL detail'; end $$");
      const event = table === "enterprise_actor_inventory" ? "update" : "insert";
      await pool.query('create trigger fs05_fault before ' + event + ' on "' + table + '" for each row execute function fs05_reject()');
      try {
        await rejectWithoutWrites(command(manifest([member(), member({ open_id: "ou_mock_bob", login_name: "bob" })])), "DEPENDENCY_FAILED", 4);
      } finally {
        await pool.query('drop trigger fs05_fault on "' + table + '"');
        await pool.query("drop function fs05_reject()");
      }
    });
  }

  scenario("refuses a partial mapping at first persistence and rolls back the handler's write", async () => {
    const input = command(manifest([member(), member({ open_id: "ou_mock_bob", login_name: "bob" })]));
    const before = await stored();
    const approved = JSON.parse(readFileSync(input.payloadPath, "utf8"));
    const bytes = readFileSync(input.manifestPath);
    const trusted = { DATABASE_URL: isolated.databaseUrl, ENTERPRISE_APPROVAL_PUBLIC_KEY: readFileSync(publicPath, "utf8"),
      ENTERPRISE_DB_INSTANCE_ID: SCOPE, ENTERPRISE_PROCESS_ROLE: "test", ENTERPRISE_DEPLOYMENT_ROLE: "test", ENTERPRISE_OWNER_FINGERPRINT: "megaui" };
    for (const [key, value] of Object.entries(trusted)) vi.stubEnv(key, value);
    try {
      const result = await runApprovedMutation({ bundle: JSON.parse(readFileSync(input.bundlePath, "utf8")),
        operationId: input.operationId, expectedPolicyEpoch: 3, manifestDigest: hash(bytes),
        context: { verb: "provision", operationId: input.operationId, args: approved.args,
          files: { names: () => ["manifest"], bytes: () => bytes } },
        async handler(_context, client) {
          const id = randomUUID();
          await client.query('insert into "user" (id,name,email,email_verified) values ($1,\'test\',\'partial@identity.invalid\',false)', [id]);
          return { resultCounts: { created: 1 }, provisioned: [{ row: 1, localUserId: id }] };
        },
      });
      expect(result).toBe("DEPENDENCY_FAILED");
      expect(await stored()).toEqual(before);
    } finally { vi.unstubAllEnvs(); }
  });

  scenario("emits approval requests without provider configuration or any business writes", async () => {
    const input = command();
    const before = await stored();
    const outputPath = join(directory, randomUUID() + "-emitted.json");
    const result = run(input, { args: [...input.baseArgs, "--emit-approval-request", "--out", outputPath],
      env: { FEISHU_APP_SECRET: undefined, FEISHU_DIRECTORY_DEPARTMENT_IDS: undefined } });
    expect(result).toMatchObject({ code: 0, stderr: "", stdout: "" });
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({ schemaVersion: 1, verb: "provision", operationId: input.operationId });
    expect(await stored()).toEqual(before);
  });

  scenario("creates ordinary members with independent nullable notifications and one atomic checkpoint", async () => {
    const input = command(manifest([
      member({ display_name: "Synthetic Alice", notification_email: "shared@example.test" }),
      member({ open_id: "ou_mock_bob", login_name: "bob", notification_email: "shared@example.test" }),
      member({ open_id: "ou_mock_carol", login_name: "carol" }),
    ]));
    const result = run(input);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const output = JSON.parse(result.stdout) as { schemaVersion: number; provisioned: { row: number; localUserId: string }[] };
    expect(output).toMatchObject({ schemaVersion: 2, operationId: input.operationId, policyEpoch: 3, resultCounts: { created: 3 }, replayed: false });
    expect(output.provisioned.map(row => row.row)).toEqual([1, 2, 3]);
    expect(new Set(output.provisioned.map(row => row.localUserId)).size).toBe(3);
    for (const row of output.provisioned) {
      const user = (await pool.query('select * from "user" where id=$1', [row.localUserId])).rows[0];
      expect(user).toMatchObject({ role: "user", email_verified: false, banned: false });
      let bits = BigInt("0x" + hash(Buffer.from(row.localUserId))) << 4n;
      let encoded = "";
      for (let i = 0; i < 52; i++) { encoded = "abcdefghijklmnopqrstuvwxyz234567"[Number(bits & 31n)] + encoded; bits >>= 5n; }
      expect(user.email).toBe("u_" + encoded + "@identity.invalid");
    }
    expect((await pool.query("select notification_email from enterprise_profile order by login_name")).rows)
      .toEqual([{ notification_email: "shared@example.test" }, { notification_email: "shared@example.test" }, { notification_email: null }]);
    expect((await pool.query("select batch_number,processed,manifest_digest from enterprise_batch_checkpoints where operation_id=$1", [input.operationId])).rows)
      .toEqual([{ batch_number: 0, processed: 3, manifest_digest: hash(readFileSync(input.manifestPath)) }]);
    expect((await stored()).account).toEqual([]); expect((await stored()).session).toEqual([]);
    const client = await pool.connect();
    try { expect((await checkActorReservationCoverage(client, { scope: SCOPE })).complete).toBe(true); }
    finally { client.release(); }
  });
});

describe("approved provision manifest (FS-05)", () => {
  it("defaults only display/notification data and preserves exact identity bytes", () => {
    expect(parseProvisionManifest(manifest())).toEqual([{
      tenantKey: "tenant_mock_megaui", appId: "cli_mock_megaui", openId: "ou_mock_alice",
      loginName: "alice", displayName: "alice", notificationEmail: null,
    }]);
    expect(parseProvisionManifest(manifest([member({ display_name: null })]))[0]?.displayName).toBe("alice");
    expect(parseProvisionManifest(manifest([member({ display_name: "😀".repeat(256) })]))).toHaveLength(1);
    expect(parseProvisionManifest(manifest(Array.from({ length: 100 }, (_, i) =>
      member({ open_id: "ou_" + i, login_name: "alias" + i }))))).toHaveLength(100);
  });
  it("rejects malformed UTF-8, unknown fields, duplicate identities/aliases and all bounds", () => {
    const invalid = [
      Buffer.from([255]), Buffer.from("{"), Buffer.alloc(1024 * 1024 + 1, 32),
      manifest([], {}), manifest([member()], { ignored: true }),
      manifest([member({ local_user_id: "caller-owned" })]), manifest([member({ role: "admin" })]),
      manifest([member({ department_ids: ["override"] })]), manifest([member({ open_id: "" })]),
      manifest([member({ open_id: String.fromCharCode(0) })]), manifest([member({ tenant_key: String.fromCharCode(0xd800) })]),
      manifest([member({ open_id: "a".repeat(257) })]), manifest([member({ login_name: "Alice" })]),
      manifest([member({ display_name: "😀".repeat(257) })]),
      manifest([member({ notification_email: "" })]), manifest([member({ notification_email: "invalid" })]),
      manifest([member({ notification_email: "a".repeat(250) + "@test.invalid" })]),
      manifest([member(), member({ login_name: "other" })]),
      manifest([member(), member({ open_id: "different" })]),
      manifest(Array.from({ length: 101 }, (_, i) => member({ open_id: "ou_" + i, login_name: "alias" + i }))),
    ];
    for (const bytes of invalid) expect(() => parseProvisionManifest(bytes)).toThrow("INVALID_ARGUMENT");
  });
});
