// FS-70: synthetic actors, real isolated PostgreSQL and signed CLI transactions.
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { payloadDigest } from "../../cli/admin-payload";
import { deriveHistoricalActor, parseApprovedActorSnapshot, checkActorReservationCoverage } from "./actor-reservations";

const SCOPE = "fs70-instance";
const CLI = fileURLToPath(new URL("../../cli/enterprise-admin.ts", import.meta.url));
const SIGNER = fileURLToPath(new URL("../../cli/admin-approval.fixture-signer.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sourceBytes = (actors: { actor: string; owners: string[] }[] = [], observedAt = new Date(Date.now() - 10_000)) =>
  Buffer.from(JSON.stringify({ schemaVersion: 1, observedAt: observedAt.toISOString(), actors }));

describe("historical actor derivation (FS-70)", () => {
  it("preserves exact legacy bytes and Rust split_once/White_Space semantics", () => {
    expect(deriveHistoricalActor({ name: "  Ada  ", email: "ada@example.test" })).toBe("  Ada  ");
    expect(deriveHistoricalActor({ name: " \t", email: "  ada  @example.test" })).toBe("ada");
    expect(deriveHistoricalActor({ name: "", email: "not-an-email" })).toBeUndefined();
    expect(deriveHistoricalActor({ name: "\u0085", email: "\u0085ada\u0085@example.test" })).toBe("ada");
    expect(deriveHistoricalActor({ name: "\uFEFF", email: "ada@example.test" })).toBe("\uFEFF");
    expect(deriveHistoricalActor({ name: "", email: " @example.test" })).toBeUndefined();
  });
  it("uses the frozen actor even after name/email conversion", () => {
    expect(deriveHistoricalActor({ name: "new", email: "internal@identity.invalid",
      frozenBackendUsername: "frozen" })).toBe("frozen");
  });
});

describe("approved source decoding (FS-70)", () => {
  it("accepts the exact 24-hour boundary but rejects old/future sources", () => {
    const observed = new Date("2026-11-10T10:00:00.000Z");
    const bytes = sourceBytes([], observed);
    expect(parseApprovedActorSnapshot(bytes, new Date(observed.getTime() + 86_400_000)).actors).toEqual([]);
    expect(() => parseApprovedActorSnapshot(bytes, new Date(observed.getTime() + 86_400_001)))
      .toThrow("ACTOR_SOURCE_REJECTED");
    expect(() => parseApprovedActorSnapshot(bytes, new Date(observed.getTime() - 1)))
      .toThrow("ACTOR_SOURCE_REJECTED");
  });
  it("rejects malformed UTF-8, Unicode, dates, duplicate/empty owners and unknown fields", () => {
    const now = new Date("2026-11-10T10:01:00Z");
    const valid = { schemaVersion: 1, observedAt: "2026-11-10T10:00:00.000Z", actors: [] };
    const invalid = [
      Buffer.from([0xff]), Buffer.from('{"schemaVersion":1,"actors":[]}'),
      Buffer.from(JSON.stringify({ ...valid, ignored: true })),
      Buffer.from(JSON.stringify({ ...valid, observedAt: "2026-02-30T00:00:00.000Z" })),
      Buffer.from(JSON.stringify({ ...valid, actors: [{ actor: "a", owners: [] }] })),
      Buffer.from(JSON.stringify({ ...valid, actors: [{ actor: "a", owners: ["x", "x"] }] })),
      Buffer.from(JSON.stringify({ ...valid, actors: [{ actor: "\u0085", owners: ["x"] }] })),
      Buffer.from(JSON.stringify({ ...valid, actors: [{ actor: "\ud800", owners: ["x"] }] })),
      Buffer.from(JSON.stringify({ ...valid, actors: [{ actor: "a", owners: ["x"] }, { actor: "a", owners: ["y"] }] })),
    ];
    for (const bytes of invalid) expect(() => parseApprovedActorSnapshot(bytes, now)).toThrow("INVALID_ARGUMENT");
  });
});

describe("signed actor inventory command (FS-70)", () => {
  // Real PostgreSQL plus several signed CLI subprocesses exceed the 5s unit-test default on CI.
  const commandTest = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);
  let isolated: IsolatedPostgres;
  let pool: Pool;
  let directory: string;
  let keyPath: string;
  let publicPath: string;
  let clockPath: string;

  function command(bytes: Buffer, options: { operationId?: string; digest?: string; epoch?: number } = {}) {
    const operationId = options.operationId ?? randomUUID();
    const base = join(directory, randomUUID());
    const inputPath = base + "-source.json";
    const payloadPath = base + "-payload.json";
    const requestPath = base + "-request.json";
    const bundlePath = base + "-bundle.json";
    writeFileSync(inputPath, bytes);
    const digest = options.digest ?? hash(bytes);
    const epoch = options.epoch ?? 3;
    const payload = {
      verb: "reserve-actors", targetFingerprint: "megaui:" + SCOPE + ":test", deploymentRole: "test",
      operationId, expectedPolicyEpoch: epoch,
      args: { target: SCOPE, "operation-id": operationId, "expect-policy-epoch": epoch,
        upstream: inputPath, digest },
      inputFiles: { upstream: hash(bytes) },
    };
    writeFileSync(payloadPath, JSON.stringify({ schemaVersion: 1, ...payload }));
    writeFileSync(requestPath, JSON.stringify({
      schemaVersion: 1, approvalId: randomUUID(), approvedBy: "fs70-fixture-authority",
      issuedAt: Math.floor(Date.now() / 1000) - 60, expiresAt: Math.floor(Date.now() / 1000) + 172_800,
      operations: [{ verb: payload.verb, targetFingerprint: payload.targetFingerprint,
        deploymentRole: payload.deploymentRole, operationId, expectedPolicyEpoch: epoch,
        payloadDigest: payloadDigest(payload), manifestDigest: digest }],
      signature: "",
    }));
    const signed = spawnSync(process.execPath, ["--import", "tsx", SIGNER, keyPath, publicPath, requestPath, bundlePath],
      { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
    if (signed.status !== 0) throw new Error(signed.stderr || "FS-70 signer failed");
    const argv = ["reserve-actors", "--target", SCOPE, "--operation-id", operationId,
      "--expect-policy-epoch", String(epoch), "--upstream", inputPath, "--digest", digest,
      "--approval", bundlePath, "--approved-payload", payloadPath];
    return { operationId, bundlePath, inputPath, argv };
  }

  function run(input: ReturnType<typeof command>, args = input.argv, now?: number) {
    const child = spawnSync(process.execPath, ["--import", "tsx", ...(now === undefined ? [] : ["--import", clockPath]), CLI, ...args], {
      cwd: ROOT, encoding: "utf8", timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test",
        DATABASE_URL: isolated.databaseUrl, ENTERPRISE_APPROVAL_PUBLIC_KEY: readFileSync(publicPath, "utf8"),
        ENTERPRISE_DB_INSTANCE_ID: SCOPE, ENTERPRISE_PROCESS_ROLE: "test",
        ENTERPRISE_DEPLOYMENT_ROLE: "test", ENTERPRISE_OWNER_FINGERPRINT: "megaui",
        ...(now === undefined ? {} : { FS70_FIXTURE_NOW: String(now) }) },
    });
    if (child.error) throw child.error;
    return { code: child.status, stdout: child.stdout, stderr: child.stderr };
  }

  async function coverage(options: { now?: Date; expectedOwnershipDigest?: string; scope?: string } = {}) {
    const client = await pool.connect();
    try { return await checkActorReservationCoverage(client, { scope: SCOPE, ...options }); }
    finally { client.release(); }
  }

  async function stored() {
    const result: Record<string, unknown[]> = {};
    for (const table of ["enterprise_actor_inventory", "enterprise_actor_reservations",
      "enterprise_quarantine", "enterprise_admin_operations", "enterprise_batch_checkpoints"]) {
      result[table] = (await pool.query("select * from " + table + " order by 1")).rows;
    }
    return result;
  }

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    directory = realpathSync(mkdtempSync(join(tmpdir(), "megaui-fs70-")));
    keyPath = join(directory, "authority-private.pem");
    publicPath = join(directory, "authority-public.pem");
    clockPath = join(directory, "fixture-clock.mjs");
    writeFileSync(clockPath, "const NativeDate = Date; const fixed = Number(process.env.FS70_FIXTURE_NOW); " +
      "globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } };\n");
    const keys = generateKeyPairSync("ed25519");
    writeFileSync(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(publicPath, keys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  }, 120_000);

  beforeEach(async () => {
    await pool.query('delete from enterprise_actor_inventory; delete from enterprise_actor_reservations; ' +
      'delete from enterprise_batch_checkpoints; delete from enterprise_admin_operations; ' +
      'delete from enterprise_quarantine; delete from "user"; delete from enterprise_policy');
    await pool.query("insert into enterprise_policy (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state) " +
      "values ('fs70-policy', $1, 'megaui', 'test', 'test', 3, 'maintenance')", [SCOPE]);
    await pool.query('insert into "user" (id, name, email, email_verified) values ' +
      "('legacy', '  Ada  ', 'ada@example.test', false), " +
      "('migrated', 'Changed Name', 'internal@identity.invalid', false), " +
      "('quarantined', 'Quarantined', 'quarantine@example.test', false), " +
      "('collision-a', 'Collision', 'a@example.test', false), " +
      "('collision-b', 'Collision', 'b@example.test', false)");
    await pool.query("insert into enterprise_profile (user_id, tenant_key, login_name, backend_username) " +
      "values ('migrated', 'tenant', 'alias', 'frozen')");
    await pool.query("insert into enterprise_quarantine (id, user_id, reason) values ('q', 'quarantined', 'fixture')");
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    try { if (directory) rmSync(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FS-70 cleanup failed");
  });

  commandTest("merges all subjects, preserves frozen actors and quarantines, and reserves native actors", async () => {
    const input = command(sourceBytes([{ actor: "  Ada  ", owners: ["legacy"] }, { actor: "native", owners: ["native-owner"] }]));
    const result = run(input);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ resultCounts: { subjects: 5, reserved: 3, ambiguous: 1, unclaimable: 1 }, replayed: false });
    const rows = (await pool.query("select backend_username, actor_state, local_user_id, quarantined " +
      'from enterprise_actor_reservations order by backend_username collate "C"')).rows;
    expect(rows).toEqual([
      { backend_username: "  Ada  ", actor_state: "reserved", local_user_id: "legacy", quarantined: false },
      { backend_username: "Collision", actor_state: "ambiguous", local_user_id: null, quarantined: false },
      { backend_username: "Quarantined", actor_state: "reserved", local_user_id: "quarantined", quarantined: true },
      { backend_username: "frozen", actor_state: "reserved", local_user_id: "migrated", quarantined: false },
      { backend_username: "native", actor_state: "unclaimable", local_user_id: null, quarantined: false },
    ]);
    expect(await coverage()).toMatchObject({ complete: true, missingUserIds: [], staleActors: [] });
    expect(await coverage({ scope: "different-instance" })).toMatchObject({ complete: false });
    const inventory = (await pool.query("select * from enterprise_actor_inventory")).rows[0];
    expect(inventory).toMatchObject({ scope: SCOPE, operation_id: input.operationId, source_digest: hash(readFileSync(input.inputPath)) });
    expect((await pool.query("select user_id from enterprise_quarantine order by user_id")).rows)
      .toEqual([{ user_id: "collision-a" }, { user_id: "collision-b" }, { user_id: "quarantined" }]);
  });

  commandTest("requires a sealed inventory even for zero users and zero actors", async () => {
    await pool.query('delete from "user"');
    expect(await coverage()).toMatchObject({ complete: false });
    expect(run(command(sourceBytes())).code).toBe(0);
    expect(await coverage()).toMatchObject({ complete: true });
    expect(await coverage({ now: new Date(Date.now() + 86_400_000) })).toMatchObject({ complete: false });
  });

  commandTest("detects new normal or same-name subjects, and resealing changes migration ownership", async () => {
    expect(run(command(sourceBytes())).code).toBe(0);
    const original = await coverage();
    await pool.query('insert into "user" (id, name, email, email_verified) values ' +
      "('collision-c', 'Collision', 'c@example.test', false)");
    await pool.query("insert into enterprise_quarantine (id, user_id, reason) values ('new-q', 'collision-c', 'fixture')");
    // Every actor row already exists, and the new user is already quarantined:
    // only the sealed all-subject digest can detect the missing scan coverage.
    expect(await coverage()).toMatchObject({ complete: false, missingUserIds: [] });
    await pool.query('insert into "user" (id, name, email, email_verified) values ' +
      "('late', 'Late', 'late@example.test', false)");
    expect(await coverage()).toMatchObject({ complete: false, missingUserIds: ["late"] });
    expect(run(command(sourceBytes())).code).toBe(0);
    expect(await coverage()).toMatchObject({ complete: true });
    expect(await coverage({ expectedOwnershipDigest: original.ownershipDigest })).toMatchObject({ complete: false, ownershipMatches: false });
  });

  commandTest("quarantines empty actors without inventing names or dropping subjects", async () => {
    await pool.query('insert into "user" (id, name, email, email_verified) values ' +
      "('empty', '', '@example.test', false)");
    expect(run(command(sourceBytes())).code).toBe(0);
    expect((await pool.query("select state, reason from enterprise_quarantine where user_id = 'empty'")).rows)
      .toEqual([{ state: "quarantined", reason: "actor_missing" }]);
    expect(await coverage()).toMatchObject({ complete: true });
    await pool.query("delete from enterprise_quarantine where user_id = 'empty'");
    expect(await coverage()).toMatchObject({ complete: false });
  });

  commandTest("refreshes only metadata and keeps exact replay from overwriting a newer inventory", async () => {
    const actors = [{ actor: "native", owners: ["z", "a"] }, { actor: "  Ada  ", owners: ["legacy"] }];
    const firstObservedAt = new Date(Date.now() - 20_000);
    const first = command(sourceBytes(actors, firstObservedAt));
    const result = run(first);
    expect(result.code).toBe(0);
    const original = await coverage();
    const users = (await pool.query('select * from "user" order by id')).rows;
    const profiles = (await pool.query("select * from enterprise_profile order by user_id")).rows;
    const second = command(sourceBytes([{ actor: "  Ada  ", owners: ["legacy"] }, { actor: "native", owners: ["a", "z"] }]));
    expect(run(second).code).toBe(0);
    expect(await coverage({ expectedOwnershipDigest: original.ownershipDigest })).toMatchObject({ complete: true, ownershipMatches: true });
    expect((await pool.query('select * from "user" order by id')).rows).toEqual(users);
    expect((await pool.query("select * from enterprise_profile order by user_id")).rows).toEqual(profiles);
    const after = await stored();
    const replay = run(first);
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.stdout)).toEqual({ ...JSON.parse(result.stdout), replayed: true });
    expect(await stored()).toEqual(after);
    const changedOperation = command(sourceBytes(), { operationId: first.operationId });
    expect(run(changedOperation)).toEqual({ code: 3, stdout: "", stderr: "error: OPERATION_PAYLOAD_MISMATCH\n" });
    expect(await stored()).toEqual(after);
    const regressed = run(command(sourceBytes(actors, new Date(firstObservedAt.getTime() - 1_000))));
    expect(regressed).toEqual({ code: 3, stdout: "", stderr: "error: ACTOR_SOURCE_REJECTED\n" });
    expect(await stored()).toEqual(after);
  });

  commandTest("invalidates an existing migration digest when upstream ownership changes and retains permanent names", async () => {
    expect(run(command(sourceBytes([{ actor: "native", owners: ["first-owner"] }]))).code).toBe(0);
    const original = await coverage();
    expect(run(command(sourceBytes([{ actor: "native", owners: ["next-owner"] }]))).code).toBe(0);
    expect(await coverage({ expectedOwnershipDigest: original.ownershipDigest })).toMatchObject({ complete: false, ownershipMatches: false });
    expect(run(command(sourceBytes())).code).toBe(0);
    expect((await pool.query("select actor_state from enterprise_actor_reservations where backend_username = 'native'")).rows)
      .toEqual([{ actor_state: "unclaimable" }]);
    expect((await pool.query("select state from enterprise_quarantine where user_id = 'quarantined'")).rows)
      .toEqual([{ state: "quarantined" }]);
  });

  commandTest("replays a committed operation after source expiry but rejects a new operation using the expired source", async () => {
    const bytes = sourceBytes();
    const original = command(bytes);
    const first = run(original);
    expect(first.code).toBe(0);
    const after = await stored();
    const later = Date.now() + 86_400_001;
    const replay = run(original, original.argv, later);
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.stdout)).toEqual({ ...JSON.parse(first.stdout), replayed: true });
    expect(await stored()).toEqual(after);
    expect(await coverage({ now: new Date(later) })).toMatchObject({ complete: false });
    const renewal = command(bytes);
    expect(run(renewal, renewal.argv, later)).toEqual({ code: 3, stdout: "", stderr: "error: ACTOR_SOURCE_REJECTED\n" });
    expect(await stored()).toEqual(after);
  });

  commandTest("emits an approval request with exact source bytes and no business writes", async () => {
    const input = command(sourceBytes());
    const output = join(directory, randomUUID() + "-emit.json");
    const before = await stored();
    expect(run(input, [...input.argv.slice(0, -4), "--out", output, "--emit-approval-request"]).code).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ verb: "reserve-actors",
      inputFiles: { upstream: hash(readFileSync(input.inputPath)) } });
    expect(await stored()).toEqual(before);
  });

  commandTest("fails coverage closed for malformed stored source, row tampering and deleted reservations", async () => {
    expect(run(command(sourceBytes())).code).toBe(0);
    await pool.query("update enterprise_actor_inventory set upstream_actors = '[{}]'::jsonb");
    expect(await coverage()).toMatchObject({ complete: false });
    expect(run(command(sourceBytes())).code).toBe(0);
    await pool.query("update enterprise_actor_reservations set source_snapshot_digest = $1 where backend_username = 'frozen'", ["f".repeat(64)]);
    expect(await coverage()).toMatchObject({ complete: false });
    expect(run(command(sourceBytes())).code).toBe(0);
    await pool.query("delete from enterprise_actor_reservations where backend_username = 'frozen'");
    expect(await coverage()).toMatchObject({ complete: false, missingUserIds: ["migrated"] });
  });

  commandTest("does not repair an unknown persisted state into a claimable reservation", async () => {
    expect(run(command(sourceBytes())).code).toBe(0);
    await pool.query("update enterprise_actor_reservations set actor_state = 'invalid' where backend_username = 'frozen'");
    const before = await stored();
    expect(run(command(sourceBytes()))).toEqual({ code: 4, stdout: "", stderr: "error: DEPENDENCY_FAILED\n" });
    expect(await stored()).toEqual(before);
    expect(await coverage()).toMatchObject({ complete: false });
  });

  commandTest("keeps a deleted owner's actor unclaimable when a new same-name user appears before rescanning", async () => {
    expect(run(command(sourceBytes())).code).toBe(0);
    await pool.query('delete from "user" where id = $1', ["legacy"]);
    expect((await pool.query("select actor_state, local_user_id from enterprise_actor_reservations where backend_username = '  Ada  '")).rows)
      .toEqual([{ actor_state: "reserved", local_user_id: null }]);
    await pool.query('insert into "user" (id, name, email, email_verified) values ($1,$2,$3,false)',
      ["replacement", "  Ada  ", "ada@example.test"]);
    // Even a newly approved source naming the replacement cannot release an old reservation.
    const actors = [{ actor: "  Ada  ", owners: ["replacement"] }];
    expect(run(command(sourceBytes(actors))).code).toBe(0);
    expect((await pool.query("select actor_state, local_user_id from enterprise_actor_reservations where backend_username = '  Ada  '")).rows)
      .toEqual([{ actor_state: "unclaimable", local_user_id: null }]);
    expect((await pool.query("select state, reason from enterprise_quarantine where user_id = 'replacement'")).rows)
      .toEqual([{ state: "quarantined", reason: "actor_conflict" }]);
    expect(run(command(sourceBytes(actors))).code).toBe(0);
    expect((await pool.query("select actor_state from enterprise_actor_reservations where backend_username = '  Ada  '")).rows)
      .toEqual([{ actor_state: "unclaimable" }]);
    expect(await coverage()).toMatchObject({ complete: true });
  });

  commandTest("rejects missing approval, stale/future inputs, malformed fields, digest mismatch and epoch conflicts without writes", async () => {
    const before = await stored();
    const cases = [
      { input: command(sourceBytes([], new Date(Date.now() - 86_400_001))), code: 3, key: "ACTOR_SOURCE_REJECTED" },
      { input: command(sourceBytes([], new Date(Date.now() + 86_400_000))), code: 3, key: "ACTOR_SOURCE_REJECTED" },
      { input: command(Buffer.from("{}")), code: 2, key: "INVALID_ARGUMENT" },
      { input: command(sourceBytes(), { digest: "a".repeat(64) }), code: 3, key: "APPROVAL_DIGEST_MISMATCH" },
      { input: command(sourceBytes(), { epoch: 2 }), code: 3, key: "EPOCH_CAS_MISMATCH" },
    ];
    for (const value of cases) {
      expect(run(value.input)).toEqual({ code: value.code, stdout: "", stderr: "error: " + value.key + "\n" });
      expect(await stored()).toEqual(before);
    }
    const unsigned = command(sourceBytes());
    const bundle = JSON.parse(readFileSync(unsigned.bundlePath, "utf8"));
    bundle.signature = Buffer.alloc(64).toString("base64");
    writeFileSync(unsigned.bundlePath, JSON.stringify(bundle));
    expect(run(unsigned)).toEqual({ code: 3, stdout: "", stderr: "error: APPROVAL_SIGNATURE_INVALID\n" });
    expect(await stored()).toEqual(before);
  });

  commandTest("rolls back a failure after a full batch and retries the same operation without partial progress", async () => {
    await pool.query('insert into "user" (id, name, email, email_verified) ' +
      "select 'bulk-' || n, 'bulk-' || n, 'bulk-' || n || '@example.test', false from generate_series(1,205) n");
    const input = command(sourceBytes());
    const before = await stored();
    await pool.query("create function fs70_fail_batch() returns trigger language plpgsql as $$ " +
      "begin if new.batch_number = 1 then raise exception 'synthetic batch failure'; end if; return new; end $$");
    await pool.query("create trigger fs70_fail_batch before insert on enterprise_batch_checkpoints for each row execute function fs70_fail_batch()");
    try {
      expect(run(input)).toEqual({ code: 4, stdout: "", stderr: "error: DEPENDENCY_FAILED\n" });
      expect(await stored()).toEqual(before);
    } finally {
      await pool.query("drop trigger fs70_fail_batch on enterprise_batch_checkpoints");
      await pool.query("drop function fs70_fail_batch()");
    }
    expect(run(input).code).toBe(0);
    expect(await coverage()).toMatchObject({ complete: true });
    const checkpoints = (await pool.query("select batch_number, processed from enterprise_batch_checkpoints order by batch_number")).rows;
    expect(checkpoints.length).toBeGreaterThanOrEqual(3);
    let previous = 0;
    for (const checkpoint of checkpoints) {
      expect(checkpoint.processed - previous).toBeGreaterThan(0);
      expect(checkpoint.processed - previous).toBeLessThanOrEqual(100);
      previous = checkpoint.processed;
    }
  });
});
