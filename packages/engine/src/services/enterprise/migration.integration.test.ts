// FS-06: actual signed CLI, real PostgreSQL, frozen three-member Mock and separate mass HTTP fixture.
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
import { payloadDigest } from "../../cli/admin-payload";
import { runActorReservationMutation } from "./actor-reservations";
import { migrationUserVersion } from "./manifest";
import { previewMigration } from "./migration-preview";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const CLI = fileURLToPath(new URL("../../cli/enterprise-admin.ts", import.meta.url));
const SIGNER = fileURLToPath(new URL("../../cli/admin-approval.fixture-signer.ts", import.meta.url));
const SCOPE = "fs06-instance", TENANT = "tenant_mock_megaui", APP = "cli_mock_megaui";
const expectation = { processRole: "test" as const, ownerFingerprint: "megaui", instanceId: SCOPE, environment: "test" };
const authority = { tenantKey: TENANT, appId: APP };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const mockIds = ["ou_mock_alice", "ou_mock_bob", "ou_mock_carol"];
type Runtime = { schemaVersion: number; baseUrl: string; runtimeFile?: string; appId: string;
  tenantKey: string; adminToken: string; appSecret: string };

describe("signed historical apply (FS-06)", () => {
  let isolated: IsolatedPostgres, pool: Pool, directory: string, privatePath: string, publicPath: string;
  let mock: ChildProcess, runtimeFile: string, runtime: Runtime, receiver: Server, mass: Server, massOrigin: string;
  let bytes: Buffer, digest: string, provider: "mock" | "mass";
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
      "enterprise_quarantine", "enterprise_actor_inventory", "enterprise_actor_reservations", "enterprise_admin_operations", "enterprise_batch_checkpoints"]) {
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
      'enterprise_admin_operations, enterprise_batch_checkpoints cascade');
    await pool.query("insert into enterprise_policy(id,scope,owner_fingerprint,deployment_role,environment,auth_epoch,activation_state) " +
      "values ('policy',$1,'megaui','test','test',0,'legacy')", [SCOPE]);
    for (let index = 0; index < count; index++) {
      const id = index < 2 ? ["历史-A", "历史-a"][index]! : "legacy-" + index;
      await pool.query('insert into "user"(id,name,email,email_verified,role,updated_at) ' +
        "values ($1,$2,$3,true,$4,'2026-11-11T01:02:03.123456Z')", [id, "  Original " + index + "  ",
        "old-" + index + "@example.test", index === 0 ? "admin" : "user"]);
      await pool.query('insert into "session"(id,user_id,token,expires_at) values ($1,$2,$3,now()+interval \'1 day\')', ["session-" + index, id, randomUUID()]);
      await pool.query('insert into account(id,user_id,account_id,provider_id,password) values ($1,$2,$3,\'credential\',\'fixture-password-hash\')', ["account-" + index, id, id]);
    }
    await seal(); await refreshManifest();
  }
  async function refreshManifest() {
    const users = (await pool.query('select id,name,email,email_verified as "emailVerified",banned,' +
      'to_char(updated_at at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') as "updatedAt" from "user" order by email')).rows;
    bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, members: users.map((user, index) => ({ local_user_id: user.id,
      tenant_key: TENANT, app_id: APP, open_id: provider === "mock" ? mockIds[index] : "ou_mass_" + index,
      login_name: "alias-" + index, expected_user_version: migrationUserVersion(user),
      expected_identity_version: 0 })) }));
    const report = await previewMigration({ bytes, databaseUrl: isolated.databaseUrl, expectation, authority,
      deadline: performance.now() + 30_000 });
    expect(report.status).toBe("ready"); digest = report.manifestDigest!;
  }
  function command(options: { bytes?: Buffer; digest?: string; batch?: number; operationId?: string } = {}) {
    const content = options.bytes ?? bytes, manifestDigest = options.digest ?? digest, batch = options.batch ?? 0;
    const operationId = options.operationId ?? randomUUID(), base = join(directory, randomUUID());
    const manifestPath = base + "-manifest.json", payloadPath = base + "-payload.json", requestPath = base + "-request.json", bundlePath = base + "-bundle.json";
    writeFileSync(manifestPath, content);
    const payload = { verb: "apply", targetFingerprint: "megaui:" + SCOPE + ":test", deploymentRole: "test", operationId,
      expectedPolicyEpoch: 0, args: { target: SCOPE, "operation-id": operationId, "expect-policy-epoch": 0,
        manifest: manifestPath, digest: manifestDigest, "batch-number": batch }, inputFiles: { manifest: hash(content) } };
    writeFileSync(payloadPath, JSON.stringify({ schemaVersion: 1, ...payload }));
    writeFileSync(requestPath, JSON.stringify({ schemaVersion: 1, approvalId: randomUUID(), approvedBy: "fs06-fixture",
      issuedAt: Math.floor(Date.now() / 1000) - 60, expiresAt: Math.floor(Date.now() / 1000) + 7200,
      operations: [{ verb: "apply", targetFingerprint: payload.targetFingerprint, deploymentRole: "test", operationId,
        expectedPolicyEpoch: 0, manifestDigest, payloadDigest: payloadDigest(payload) }], signature: "" }));
    const signer = spawnSync(process.execPath, ["--import", "tsx", SIGNER, privatePath, publicPath, requestPath, bundlePath], {
      cwd: ROOT, encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, NODE_ENV: "test" } });
    if (signer.error || signer.status !== 0) throw new Error("fixture signing failed");
    const baseArgs = ["apply", "--target", SCOPE, "--operation-id", operationId, "--expect-policy-epoch", "0",
      "--manifest", manifestPath, "--digest", manifestDigest, "--batch-number", String(batch)];
    return { operationId, manifestPath, payloadPath, baseArgs, argv: [...baseArgs, "--approval", bundlePath, "--approved-payload", payloadPath] };
  }
  async function run(input: ReturnType<typeof command>, options: { args?: string[]; env?: NodeJS.ProcessEnv } = {}) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "", stderr = "", timedOut = false;
      const child = spawn(process.execPath, ["--import", "tsx", CLI, ...(options.args ?? input.argv)], {
        cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, NODE_ENV: "test", AUTH_MODE: "legacy",
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
    directory = realpathSync(mkdtempSync(join(tmpdir(), "megaui-fs06-")));
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
      request.setTimeout(5000, () => request.destroy());
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
        const user = { open_id: id, department_ids: massMode === "department" ? ["outside"] : ["od_mock_engineering"],
          status: { is_activated: true, is_frozen: false, is_resigned: massMode === "inactive", is_exited: false } };
        response.end(JSON.stringify({ code: 0, data: { user: massMode === "malformed" ? { open_id: id } : user } }));
      })().catch(() => { response.writeHead(500); response.end("{}"); }); });
    });
    massOrigin = await listen(mass);
  }, 120_000);
  beforeEach(async () => {
    await control("/__mock/reset", {}); massMode = "normal"; massCalls = []; providerSawBarrier = false;
    await pool.query("drop trigger if exists fs06_failure on enterprise_identity; drop function if exists fs06_failure()");
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
    if (failures.length) throw new AggregateError(failures, "FS06 fixture cleanup failed");
  }, 120_000);

  scenario("legacy-prebind-preserves-user", async () => {
    const input = command(), before = await state(), result = await run(input);
    expect(result.stderr).toBe(""); expect(result.code).toBe(0);
    const members = JSON.parse(bytes.toString()).members as Array<{ local_user_id: string }>;
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 3, operationId: input.operationId, policyEpoch: 0,
      replayed: false, resultCounts: { bound: 3 }, applied: members.map((row, i) => ({ row: i + 1, localUserId: row.local_user_id })) });
    const after = await state();
    for (const table of ["user", "session", "account", "enterprise_policy", "enterprise_actor_inventory", "enterprise_actor_reservations"]) expect(after[table]).toEqual(before[table]);
    expect((await pool.query("select count(*)::int as n from enterprise_identity where status='active' and identity_version=1")).rows[0].n).toBe(3);
    expect((await pool.query('select p.display_name=u.name and p.notification_email is null as valid from enterprise_profile p join "user" u on u.id=p.user_id')).rows.every(row => row.valid)).toBe(true);
    expect((await pool.query("select operation_id,batch_number,processed from enterprise_batch_checkpoints where operation_id=$1", [input.operationId])).rows).toEqual([{ operation_id: input.operationId, batch_number: 0, processed: 3 }]);
  });
  scenario("replays the stored mapping without provider config, calls or current source reads", async () => {
    const input = command(), first = await run(input); expect(first.code).toBe(0);
    await pool.query('update "user" set name=\'changed after commit\' where id=$1', ["历史-A"]);
    await control("/__mock/faults", { target: "user", kind: "403", count: 1 });
    const mockState = await control("/__mock/state"), before = await state();
    const replay = await run(input, { env: { FEISHU_PROVIDER: undefined, FEISHU_SIMULATOR_ORIGIN: undefined,
      FEISHU_APP_SECRET: undefined, FEISHU_DIRECTORY_DEPARTMENT_IDS: undefined } });
    expect(replay.code).toBe(0); expect(JSON.parse(replay.stdout)).toEqual({ ...JSON.parse(first.stdout), replayed: true });
    expect(await state()).toEqual(before); expect(await control("/__mock/state")).toEqual(mockState);
  });
  scenario("preserves consistent existing identity and profile while adding only missing rows", async () => {
    const member = JSON.parse(bytes.toString()).members[0];
    await pool.query("insert into enterprise_identity(id,local_user_id,tenant_key,app_id,open_id,status,identity_version) values ('existing',$1,$2,$3,$4,'active',7)", [member.local_user_id, TENANT, APP, member.open_id]);
    await pool.query("insert into enterprise_profile(user_id,tenant_key,login_name,backend_username,display_name,notification_email) values ($1,$2,$3,$4,'frozen display','notify@example.test')", [member.local_user_id, TENANT, member.login_name, "  Original 0  "]);
    await seal();
    const document = JSON.parse(bytes.toString()); document.members[0].expected_identity_version = 7;
    bytes = Buffer.from(JSON.stringify(document));
    const report = await previewMigration({ bytes, databaseUrl: isolated.databaseUrl, expectation, authority, deadline: performance.now() + 30_000 });
    expect(report.status).toBe("ready"); digest = report.manifestDigest!;
    const before = await state(); expect((await run(command())).code).toBe(0);
    const after = await state();
    expect((after.enterprise_identity as Array<{ id: string }>).find(row => row.id === "existing")).toEqual((before.enterprise_identity as unknown[])[0]);
    expect((after.enterprise_profile as Array<{ user_id: string }>).find(row => row.user_id === member.local_user_id)).toEqual((before.enterprise_profile as unknown[])[0]);
  });
  scenario("retains the first 100 on second-batch SQL failure, then resumes the same full digest", async () => {
    await prepare(101, "mass"); const original = await state();
    const first = await run(command()); expect(first.code).toBe(0); expect(JSON.parse(first.stdout).applied).toHaveLength(100);
    expect(providerSawBarrier).toBe(false); expect(new Set(massCalls.filter(path => path.includes("/contact/"))).size).toBe(100);
    const document = JSON.parse(bytes.toString()), last = document.members[100];
    await pool.query("create function fs06_failure() returns trigger language plpgsql as $$ begin if new.open_id='ou_mass_100' then raise exception 'fixture SQL failure'; end if; return new; end $$; create trigger fs06_failure before insert on enterprise_identity for each row execute function fs06_failure()");
    await rejectUnchanged(command({ batch: 1 }), "DEPENDENCY_FAILED", 4);
    expect((await pool.query("select count(*)::int as n from enterprise_identity")).rows[0].n).toBe(100);
    await pool.query("drop trigger fs06_failure on enterprise_identity; drop function fs06_failure()");
    const recovered = await run(command({ batch: 1 })); expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout).applied).toEqual([{ row: 101, localUserId: last.local_user_id }]);
    const bound = await state();
    for (const table of ["user", "session", "account", "enterprise_policy"]) expect(bound[table]).toEqual(original[table]);
    const retry = await run(command({ batch: 0 })); expect(retry.code).toBe(0);
    expect(JSON.parse(retry.stdout).applied).toEqual(JSON.parse(first.stdout).applied);
    const replayed = await state();
    for (const table of ["user", "session", "account", "enterprise_identity", "enterprise_profile"]) expect(replayed[table]).toEqual(bound[table]);
    expect(providerSawBarrier).toBe(false);
    expect((await pool.query("select result from enterprise_admin_operations where verb='internal:migration-run:v1'")).rows[0].result.rows.every((row: { stage: string }) => row.stage === "bound")).toBe(true);
  });
  scenario("rejects full-manifest version/digest mismatches and poststate drift with zero writes", async () => {
    await rejectUnchanged(command({ digest: hash(bytes) }), "MIGRATION_REJECTED", 3);
    const document = JSON.parse(bytes.toString()); document.members[2].expected_identity_version = 1;
    await rejectUnchanged(command({ bytes: Buffer.from(JSON.stringify(document)) }), "MIGRATION_REJECTED", 3);
    await pool.query('update "user" set updated_at=updated_at+interval \'1 microsecond\' where id=$1', ["历史-A"]);
    await rejectUnchanged(command(), "MIGRATION_REJECTED", 3);
    await pool.query('update "user" set updated_at=updated_at-interval \'1 microsecond\' where id=$1', ["历史-A"]);
    expect((await run(command())).code).toBe(0);
    await pool.query("update enterprise_profile set notification_email='external@example.test' where user_id=$1", ["历史-A"]);
    await rejectUnchanged(command(), "MIGRATION_REJECTED", 3);
  });
  scenario("rejects nonselected manifest and global inventory drift before the second batch", async () => {
    await prepare(101, "mass"); expect((await run(command())).code).toBe(0);
    await pool.query('update "user" set updated_at=updated_at+interval \'1 microsecond\' where id=$1', ["历史-A"]);
    await rejectUnchanged(command({ batch: 1 }), "MIGRATION_REJECTED", 3);
    await pool.query('update "user" set updated_at=updated_at-interval \'1 microsecond\' where id=$1', ["历史-A"]);
    await pool.query('insert into "user"(id,name,email,email_verified) values (\'outside\',\'outside actor\',\'outside@example.test\',false)');
    await rejectUnchanged(command({ batch: 1 }), "MIGRATION_REJECTED", 3);
  });
  scenario("uses actual Mock admission and rejects missing, inactive and excluded members atomically", async () => {
    await rejectUnchanged(command(), "MIGRATION_REJECTED", 3, { env: { FEISHU_DIRECTORY_DEPARTMENT_IDS: '["outside"]' } });
    const missing = JSON.parse(bytes.toString()); missing.members[0].open_id = "ou_missing";
    await rejectUnchanged(command({ bytes: Buffer.from(JSON.stringify(missing)) }), "MIGRATION_REJECTED", 3);
    await control("/__mock/faults", { target: "user", kind: "403", count: 1 });
    await rejectUnchanged(command(), "MIGRATION_REJECTED", 3);
    await control("/__mock/users/ou_mock_alice", { status: "resigned" }, "PATCH");
    await rejectUnchanged(command(), "MIGRATION_REJECTED", 3);
  });
  scenario("treats a missing actor inventory as a business rejection with zero writes", async () => {
    await pool.query("delete from enterprise_actor_inventory where scope=$1", [SCOPE]);
    await rejectUnchanged(command(), "MIGRATION_REJECTED", 3);
  });
  scenario("fails closed for malformed and denied synthetic Contact HTTP responses", async () => {
    await prepare(1, "mass");
    for (const mode of ["inactive", "department", "malformed", "network"]) {
      massMode = mode; await rejectUnchanged(command(), "MIGRATION_REJECTED", 3);
    }
    expect(massCalls.some(path => path.includes("/auth/"))).toBe(true);
    expect(massCalls.some(path => path.includes("/contact/"))).toBe(true);
  });
  scenario("requires trusted configuration and a pinned full unique manifest and valid fixed batch", async () => {
    for (const env of [{ FEISHU_DIRECTORY_DEPARTMENT_IDS: undefined }, { FEISHU_APP_SECRET: undefined },
      { FEISHU_PROVIDER: "unknown" }, { AUTH_MODE: "invalid" }]) await rejectUnchanged(command(), "INVALID_CONFIG", 2, { env });
    const document = JSON.parse(bytes.toString()); document.members[1].open_id = document.members[0].open_id;
    await rejectUnchanged(command({ bytes: Buffer.from(JSON.stringify(document)) }), "INVALID_ARGUMENT", 2);
    for (const batch of [-1, 0.5, 1]) await rejectUnchanged(command({ batch }), "INVALID_ARGUMENT", 2);
    const input = command();
    await rejectUnchanged(input, "MISSING_ARGUMENT", 2, { args: input.argv.filter((_, i) => i !== input.argv.indexOf("--batch-number") && i !== input.argv.indexOf("--batch-number") + 1) });
    writeFileSync(input.manifestPath, Buffer.from(JSON.stringify({ schemaVersion: 1, members: [] })));
    await rejectUnchanged(input, "APPROVAL_DIGEST_MISMATCH", 3);
  });
  scenario("caps both write and emit reads at 10 MiB and keeps canonical digest distinct from file hash", async () => {
    const input = command({ bytes: Buffer.alloc(10 * 1024 * 1024 + 1, 32) });
    await rejectUnchanged(input, "INVALID_ARGUMENT", 2);
    const output = join(directory, randomUUID() + "-emit.json");
    await rejectUnchanged(input, "INVALID_ARGUMENT", 2, { args: [...input.baseArgs, "--emit-approval-request", "--out", output] });
    expect(existsSync(output)).toBe(false);
    const valid = command({ bytes: Buffer.from(JSON.stringify(JSON.parse(bytes.toString()), null, 2)) });
    const before = await state(), emitted = await run(valid, { args: [...valid.baseArgs, "--emit-approval-request", "--out", output],
      env: { FEISHU_APP_SECRET: undefined, FEISHU_PROVIDER: undefined, FEISHU_DIRECTORY_DEPARTMENT_IDS: undefined } });
    expect(emitted.code).toBe(0); expect(await state()).toEqual(before);
    const request = JSON.parse(readFileSync(output, "utf8"));
    expect(request.manifestDigest).toBe(digest); expect(request.inputFiles.manifest).not.toBe(digest);
    expect((await run(valid)).code).toBe(0);
  });
  scenario("validates complete input and batch bounds before emitting an approval request", async () => {
    const document = JSON.parse(bytes.toString()); document.members[1].local_user_id = document.members[0].local_user_id;
    for (const input of [command({ batch: 1 }), command({ bytes: Buffer.from(JSON.stringify(document)) })]) {
      const output = join(directory, randomUUID() + "-emit.json");
      await rejectUnchanged(input, "INVALID_ARGUMENT", 2, { args: [...input.baseArgs, "--emit-approval-request", "--out", output] });
      expect(existsSync(output)).toBe(false);
    }
  });
});
