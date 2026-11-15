// FS-38: actual signed isolation/recovery CLI, dedicated PostgreSQL and real provider HTTP.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { payloadDigest, canonicalizeJson } from "../../cli/admin-payload";
import { runActorReservationMutation } from "./actor-reservations";
import { migrationUserVersion, migrationProfileDigest } from "./manifest";
import { createEnterpriseDirectoryStore } from "@megaui/database";
import { createEnterpriseEligibilityService, createPostgresAuthenticationEligibilityReader } from "./eligibility";
import { scopeHashOf, DirectoryReader } from "./feishu/directory";
import { FeishuTransport } from "./feishu/http";
import { FeishuTokenManager } from "./feishu/token";
import { reconcileDirectory } from "./directory-sync";
import { admitProvider } from "@megaui/core";
import { readMigrationSources, previewMigration } from "./migration-preview";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const CLI = fileURLToPath(new URL("../../cli/enterprise-admin.ts", import.meta.url));
const SIGNER = fileURLToPath(new URL("../../cli/admin-approval.fixture-signer.ts", import.meta.url));
const SCOPE = "fs38-instance", TENANT = "tenant_mock_megaui", APP = "cli_mock_megaui";
const expectation = { processRole: "test" as const, ownerFingerprint: "megaui", instanceId: SCOPE, environment: "test" };
const authority = { tenantKey: TENANT, appId: APP };
const directoryScope = { ...authority, departmentIds: ["od_mock_engineering", "od_mock_operations"] };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const mockIds = ["ou_mock_alice", "ou_mock_bob", "ou_mock_carol"];
type Runtime = { schemaVersion: number; baseUrl: string; runtimeFile?: string; appId: string;
  tenantKey: string; adminToken: string; appSecret: string };

describe("signed quarantine and repair (FS-38)", () => {
  let isolated: IsolatedPostgres, pool: Pool, directory: string, privatePath: string, publicPath: string;
  let mock: ChildProcess, runtimeFile: string, runtime: Runtime, receiver: Server, mass: Server, massOrigin: string;
  let provider: "mock" | "mass";
  let massMode = "normal", massCalls: string[] = [], providerSawBarrier = false;
  const massSecret = randomUUID(), massToken = randomUUID(), cliChildren = new Set<ChildProcess>();
  const scenario = (name: string, fn: () => Promise<void>) => it(name, fn, 90_000);

  async function listen(server: Server): Promise<string> {
    server.requestTimeout = 5000; server.headersTimeout = 3000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture HTTP startup timeout")), 5000);
      server.once("error", error => { clearTimeout(timer); reject(error); });
      server.listen(0, "127.0.0.1", () => { clearTimeout(timer); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture port");
    return "http://127.0.0.1:" + address.port;
  }
  async function close(server?: Server) {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture HTTP shutdown timeout")), 5000);
      server.close(error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
      server.closeAllConnections();
    });
  }
  async function exited(child: ChildProcess, ms: number) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise<boolean>(resolve => {
      const done = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { child.off("exit", done); resolve(false); }, ms);
      child.once("exit", done);
    });
  }
  async function stop(child?: ChildProcess) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    if (!await exited(child, 3000)) { child.kill("SIGKILL"); if (!await exited(child, 3000)) throw new Error("fixture child leaked"); }
  }
  async function control(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(runtime.baseUrl + path, { method, signal: AbortSignal.timeout(5000),
      headers: { authorization: "Bearer " + runtime.adminToken, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result: unknown = await response.json();
    if (!response.ok) throw new Error("mock fixture control rejected");
    return result;
  }
  async function state() {
    const result: Record<string, unknown> = {};
    for (const table of ["user", "session", "account", "enterprise_policy", "enterprise_identity", "enterprise_profile",
      "enterprise_quarantine", "enterprise_actor_inventory", "enterprise_actor_reservations", "enterprise_admin_operations", "enterprise_batch_checkpoints", "enterprise_directory_snapshots", "enterprise_directory_watermarks", "enterprise_directory_identity_watermarks"]) {
      result[table] = (await pool.query('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),\'[]\'::jsonb) as data from "' + table + '" t')).rows[0].data;
    }
    return result;
  }
  async function seal() {
    const inventory = Buffer.from(JSON.stringify({ schemaVersion: 1, observedAt: new Date(Date.now() - 1000).toISOString(), actors: [] }));
    const client = await pool.connect();
    try {
      await client.query("begin");
      await runActorReservationMutation({ verb: "reserve-actors", operationId: randomUUID(),
        args: { target: SCOPE, digest: hash(inventory) }, files: { names: () => ["upstream"], bytes: () => inventory } }, client);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }
  async function prepare(count = 3, source: "mock" | "mass" = "mock") {
    provider = source;
    await pool.query('truncate "user", enterprise_policy, enterprise_actor_inventory, enterprise_actor_reservations, ' +
      'enterprise_admin_operations, enterprise_batch_checkpoints, enterprise_directory_snapshots, enterprise_directory_watermarks, ' +
      'enterprise_directory_identity_watermarks cascade');
    await pool.query("insert into enterprise_policy(id,scope,owner_fingerprint,deployment_role,environment,auth_epoch,activation_state) " +
      "values ('policy',$1,'megaui','test','test',0,'enterprise')", [SCOPE]);
    for (let index = 0; index < count; index++) {
      const id = index < 2 ? ["历史-A", "历史-a"][index]! : "legacy-" + index;
      await pool.query('insert into "user"(id,name,email,email_verified,role,updated_at) ' +
        "values ($1,$2,$3,true,$4,'2026-11-11T01:02:03.123456Z')", [id, "Original " + index,
        "old-" + index + "@example.test", index === 0 ? "admin" : "user"]);
      await pool.query('insert into "session"(id,user_id,token,expires_at) values ($1,$2,$3,now()+interval \'1 day\')', ["session-" + index, id, randomUUID()]);
      await pool.query('insert into account(id,user_id,account_id,provider_id,password) values ($1,$2,$3,\'credential\',\'fixture-password-hash\')', ["account-" + index, id, id]);
      await pool.query("insert into enterprise_identity(id,local_user_id,tenant_key,app_id,open_id,union_id,status,identity_version) " +
        "values ($1,$2,$3,$4,$5,'old-union','active',1)", ["identity-" + index, id, TENANT, APP,
        source === "mock" ? mockIds[index] : "ou_mass_" + index]);
    }
    await seal();
    // Historical profiles freeze the actor established by the original user name.
    await pool.query("insert into enterprise_profile(user_id,tenant_key,login_name,backend_username,display_name,notification_email) " +
      "select local_user_id,$1,'alias-' || (row_number() over(order by local_user_id))::text,backend_username,'Frozen display','notice@example.test' " +
      "from enterprise_actor_reservations where actor_state='reserved'", [TENANT]);
    await seal(); await reconcile();
  }
  async function reconcile() {
    const generation = (await pool.query("select coalesce(max(generation),0)+1 as n from enterprise_directory_watermarks")).rows[0].n;
    if (provider === "mock") {
      const target = admitProvider({ enabled: true, provider: "simulator", role: "test", nodeEnv: "test", simulatorOrigin: runtime.baseUrl });
      if (!target) throw new Error("fixture provider target missing");
      const transport = new FeishuTransport({ target }), tokens = new FeishuTokenManager({ transport });
      const reader = new DirectoryReader({ transport, generation, getToken: credentials => tokens.getToken(credentials) });
      expect((await reconcileDirectory({ scope: directoryScope, store: createEnterpriseDirectoryStore(pool),
        readSnapshot: () => reader.read(directoryScope, { ...authority, appSecret: runtime.appSecret }) })).kind).toBe("applied");
      return;
    }
    const ids = (await pool.query("select open_id from enterprise_identity")).rows.map(row => row.open_id as string);
    await createEnterpriseDirectoryStore(pool).applyCompleteSnapshot({ ...authority, scopeHash: scopeHashOf(directoryScope),
      generation, observedAt: new Date(Date.now() - 1000), memberOpenIds: ids });
  }
  function eligibility(mode: "enterprise" | "maintenance" = "enterprise") {
    return createEnterpriseEligibilityService({ policyScope: SCOPE, authMode: mode, directoryScope,
      databaseReader: createPostgresAuthenticationEligibilityReader(pool),
      directoryReader: { tenantKey: TENANT, appId: APP, async read() { throw new Error("authentication cannot call provider"); } } });
  }
  async function manifest(verb: "quarantine" | "repair") {
    const users = (await pool.query('select id,name,email,email_verified as "emailVerified",banned,' +
      'to_char(updated_at at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') as "updatedAt" from "user" order by email')).rows;
    const selected = users.map((user, index) => ({ local_user_id: user.id as string, tenant_key: TENANT, app_id: APP,
      open_id: provider === "mock" ? mockIds[index]! : "ou_mass_" + String(user.name).split(" ").at(-1), login_name: "repaired-" + index,
      expected_user_version: migrationUserVersion(user), expected_identity_version: 0 }));
    if (verb === "quarantine") return selected.map(row => ({ local_user_id: row.local_user_id,
      expected_user_version: row.expected_user_version, reason: "approved private reason" }));
    const client = await pool.connect();
    try {
      const sources = await readMigrationSources(client, selected, SCOPE, authority);
      const quarantine = (await client.query("select user_id,operation_id from enterprise_quarantine")).rows;
      return selected.map(row => ({ ...row,
        expected_identity_version: sources.identities.find(value => value.local_user_id === row.local_user_id)?.identity_version ?? 0,
        expected_profile_digest: migrationProfileDigest(sources.profiles.find(value => value.user_id === row.local_user_id) ?? null),
        expected_quarantine_operation_id: quarantine.find(value => value.user_id === row.local_user_id)?.operation_id ?? randomUUID() }));
    } finally { client.release(); }
  }
  function command(verb: "quarantine" | "repair" | "reserve-actors", rows: unknown, options: { bytes?: Buffer; digest?: string; operationId?: string } = {}) {
    const content = options.bytes ?? Buffer.from(JSON.stringify(rows));
    const manifestDigest = options.digest ?? hash(verb === "reserve-actors" ? content : Buffer.from(canonicalizeJson(rows)));
    const operationId = options.operationId ?? randomUUID(), base = join(directory, randomUUID());
    const fileName = verb === "reserve-actors" ? "upstream" : "manifest";
    const manifestPath = base + "-manifest.json", payloadPath = base + "-payload.json", requestPath = base + "-request.json", bundlePath = base + "-bundle.json";
    writeFileSync(manifestPath, content);
    const payload = { verb, targetFingerprint: "megaui:" + SCOPE + ":test", deploymentRole: "test", operationId,
      expectedPolicyEpoch: 0, args: { target: SCOPE, "operation-id": operationId, "expect-policy-epoch": 0,
        [fileName]: manifestPath, digest: manifestDigest }, inputFiles: { [fileName]: hash(content) } };
    writeFileSync(payloadPath, JSON.stringify({ schemaVersion: 1, ...payload }));
    writeFileSync(requestPath, JSON.stringify({ schemaVersion: 1, approvalId: randomUUID(), approvedBy: "fs38-fixture",
      issuedAt: Math.floor(Date.now() / 1000) - 60, expiresAt: Math.floor(Date.now() / 1000) + 7200,
      operations: [{ verb, targetFingerprint: payload.targetFingerprint, deploymentRole: "test", operationId,
        expectedPolicyEpoch: 0, manifestDigest, payloadDigest: payloadDigest(payload) }], signature: "" }));
    const signer = spawnSync(process.execPath, ["--import", "tsx", SIGNER, privatePath, publicPath, requestPath, bundlePath], {
      cwd: ROOT, encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, NODE_ENV: "test" } });
    if (signer.error || signer.status !== 0) throw new Error("fixture signing failed");
    const baseArgs = [verb, "--target", SCOPE, "--operation-id", operationId, "--expect-policy-epoch", "0",
      "--" + fileName, manifestPath, "--digest", manifestDigest];
    return { operationId, manifestDigest, manifestPath, payloadPath, baseArgs, argv: [...baseArgs, "--approval", bundlePath, "--approved-payload", payloadPath] };
  }
  async function approvedSeal() {
    const input = command("reserve-actors", { schemaVersion: 1, observedAt: new Date(Date.now() - 1000).toISOString(), actors: [] });
    expect(await run(input)).toMatchObject({ code: 0, stderr: "" });
  }
  async function run(input: ReturnType<typeof command>, options: { args?: string[]; env?: NodeJS.ProcessEnv } = {}) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "", stderr = "", timedOut = false;
      const child = spawn(process.execPath, ["--import", "tsx", CLI, ...(options.args ?? input.argv)], {
        cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, NODE_ENV: "test", AUTH_MODE: "enterprise",
          DATABASE_URL: isolated.databaseUrl, ENTERPRISE_APPROVAL_PUBLIC_KEY: readFileSync(publicPath, "utf8"),
          ENTERPRISE_DB_INSTANCE_ID: SCOPE, ENTERPRISE_PROCESS_ROLE: "test", ENTERPRISE_DEPLOYMENT_ROLE: "test", ENTERPRISE_OWNER_FINGERPRINT: "megaui",
          FEISHU_PROVIDER: "simulator", FEISHU_SIMULATOR_ORIGIN: provider === "mock" ? runtime.baseUrl : massOrigin,
          FEISHU_APP_ID: APP, FEISHU_TENANT_KEY: TENANT, FEISHU_APP_SECRET: provider === "mock" ? runtime.appSecret : massSecret,
          FEISHU_DIRECTORY_DEPARTMENT_IDS: '["od_mock_engineering","od_mock_operations"]', ...options.env } });
      cliChildren.add(child);
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
      child.stdout.on("data", chunk => { stdout += String(chunk); if (stdout.length > 1024 * 1024) child.kill("SIGKILL"); });
      child.stderr.on("data", chunk => { stderr += String(chunk); if (stderr.length > 1024 * 1024) child.kill("SIGKILL"); });
      child.once("error", error => { clearTimeout(timer); cliChildren.delete(child); reject(error); });
      child.once("close", code => { clearTimeout(timer); cliChildren.delete(child);
        if (timedOut) reject(new Error("fixture CLI timeout")); else resolve({ code, stdout, stderr }); });
    });
  }
  async function rejectUnchanged(input: ReturnType<typeof command>, key: string, code: number, options: Parameters<typeof run>[1] = {}) {
    const before = await state();
    expect(await run(input, options)).toEqual({ code, stdout: "", stderr: "error: " + key + "\n" });
    expect(await state()).toEqual(before);
  }
  beforeAll(async () => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "megaui-fs38-")));
    privatePath = join(directory, "private.pem"); publicPath = join(directory, "public.pem");
    const keys = generateKeyPairSync("ed25519");
    writeFileSync(privatePath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(publicPath, keys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
    receiver = createServer((request, response) => { request.resume(); request.on("end", () => response.end("{}")); });
    const callback = await listen(receiver) + "/api/integrations/feishu/events";
    mock = spawn(process.execPath, ["--import", "tsx", join(ROOT, "apps/feishu-mock/src/index.ts")], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { NODE_ENV: "test", FEISHU_SIMULATOR_ENABLED: "1",
        FEISHU_SIMULATOR_PORT: "0", FEISHU_SIMULATOR_CALLBACK_URL: callback } });
    mock.stderr?.resume();
    const ready = await new Promise<{ baseUrl: string; runtimeFile: string }>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("mock startup timeout")), 15_000);
      mock.once("error", error => { clearTimeout(timer); reject(error); });
      mock.once("exit", () => { clearTimeout(timer); reject(new Error("mock exited before ready")); });
      mock.stdout?.on("data", chunk => {
        output += String(chunk); const end = output.indexOf("\n"); if (end < 0) return;
        clearTimeout(timer); try { resolve(JSON.parse(output.slice(0, end))); } catch { reject(new Error("invalid mock receipt")); }
      });
    });
    runtimeFile = ready.runtimeFile; runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
    expect(runtime).toMatchObject({ schemaVersion: 1, baseUrl: ready.baseUrl, tenantKey: TENANT, appId: APP });
    isolated = await createIsolatedPostgres(); await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl }); pool.on("error", () => {});
    // This separate fixture is not an extension of the frozen three-member Mock.
    mass = createServer((request, response) => {
      request.setTimeout(massMode === "slow" ? 10000 : 5000, () => request.destroy());
      let body = ""; request.on("data", chunk => { body += String(chunk); if (body.length > 2048) request.destroy(); });
      request.on("end", () => { void (async () => {
        const url = new URL(request.url ?? "/", massOrigin); massCalls.push(url.pathname);
        const locks = await pool.query("select count(*)::int as n from pg_locks where mode='ShareLock' and granted and relation='enterprise_identity'::regclass");
        providerSawBarrier ||= locks.rows[0].n > 0;
        response.setHeader("content-type", "application/json");
        if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal" && request.method === "POST") {
          const input: unknown = JSON.parse(body);
          if (JSON.stringify(input) !== JSON.stringify({ app_id: APP, app_secret: massSecret })) { response.writeHead(403); response.end("{}"); return; }
          response.end(JSON.stringify({ code: 0, tenant_access_token: massToken, expire: 7200 })); return;
        }
        const id = url.pathname.split("/").at(-1);
        if (request.headers.authorization !== "Bearer " + massToken || request.method !== "GET" ||
          !/^ou_mass_\d+$/.test(id ?? "") || url.searchParams.get("user_id_type") !== "open_id") { response.writeHead(403); response.end("{}"); return; }
        if (massMode === "network") { response.writeHead(503); response.end('{"code":999}'); return; }
        if (massMode === "slow" && id === "ou_mass_0") await new Promise(resolve => setTimeout(resolve, 6000));
        if (massMode === "expires" && id === "ou_mass_2") {
          await pool.query("update enterprise_directory_snapshots set observed_at=now()-interval '14 minutes 59 seconds'");
        }
        const user = { open_id: id, department_ids: massMode === "department" ? ["outside"] : ["od_mock_engineering"],
          status: { is_activated: true, is_frozen: false, is_resigned: massMode === "inactive", is_exited: false } };
        response.end(JSON.stringify({ code: 0, data: { user: massMode === "malformed" ? { open_id: id } : user } }));
      })().catch(() => { response.writeHead(500); response.end("{}"); }); });
    });
    massOrigin = await listen(mass);
  }, 120_000);
  beforeEach(async () => {
    await control("/__mock/reset", {}); massMode = "normal"; massCalls = []; providerSawBarrier = false;
    await pool.query("drop trigger if exists fs38_failure on enterprise_identity; drop function if exists fs38_failure()");
    await prepare();
  }, 30_000);
  afterAll(async () => {
    const failures: unknown[] = [];
    for (const cleanup of [async () => { for (const child of cliChildren) await stop(child); },
      () => stop(mock), () => close(receiver), () => close(mass), async () => { await pool?.end(); },
      async () => { await isolated?.destroy(); }, async () => { if (directory) rmSync(directory, { recursive: true, force: true }); }]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (runtimeFile && existsSync(runtimeFile)) failures.push(new Error("Mock runtime file leaked"));
    if (failures.length) throw new AggregateError(failures, "FS38 fixture cleanup failed");
  }, 120_000);

  scenario("quarantine and explicit repair preserve subjects and require reseal plus fresh reconciliation", async () => {
    expect(await eligibility().authenticationEligibility("历史-A", "identity-0", 0)).toBe(true);
    const before = await state(), quarantine = command("quarantine", await manifest("quarantine"));
    const result = await run(quarantine);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 1, operationId: quarantine.operationId, policyEpoch: 0,
      replayed: false, resultCounts: { quarantined: 3 } });
    expect(await eligibility().authenticationEligibility("历史-A", "identity-0", 0)).toBe(false);
    const isolatedState = await state();
    for (const table of ["user", "session", "account", "enterprise_policy", "enterprise_identity", "enterprise_profile", "enterprise_actor_inventory"])
      expect(isolatedState[table]).toEqual(before[table]);
    const repair = command("repair", await manifest("repair"));
    await rejectUnchanged(repair, "REPAIR_REJECTED", 3);
    await approvedSeal();
    const reserved = (await pool.query("select * from enterprise_actor_reservations order by backend_username")).rows;
    expect(await run(repair)).toMatchObject({ code: 0, stderr: "" });
    const after = await state();
    for (const table of ["user", "session", "account", "enterprise_policy"]) expect(after[table]).toEqual(before[table]);
    const profiles = (await pool.query("select * from enterprise_profile order by user_id")).rows;
    for (const profile of profiles) expect(profile).toMatchObject({ display_name: "Frozen display", notification_email: "notice@example.test" });
    const restored = (await pool.query("select * from enterprise_actor_reservations order by backend_username")).rows;
    expect(restored.map(({ quarantined: _flag, updated_at: _time, ...row }) => row))
      .toEqual(reserved.map(({ quarantined: _flag, updated_at: _time, ...row }) => row));
    expect(restored.every(row => row.quarantined === false)).toBe(true);
    expect(await eligibility().authenticationEligibility("历史-A", "identity-0", 0)).toBe(false);
    await reconcile();
    expect(await eligibility().authenticationEligibility("历史-A", "identity-0", 0)).toBe(true);
    const current = await state();
    for (const input of [quarantine, repair]) {
      const replay = await run(input, { env: { FEISHU_APP_SECRET: "", FEISHU_TENANT_KEY: "", FEISHU_PROVIDER: "invalid" } });
      expect(replay).toMatchObject({ code: 0, stderr: "" }); expect(JSON.parse(replay.stdout).replayed).toBe(true);
      expect(replay.stdout).not.toMatch(/affected|private reason|localUserId/);
      expect(await state()).toEqual(current);
    }
    await approvedSeal();
    const migrationMembers = (await manifest("repair")).map(row => {
      const { expected_profile_digest: _profile, expected_quarantine_operation_id: _quarantine, ...member } = row as Record<string, unknown>;
      return member;
    });
    expect((await previewMigration({ bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, members: migrationMembers })),
      databaseUrl: isolated.databaseUrl, expectation, authority, deadline: performance.now() + 30_000 })).status).toBe("ready");
    const ledgers = (await pool.query("select * from enterprise_admin_operations where verb in ('quarantine','repair') order by verb")).rows;
    for (const row of ledgers) {
      expect(row.expected_user_version).toBeNull(); expect(row.result.affected).toHaveLength(3);
      expect(row.result.affected.map((value: { row: number }) => value.row)).toEqual([1, 2, 3]);
    }
    expect((await pool.query("select batch_number,processed from enterprise_batch_checkpoints where operation_id=any($1::text[]) order by operation_id",
      [[quarantine.operationId, repair.operationId]])).rows).toEqual([{ batch_number: 0, processed: 3 }, { batch_number: 0, processed: 3 }]);
  });

  scenario("empty approved quarantine is a no-op and canonical mismatches fail before SQL", async () => {
    const input = command("quarantine", []), before = await state();
    expect(await run(input, { env: { FEISHU_APP_SECRET: "", FEISHU_PROVIDER: "invalid" } })).toMatchObject({ code: 0, stderr: "" });
    const after = await state();
    for (const table of Object.keys(before).filter(name => !["enterprise_admin_operations", "enterprise_batch_checkpoints"].includes(name))) expect(after[table]).toEqual(before[table]);
    expect((await pool.query("select result from enterprise_admin_operations where operation_id=$1", [input.operationId])).rows[0].result.affected).toEqual([]);
    for (const verb of ["quarantine", "repair"] as const) {
      await rejectUnchanged(command(verb, await manifest(verb), { digest: "f".repeat(64) }), "APPROVAL_MANIFEST_MISMATCH", 3,
        { env: { DATABASE_URL: "postgres://nobody@127.0.0.1:1/unavailable" } });
    }
  });

  scenario("maintenance-repair-does-not-login", async () => {
    await pool.query("update enterprise_policy set activation_state='maintenance'");
    expect(await run(command("quarantine", await manifest("quarantine")))).toMatchObject({ code: 0 });
    await approvedSeal();
    expect(await run(command("repair", await manifest("repair")), { env: { AUTH_MODE: "maintenance" } })).toMatchObject({ code: 0, stderr: "" });
    expect(await eligibility("maintenance").authenticationEligibility("历史-A", "identity-0", 0)).toBe(false);
    expect(await eligibility().authenticationEligibility("历史-A", "identity-0", 0)).toBe(false);
    await reconcile();
    expect(await eligibility().authenticationEligibility("历史-A", "identity-0", 0)).toBe(false);
    await pool.query("update enterprise_policy set activation_state='enterprise'");
    expect(await eligibility().authenticationEligibility("历史-A", "identity-0", 0)).toBe(true);
    expect(await eligibility("maintenance").authenticationEligibility("历史-A", "identity-0", 0)).toBe(false);
  });

  scenario("canonical emit, strict input and byte limits precede execution", async () => {
    const qRows = await manifest("quarantine"), input = command("quarantine", qRows), before = await state();
    const output = join(directory, randomUUID() + "-emit.json");
    const omittedDigest = input.baseArgs.slice(0, -2);
    expect(await run(input, { args: [...omittedDigest, "--emit-approval-request", "--out", output], env: { FEISHU_APP_SECRET: "" } }))
      .toEqual({ code: 0, stdout: "", stderr: "" });
    const request = JSON.parse(readFileSync(output, "utf8"));
    expect(request.manifestDigest).toBe(input.manifestDigest);
    expect(request.args.digest).toBe(input.manifestDigest);
    expect(request.inputFiles.manifest).toBe(hash(readFileSync(input.manifestPath)));
    expect(request.payloadDigest).toBe(payloadDigest(request));
    expect(await state()).toEqual(before);
    const repair = command("repair", await manifest("repair"));
    expect(await run(repair, { args: [...repair.baseArgs.slice(0, -2), "--emit-approval-request", "--out", output + ".missing"] }))
      .toEqual({ code: 2, stdout: "", stderr: "error: MISSING_ARGUMENT\n" });
    for (const verb of ["quarantine", "repair"] as const) {
      const rows = await manifest(verb), wrong = command(verb, rows, { digest: "f".repeat(64) });
      expect(await run(wrong, { args: [...wrong.baseArgs, "--emit-approval-request", "--out", output + verb],
        env: { DATABASE_URL: "postgres://nobody@127.0.0.1:1/unavailable" } }))
        .toEqual({ code: 3, stdout: "", stderr: "error: APPROVAL_MANIFEST_MISMATCH\n" });
      for (const bytes of [Buffer.alloc(1024 * 1024 + 1, 32), Buffer.from([0xff]), Buffer.from('[{}]')]) {
        const invalid = command(verb, rows, { bytes });
        await rejectUnchanged(invalid, "INVALID_ARGUMENT", 2, { env: { DATABASE_URL: "postgres://nobody@127.0.0.1:1/unavailable" } });
        expect(await run(invalid, { args: [...invalid.baseArgs, "--emit-approval-request", "--out", output + randomUUID()] }))
          .toEqual({ code: 2, stdout: "", stderr: "error: INVALID_ARGUMENT\n" });
      }
    }
    expect(await state()).toEqual(before);
  });

  scenario("quarantine does not require provider or inventory but checks original user versions", async () => {
    await pool.query("delete from enterprise_actor_inventory; delete from enterprise_actor_reservations");
    const rows = await manifest("quarantine");
    await rejectUnchanged(command("quarantine", rows.map(row => ({ ...row, expected_user_version: "f".repeat(64) }))), "QUARANTINE_REJECTED", 3);
    await rejectUnchanged(command("quarantine", [{ ...rows[0], local_user_id: "missing" }]), "QUARANTINE_REJECTED", 3);
    expect(await run(command("quarantine", rows), { env: { FEISHU_APP_SECRET: "", FEISHU_PROVIDER: "invalid" } }))
      .toMatchObject({ code: 0, stderr: "" });
    expect((await pool.query("select state from enterprise_quarantine")).rows).toEqual(Array(3).fill({ state: "quarantined" }));
  });

  scenario("repair compares every expected source and cannot release a newer quarantine", async () => {
    const first = command("quarantine", await manifest("quarantine"));
    expect(await run(first)).toMatchObject({ code: 0 }); await approvedSeal();
    const rows = await manifest("repair"), oldApproval = command("repair", rows);
    for (const change of [{ expected_user_version: "f".repeat(64) }, { expected_identity_version: 0 },
      { expected_profile_digest: "f".repeat(64) }, { expected_quarantine_operation_id: randomUUID() },
      { tenant_key: "foreign" }, { app_id: "foreign" }]) {
      await rejectUnchanged(command("repair", rows.map(row => ({ ...row, ...change }))), "REPAIR_REJECTED", 3);
    }
    const newer = command("quarantine", await manifest("quarantine"));
    expect(await run(newer)).toMatchObject({ code: 0 }); await approvedSeal();
    await rejectUnchanged(oldApproval, "REPAIR_REJECTED", 3);
    const current = await state();
    expect(await run(first)).toMatchObject({ code: 0 }); expect(await state()).toEqual(current);
    expect((await pool.query("select distinct operation_id from enterprise_quarantine")).rows).toEqual([{ operation_id: newer.operationId }]);
  });

  scenario("repair creates missing identity/profile and changes open ID without retaining its union ID", async () => {
    await pool.query("update enterprise_identity set open_id='ou_previous_alice' where id='identity-0'; " +
      "delete from enterprise_identity where id='identity-1'; delete from enterprise_profile where user_id='历史-a'");
    await seal();
    const before = await state();
    expect(await run(command("quarantine", await manifest("quarantine")))).toMatchObject({ code: 0 }); await approvedSeal();
    const input = command("repair", await manifest("repair"));
    expect(await run(input)).toMatchObject({ code: 0, stderr: "" });
    expect((await pool.query("select id,open_id,union_id,identity_version from enterprise_identity where local_user_id='历史-A'")).rows)
      .toEqual([{ id: "identity-0", open_id: "ou_mock_alice", union_id: null, identity_version: 2 }]);
    const created = (await pool.query("select * from enterprise_identity where local_user_id='历史-a'")).rows[0];
    expect(created.id).toMatch(/^[a-f0-9-]{36}$/); expect(created.identity_version).toBe(1);
    expect((await pool.query("select display_name,notification_email,backend_username from enterprise_profile where user_id='历史-a'")).rows)
      .toEqual([{ display_name: "Original 1", notification_email: null, backend_username: "Original 1" }]);
    expect((await pool.query("select union_id from enterprise_identity where id='identity-2'")).rows[0].union_id).toBe("old-union");
    const after = await state();
    for (const table of ["user", "session", "account", "enterprise_policy"]) expect(after[table]).toEqual(before[table]);
  });

  scenario("repair rejects occupied bindings, cross-scope identities, multiple identities and overflow", async () => {
    expect(await run(command("quarantine", await manifest("quarantine")))).toMatchObject({ code: 0 }); await approvedSeal();
    const rows = await manifest("repair");
    await rejectUnchanged(command("repair", [{ ...rows[0], open_id: "ou_mock_bob" }]), "REPAIR_REJECTED", 3);
    const occupied = (await pool.query("select login_name from enterprise_profile where user_id='历史-a'")).rows[0].login_name;
    await rejectUnchanged(command("repair", [{ ...rows[0], login_name: occupied }]), "REPAIR_REJECTED", 3);
    await pool.query("update enterprise_identity set app_id='foreign' where id='identity-0'");
    await rejectUnchanged(command("repair", rows), "REPAIR_REJECTED", 3);
    await pool.query("update enterprise_identity set app_id=$1 where id='identity-0'", [APP]);
    await pool.query("insert into enterprise_identity(id,local_user_id,tenant_key,app_id,open_id) values ('extra','历史-A','foreign','foreign','foreign')");
    await rejectUnchanged(command("repair", rows), "REPAIR_REJECTED", 3);
    await pool.query("delete from enterprise_identity where id='extra'; update enterprise_identity set identity_version=2147483647 where id='identity-0'");
    await rejectUnchanged(command("repair", await manifest("repair")), "REPAIR_REJECTED", 3);
  });

  scenario("repair rejects absent, incomplete, future, infinite, stale and foreign directory snapshots", async () => {
    expect(await run(command("quarantine", await manifest("quarantine")))).toMatchObject({ code: 0 }); await approvedSeal();
    const input = command("repair", await manifest("repair"));
    for (const sql of ["complete=false", "observed_at=now()+interval '1 hour'", "observed_at='infinity'", "observed_at=now()-interval '16 minutes'"]) {
      await pool.query("update enterprise_directory_snapshots set " + sql);
      await rejectUnchanged(input, "REPAIR_REJECTED", 3);
      await pool.query("update enterprise_directory_snapshots set complete=true,observed_at=now()-interval '1 second'");
    }
    await pool.query("update enterprise_directory_watermarks set scope_hash='foreign'");
    await rejectUnchanged(input, "REPAIR_REJECTED", 3);
    await pool.query("delete from enterprise_directory_watermarks");
    await rejectUnchanged(input, "REPAIR_REJECTED", 3);
  });

  scenario("one hundred approved rows share one batch and provider calls precede source locks", async () => {
    await prepare(100, "mass");
    const input = command("quarantine", await manifest("quarantine"));
    expect(await run(input)).toMatchObject({ code: 0 }); await approvedSeal();
    const repair = command("repair", await manifest("repair")), result = await run(repair);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout).resultCounts).toEqual({ repaired: 100 });
    expect(massCalls.filter(path => path.includes("/contact/"))).toHaveLength(100);
    expect(providerSawBarrier).toBe(false);
    expect((await pool.query("select batch_number,processed from enterprise_batch_checkpoints where operation_id=$1", [repair.operationId])).rows)
      .toEqual([{ batch_number: 0, processed: 100 }]);
    expect((await pool.query("select jsonb_array_length(result->'affected') as n from enterprise_admin_operations where operation_id=$1", [repair.operationId])).rows[0].n).toBe(100);
  });

  scenario("provider denial is a business rejection and a later SQL failure rolls back the whole batch", async () => {
    await prepare(3, "mass");
    expect(await run(command("quarantine", await manifest("quarantine")))).toMatchObject({ code: 0 }); await approvedSeal();
    const input = command("repair", await manifest("repair"));
    for (const mode of ["department", "inactive", "malformed", "network"]) {
      massMode = mode; await rejectUnchanged(input, "REPAIR_REJECTED", 3);
    }
    massMode = "normal";
    await pool.query("create function fs38_failure() returns trigger language plpgsql as $$ begin " +
      "if NEW.local_user_id='历史-a' then raise exception 'fixture-private-error'; end if; return NEW; end $$; " +
      "create trigger fs38_failure before update on enterprise_identity for each row execute function fs38_failure()");
    await rejectUnchanged(input, "DEPENDENCY_FAILED", 4);
    expect(providerSawBarrier).toBe(false);
  });

  scenario("holds the complete source barrier through SQL writes and preserves shorter server budgets", async () => {
    expect(await run(command("quarantine", await manifest("quarantine")))).toMatchObject({ code: 0 }); await approvedSeal();
    const input = command("repair", await manifest("repair"));
    await pool.query("create function fs38_failure() returns trigger language plpgsql as $$ begin " +
      "if current_setting('transaction_isolation') <> 'read committed' or " +
      "current_setting('statement_timeout')::interval > interval '5 seconds' or " +
      "current_setting('lock_timeout')::interval > interval '5 seconds' or " +
      "current_setting('idle_in_transaction_session_timeout')::interval > interval '5 seconds' " +
      "then raise exception 'unbounded transaction'; end if; perform pg_advisory_xact_lock(838038); return NEW; end $$; " +
      "create trigger fs38_failure before update on enterprise_identity for each row execute function fs38_failure()");
    const gate = await pool.connect(); let pending: ReturnType<typeof run> | undefined, completed: Awaited<ReturnType<typeof run>> | undefined;
    try {
      await gate.query("begin; select pg_advisory_xact_lock(838038)"); pending = run(input);
      const deadline = performance.now() + 4000; let waiting = false;
      while (performance.now() < deadline) {
        waiting = (await pool.query("select exists(select 1 from pg_stat_activity where wait_event='advisory' and pid<>pg_backend_pid()) as waiting")).rows[0].waiting;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
      for (const table of ["user", "enterprise_profile", "enterprise_quarantine", "enterprise_actor_reservations", "enterprise_identity",
        "enterprise_actor_inventory", "enterprise_policy", "enterprise_directory_snapshots", "enterprise_directory_watermarks"]) {
        const writer = await pool.connect();
        try {
          await writer.query("set lock_timeout='100ms'");
          const column = table === "enterprise_actor_inventory" || table === "enterprise_policy" ? "scope" :
            table === "enterprise_profile" ? "user_id" : "id";
          await expect(writer.query('update "' + table + '" set "' + column + '"="' + column + '"')).rejects.toMatchObject({ code: "55P03" });
        } finally { await writer.query("reset lock_timeout"); writer.release(); }
      }
    } finally { await gate.query("rollback"); gate.release(); completed = await pending; }
    expect(completed).toMatchObject({ code: 0, stderr: "" });
  });

  scenario("URL client and server timeouts remain bounded and SQL timeout leaves no partial quarantine", async () => {
    const input = command("quarantine", await manifest("quarantine"));
    await pool.query("create function fs38_failure() returns trigger language plpgsql as $$ begin perform pg_sleep(8); return NEW; end $$; " +
      "create trigger fs38_failure before insert on enterprise_quarantine for each row execute function fs38_failure()");
    try {
      for (const limit of [20000, 200]) {
        const url = new URL(isolated.databaseUrl); url.searchParams.set("query_timeout", String(limit));
        url.searchParams.set("options", "-c statement_timeout=20000 -c lock_timeout=20000 -c idle_in_transaction_session_timeout=20000");
        const start = performance.now();
        await rejectUnchanged(input, "DEPENDENCY_FAILED", 4, { env: { DATABASE_URL: url.toString() } });
        expect(performance.now() - start).toBeLessThan(limit === 200 ? 6500 : 8500);
      }
      const short = new URL(isolated.databaseUrl); short.searchParams.set("options", "-c statement_timeout=150");
      const start = performance.now(); await rejectUnchanged(input, "DEPENDENCY_FAILED", 4, { env: { DATABASE_URL: short.toString() } });
      expect(performance.now() - start).toBeLessThan(3000);
    } finally { await pool.query("drop trigger fs38_failure on enterprise_quarantine; drop function fs38_failure()"); }
  });

  scenario("slow provider admission finishes before the five second idle transaction budget begins", async () => {
    await prepare(3, "mass");
    expect(await run(command("quarantine", await manifest("quarantine")))).toMatchObject({ code: 0 }); await approvedSeal();
    massMode = "slow";
    const url = new URL(isolated.databaseUrl); url.searchParams.set("options", "-c idle_in_transaction_session_timeout=20000");
    expect(await run(command("repair", await manifest("repair")), { env: { DATABASE_URL: url.toString() } })).toMatchObject({ code: 0, stderr: "" });
    expect(providerSawBarrier).toBe(false);
  });

  scenario("directory freshness is checked again after writes and checkpoint", async () => {
    await prepare(3, "mass");
    expect(await run(command("quarantine", await manifest("quarantine")))).toMatchObject({ code: 0 }); await approvedSeal();
    const input = command("repair", await manifest("repair"));
    await pool.query("create function fs38_failure() returns trigger language plpgsql as $$ begin perform pg_sleep(0.5); return NEW; end $$; " +
      "create trigger fs38_failure before update on enterprise_identity for each row execute function fs38_failure()");
    massMode = "expires";
    const before = await state();
    expect(await run(input)).toEqual({ code: 3, stdout: "", stderr: "error: REPAIR_REJECTED\n" });
    const after = await state();
    // The independent provider fixture deliberately ages the snapshot before the
    // writer locks it; every business/ledger row must nevertheless roll back.
    for (const table of Object.keys(before).filter(name => name !== "enterprise_directory_snapshots")) expect(after[table]).toEqual(before[table]);
  });

  scenario("a failed quarantine row rolls back earlier rows and every audit/checkpoint", async () => {
    const input = command("quarantine", await manifest("quarantine"));
    await pool.query("create function fs38_failure() returns trigger language plpgsql as $$ begin " +
      "if NEW.user_id='历史-a' then raise exception 'fixture-private-error'; end if; return NEW; end $$; " +
      "create trigger fs38_failure before insert on enterprise_quarantine for each row execute function fs38_failure()");
    try {
      await rejectUnchanged(input, "DEPENDENCY_FAILED", 4);
      await pool.query("create or replace function fs38_failure() returns trigger language plpgsql as $$ begin " +
        "if NEW.user_id='历史-a' then return null; end if; return NEW; end $$");
      await rejectUnchanged(input, "QUARANTINE_REJECTED", 3);
    }
    finally { await pool.query("drop trigger fs38_failure on enterprise_quarantine; drop function fs38_failure()"); }
  });

  scenario("repair refuses stale, missing and permanently ambiguous actor inventory", async () => {
    expect(await run(command("quarantine", await manifest("quarantine")))).toMatchObject({ code: 0 }); await approvedSeal();
    const input = command("repair", await manifest("repair"));
    await pool.query("update enterprise_actor_inventory set observed_at=now()-interval '25 hours'");
    await rejectUnchanged(input, "REPAIR_REJECTED", 3); await approvedSeal();
    await pool.query("update enterprise_actor_reservations set actor_state='ambiguous',local_user_id=null,quarantined=false where backend_username='Original 0'");
    await rejectUnchanged(input, "REPAIR_REJECTED", 3);
    await pool.query("delete from enterprise_actor_inventory");
    await rejectUnchanged(input, "REPAIR_REJECTED", 3);
  });

  scenario("ordinary audit writing cannot carry a repair past directory expiry", async () => {
    await prepare(3, "mass");
    expect(await run(command("quarantine", await manifest("quarantine")))).toMatchObject({ code: 0 }); await approvedSeal();
    const input = command("repair", await manifest("repair"));
    await pool.query("create function fs38_failure() returns trigger language plpgsql as $$ begin " +
      "if NEW.verb='repair' then perform pg_sleep(2); end if; return NEW; end $$; " +
      "create trigger fs38_failure before insert on enterprise_admin_operations for each row execute function fs38_failure()");
    massMode = "expires";
    const before = await state();
    try {
      expect(await run(input)).toEqual({ code: 3, stdout: "", stderr: "error: REPAIR_REJECTED\n" });
      const after = await state();
      for (const table of Object.keys(before).filter(name => name !== "enterprise_directory_snapshots")) expect(after[table]).toEqual(before[table]);
    } finally { await pool.query("drop trigger fs38_failure on enterprise_admin_operations; drop function fs38_failure()"); }
  });
});
