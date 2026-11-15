// FS-81: real PostgreSQL and signed CLI coverage for approved mutations.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "@megaui/database/test-support";

import {
  clearRegisteredWriteHandlers,
  pinRegisteredVerb,
  registerGuardedWriteHandler,
  type ApprovalBundle,
  type ApprovalOperation,
  type GuardedWriteContext,
} from "./admin-approval";
import { trustedAdminEnv } from "./admin-env";
import { canonicalizeJson, payloadDigest } from "./admin-payload";
import { runApprovedMutation, ApprovedMutationRejection } from "./admin-mutation";
import { runEnterpriseAdmin } from "./enterprise-admin";

if (!(await isDockerAvailable())) {
  throw new Error("[@megaui/engine] FS-81 integration tests require Docker");
}

const SCOPE = "fs81-instance";
const OPERATION = "00000000-0000-4000-8000-000000000081";
const SIGNER = fileURLToPath(new URL("./admin-approval.fixture-signer.ts", import.meta.url));
const VERB = "fixture-write";
const GUARD = { approval: true as const, scope: true as const };

let isolated: IsolatedPostgres;
let pool: Pool;
let directory: string;
let keyPath: string;
let publicPath: string;

function publicPem(): string {
  return readFileSync(publicPath, "utf8");
}

const previousTrustedEnv = { ...process.env };

function applyEnv(overrides: NodeJS.ProcessEnv = {}): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ENTERPRISE_") || key === "DATABASE_URL") delete process.env[key];
  }
  Object.assign(process.env, cliEnv(), overrides);
}

function cliEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "test",
    DATABASE_URL: isolated.databaseUrl,
    ENTERPRISE_APPROVAL_PUBLIC_KEY: publicPem(),
    ENTERPRISE_DB_INSTANCE_ID: SCOPE,
    ENTERPRISE_PROCESS_ROLE: "test",
    ENTERPRISE_DEPLOYMENT_ROLE: "test",
    ENTERPRISE_OWNER_FINGERPRINT: "megaui",
  };
}

function payload(operationId = OPERATION, epoch = 3, note?: string) {
  return {
    schemaVersion: 1,
    verb: VERB,
    targetFingerprint: `megaui:${SCOPE}:test`,
    deploymentRole: "test",
    operationId,
    expectedPolicyEpoch: epoch,
    args: {
      target: SCOPE,
      "operation-id": operationId,
      "expect-policy-epoch": epoch,
      ...(note === undefined ? {} : { note }),
    },
    inputFiles: {},
  };
}
function operation(overrides: Partial<ApprovalOperation> = {}): ApprovalOperation {
  const body = payload();
  return {
    verb: VERB,
    targetFingerprint: body.targetFingerprint,
    deploymentRole: body.deploymentRole,
    operationId: body.operationId,
    payloadDigest: payloadDigest(body),
    manifestDigest: null,
    expectedPolicyEpoch: 3,
    ...overrides,
  };
}

function bundle(operations: ApprovalOperation[]): ApprovalBundle {
  const request = join(directory, `request-${Math.random().toString(16).slice(2)}.json`);
  const output = join(directory, `signed-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(request, JSON.stringify({
    schemaVersion: 1,
    approvalId: "fs81-approval",
    approvedBy: "fixture-authority",
    issuedAt: 1_700_000_000,
    expiresAt: 1_899_000_000,
    operations,
    signature: "",
  }));
  const signed = spawnSync(
    process.execPath,
    ["--import", "tsx", SIGNER, keyPath, publicPath, request, output],
    { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) },
  );
  if (signed.status !== 0) throw new Error(signed.stderr.toString() || "FS-81 signer failed");
  return JSON.parse(readFileSync(output, "utf8")) as ApprovalBundle;
}

function writeJson(value: unknown): string {
  const path = join(directory, `document-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function args(approval: ApprovalBundle, body = payload()): string[] {
  return [
    VERB,
    "--target", SCOPE,
    "--approval", writeJson(approval),
    "--approved-payload", writeJson(body),
    "--operation-id", body.operationId,
    "--expect-policy-epoch", String(body.expectedPolicyEpoch),
  ];
}

async function cli(approval: ApprovalBundle, body = payload(), env: NodeJS.ProcessEnv = {}) {
  applyEnv(env);
  const stderr: string[] = [];
  const stdout: string[] = [];
  const code = await runEnterpriseAdmin({
    argv: args(approval, body),
    env: trustedAdminEnv(),
    now: () => new Date("2026-11-10T06:00:00Z"),
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

async function persisted(): Promise<{
  operations: Array<Record<string, unknown>>;
  policy: Array<Record<string, unknown>>;
  users: Array<{ id: string; name: string }>;
}> {
  const operations = await pool.query(`select * from "enterprise_admin_operations" order by id`);
  const policy = await pool.query(`select * from "enterprise_policy" order by id`);
  const users = await pool.query(`select * from "user" order by id`);
  return { operations: operations.rows, policy: policy.rows, users: users.rows };
}

async function resetFixture(): Promise<void> {
  await pool.query(`delete from "enterprise_admin_operations"`);
  await pool.query(`delete from "enterprise_policy"`);
  await pool.query(`delete from "user"`);
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ('fs81-user', 'before', 'fs81@example.test', false)`,
  );
  await pool.query(
    `insert into "enterprise_policy"
       (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
     values ('fs81-policy', $1, 'megaui', 'test', 'test', 3, 'enterprise')`,
    [SCOPE],
  );
}

function directInput(overrides: Partial<Parameters<typeof runApprovedMutation>[0]> = {}) {
  applyEnv();
  const approved = overrides.bundle ?? bundle([operation()]);
  return {
    databaseUrl: isolated.databaseUrl,
    bundle: approved,
    operationId: OPERATION,
    manifestDigest: null,
    expectedPolicyEpoch: 3,
    context: {
      verb: VERB,
      operationId: OPERATION,
      args: payload().args,
      files: { names: () => [] as readonly string[], bytes: () => undefined },
    },
    handler: () => {},
    now: () => new Date("2026-11-10T06:00:00Z"),
    ...overrides,
  };
}

describe("approved mutation transaction (FS-81)", () => {
  const transactionTest = (name: string, fn: () => void | Promise<void>) => it(name, fn, 30_000);
  for (const verb of ["quarantine", "repair"] as const) {
    transactionTest("binds private " + verb + " audit to every approved row without exposing it on replay", async () => {
      const rows = ["fs81-user", "FS81-USER"].map((local_user_id, index) => ({ local_user_id,
        expected_user_version: "a".repeat(64), ...(verb === "quarantine" ? { reason: "approved isolation" } : {
          tenant_key: "tenant", app_id: "app", open_id: "ou-" + index, login_name: "alias-" + index,
          expected_identity_version: index, expected_profile_digest: "b".repeat(64), expected_quarantine_operation_id: OPERATION,
        }) }));
      const bytes = Buffer.from(JSON.stringify(rows)), digest = createHash("sha256").update(canonicalizeJson(rows)).digest("hex");
      const affected = rows.map((row, index) => ({ row: index + 1, localUserId: row.local_user_id,
        expectedUserVersion: row.expected_user_version, expectedIdentityVersion: verb === "repair" ? index : null,
        expectedProfileDigest: verb === "repair" ? "b".repeat(64) : null,
        quarantineOperationId: verb === "repair" ? OPERATION : null }));
      const counts = { [verb === "quarantine" ? "quarantined" : "repaired"]: 2 };
      const body = { ...payload(), verb, args: { ...payload().args, digest },
        inputFiles: { manifest: createHash("sha256").update(bytes).digest("hex") } };
      const approved = bundle([operation({ verb, manifestDigest: digest, payloadDigest: payloadDigest(body) })]);
      const input = directInput({ bundle: approved, manifestDigest: digest,
        context: { verb, operationId: OPERATION, args: body.args, files: { names: () => ["manifest"], bytes: () => bytes } },
        handler: () => ({ resultCounts: counts, affected }) });
      const before = await persisted();
      let finalChecks = 0, lastTestHook = false;
      if (verb === "repair") {
        expect(await runApprovedMutation({ ...input, beforeCommit: () => { lastTestHook = true; },
          handler: (_context, client) => ({ resultCounts: counts, affected, validateBeforeCommit: async () => {
            expect(lastTestHook).toBe(true);
            expect((await client.query("select count(*)::int as n from enterprise_admin_operations where operation_id=$1", [OPERATION])).rows[0].n).toBe(1);
            finalChecks++;
            throw new ApprovedMutationRejection("REPAIR_REJECTED");
          } }) })).toBe("REPAIR_REJECTED");
        expect(finalChecks).toBe(1); expect(await persisted()).toEqual(before);
      }
      for (const validateBeforeCommit of [undefined, null, 1, "private"] as unknown[]) {
        expect(await runApprovedMutation({ ...input,
          handler: () => ({ resultCounts: counts, affected, validateBeforeCommit } as never) })).toBe("DEPENDENCY_FAILED");
        expect(await persisted()).toEqual(before);
      }
      for (const wrong of [affected.slice(0, 1), [...affected].reverse(),
        [affected[0]!, { ...affected[0]!, row: 2 }], new Array<(typeof affected)[number]>(2),
        affected.map(row => ({ ...row, expectedUserVersion: "c".repeat(64) })),
        affected.map(row => ({ ...row, private: true }))]) {
        expect(await runApprovedMutation({ ...input, handler: async (_context, client) => {
          await client.query('update "user" set name=\'must rollback\'');
          return { resultCounts: { [Object.keys(counts)[0]!]: wrong.length }, affected: wrong };
        } })).toBe("DEPENDENCY_FAILED");
        expect(await persisted()).toEqual(before);
      }
      const first = await runApprovedMutation({ ...input, handler: () => ({ resultCounts: counts, affected,
        ...(verb === "repair" ? { validateBeforeCommit: () => { finalChecks++; } } : {}) }) });
      expect(first).toEqual({ operationId: OPERATION, policyEpoch: 3, resultCounts: counts, replayed: false });
      const committed = await persisted(), original = committed.operations[0]!.result as Record<string, unknown>;
      expect(original.affected).toEqual(affected);
      expect(committed.operations[0]?.expected_user_version).toBeNull();
      for (const change of [
        { affected: undefined }, { affected: affected.slice(0, 1), resultCounts: { [Object.keys(counts)[0]!]: 1 } },
        { affected: affected.map((row, index) => ({ ...row, localUserId: affected[1 - index]!.localUserId })) },
        { affected: [affected[0], { ...affected[0], row: 2 }] },
        { affected: [...affected].reverse() }, { affected: affected.map(row => ({ ...row, private: true })) },
        { affected: affected.map(row => ({ ...row, expectedUserVersion: "c".repeat(64) })) },
        { affected: affected.map(row => ({ ...row, expectedIdentityVersion: 7 })) },
        { affected: affected.map(row => ({ ...row, expectedProfileDigest: "c".repeat(64) })) },
        { affected: affected.map(row => ({ ...row, quarantineOperationId: "00000000-0000-4000-8000-000000000038" })) },
        { resultCounts: { unexpected: 2 } }, { provisioned: [] }, { applied: [] }, { unknown: true },
      ]) {
        await pool.query("update enterprise_admin_operations set result=$1::jsonb where operation_id=$2", [JSON.stringify({ ...original, ...change }), OPERATION]);
        const corrupt = await persisted();
        expect(await runApprovedMutation({ ...input, handler: () => { throw new Error("must not run"); } })).toBe("OPERATION_PAYLOAD_MISMATCH");
        expect(await persisted()).toEqual(corrupt);
      }
      await pool.query("update enterprise_admin_operations set result=$1::jsonb where operation_id=$2", [JSON.stringify(original), OPERATION]);
      expect(await runApprovedMutation({ ...input, handler: () => { throw new Error("must not run"); } }))
        .toEqual({ operationId: OPERATION, policyEpoch: 3, resultCounts: counts, replayed: true });
      expect(await persisted()).toEqual(committed);
      expect(finalChecks).toBe(verb === "repair" ? 2 : 0);
    });
  }
  transactionTest("rejects private affected rows on unrelated verbs before storing or replaying them", async () => {
    const before = await persisted();
    expect(await runApprovedMutation(directInput({ handler: () => ({ resultCounts: { quarantined: 0 }, affected: [] }) })))
      .toBe("DEPENDENCY_FAILED");
    expect(await persisted()).toEqual(before);
    expect(await runApprovedMutation(directInput())).toMatchObject({ replayed: false });
    await pool.query("update enterprise_admin_operations set result=result || '{\"affected\":[]}'::jsonb");
    const corrupt = await persisted();
    expect(await runApprovedMutation(directInput())).toBe("OPERATION_PAYLOAD_MISMATCH");
    expect(await persisted()).toEqual(corrupt);
  });

  transactionTest("binds every apply result ID to the signed complete manifest on first execution and replay", async () => {
    const rows = Array.from({ length: 102 }, (_, index) => ({ local_user_id: "Legacy-" + index,
      tenant_key: "tenant", app_id: "app", open_id: "open-" + index, login_name: "alias-" + index,
      expected_user_version: "a".repeat(64), expected_identity_version: 0 }));
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, members: rows }));
    const expected = rows.slice(100).map((row, index) => ({ row: 101 + index, localUserId: row.local_user_id }));
    const body = { ...payload(), verb: "apply", args: { ...payload().args, digest: "b".repeat(64), "batch-number": 1 },
      inputFiles: { manifest: createHash("sha256").update(bytes).digest("hex") } };
    const approved = bundle([operation({ verb: "apply", manifestDigest: body.args.digest, payloadDigest: payloadDigest(body) })]);
    const input = directInput({ bundle: approved, manifestDigest: body.args.digest,
      context: { verb: "apply", operationId: OPERATION, args: body.args,
        files: { names: () => ["manifest"], bytes: () => bytes } },
      handler: () => ({ resultCounts: { bound: 2 }, applied: expected }) });
    const before = await persisted();
    for (const applied of [expected.slice(0, 1), [...expected].reverse(),
      expected.map(row => ({ ...row, localUserId: row.localUserId.toLowerCase() })),
      expected.map(row => ({ ...row, private: true }))]) {
      expect(await runApprovedMutation({ ...input, handler: async (_context, client) => {
        await client.query('update "user" set name=\'must rollback\'');
        return { resultCounts: { bound: applied.length }, applied };
      } })).toBe("DEPENDENCY_FAILED");
      expect(await persisted()).toEqual(before);
    }
    expect(await runApprovedMutation(input)).toMatchObject({ applied: expected, replayed: false });
    const committed = await persisted(), original = committed.operations[0]!.result as Record<string, unknown>;
    for (const change of [
      { applied: undefined }, { applied: expected.slice(0, 1), resultCounts: { bound: 1 } },
      { applied: expected.map(row => ({ ...row, localUserId: row.localUserId.toLowerCase() })) },
      { applied: [...expected].reverse() }, { applied: expected.map(row => ({ ...row, row: row.row + 100 })) },
      { provisioned: expected }, { resultCounts: { bound: 1 } },
    ]) {
      await pool.query("update enterprise_admin_operations set result=$1::jsonb where operation_id=$2", [JSON.stringify({ ...original, ...change }), OPERATION]);
      const corrupt = await persisted();
      expect(await runApprovedMutation({ ...input, handler: () => { throw new Error("must not run"); } })).toBe("OPERATION_PAYLOAD_MISMATCH");
      expect(await persisted()).toEqual(corrupt);
    }
    await pool.query("update enterprise_admin_operations set result=$1::jsonb where operation_id=$2", [JSON.stringify(original), OPERATION]);
    expect(await runApprovedMutation({ ...input, handler: () => { throw new Error("must not run"); } })).toMatchObject({ applied: expected, replayed: true });
    expect(await persisted()).toEqual(committed);
  });
  transactionTest("rejects apply mappings on other verbs before storing or replaying them", async () => {
    const before = await persisted();
    expect(await runApprovedMutation(directInput({ handler: () => ({ resultCounts: { bound: 1 },
      applied: [{ row: 1, localUserId: "fs81-user" }] }) }))).toBe("DEPENDENCY_FAILED");
    expect(await persisted()).toEqual(before);
    expect(await runApprovedMutation(directInput())).toMatchObject({ replayed: false });
    await pool.query("update enterprise_admin_operations set result=result || $1::jsonb", [JSON.stringify({ applied: [{ row: 1, localUserId: "fs81-user" }] })]);
    const corrupt = await persisted();
    expect(await runApprovedMutation(directInput())).toBe("OPERATION_PAYLOAD_MISMATCH");
    expect(await persisted()).toEqual(corrupt);
  });
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    directory = mkdtempSync(join(tmpdir(), "megaui-fs81-"));
    keyPath = join(directory, "authority-private.pem");
    publicPath = join(directory, "authority-public.pem");
    bundle([operation()]);
    await resetFixture();
  }, 120_000);

  beforeEach(async () => {
    clearRegisteredWriteHandlers();
    await resetFixture();
  });

  afterAll(async () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousTrustedEnv);
    clearRegisteredWriteHandlers();
    const failures: unknown[] = [];
    if (pool) {
      try {
        await pool.end();
      } catch (error) {
        failures.push(error);
      }
    }
    if (isolated) {
      try {
        await isolated.destroy();
      } catch (error) {
        failures.push(error);
      }
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
    if (failures.length > 0) throw new AggregateError(failures, "FS-81 fixture cleanup failed");
  });

  transactionTest("rejects unsigned and inconsistent approval inputs without writes", async () => {
    const before = await persisted();
    const approved = directInput().bundle as ApprovalBundle;
    const tampered: ApprovalBundle = { ...approved, approvedBy: "other" };
    expect(await runApprovedMutation(directInput({ bundle: tampered }))).toBe("APPROVAL_SIGNATURE_INVALID");
    expect(await runApprovedMutation(directInput({ manifestDigest: "a".repeat(64) }))).toBe("APPROVAL_MANIFEST_MISMATCH");
    expect(await runApprovedMutation(directInput({
      context: {
        ...directInput().context,
        args: { ...directInput().context.args, note: "changed" },
      },
    }))).toBe("APPROVAL_DIGEST_MISMATCH");
    expect(await persisted()).toEqual(before);
  });

  transactionTest("rejects common arguments that disagree with the transaction authority", async () => {
    const before = await persisted();
    const mismatched = directInput();
    mismatched.context = {
      ...mismatched.context,
      args: { ...mismatched.context.args, target: "another-instance" },
    };
    expect(await runApprovedMutation(mismatched)).toBe("APPROVAL_DIGEST_MISMATCH");
    const differentId = directInput();
    differentId.operationId = "00000000-0000-4000-8000-000000000099";
    expect(await runApprovedMutation(differentId)).toBe("APPROVAL_DIGEST_MISMATCH");
    const differentEpoch = directInput();
    differentEpoch.expectedPolicyEpoch = 4;
    expect(await runApprovedMutation(differentEpoch)).toBe("APPROVAL_DIGEST_MISMATCH");
    const mismatchedIdArg = directInput();
    mismatchedIdArg.context = {
      ...mismatchedIdArg.context,
      args: {
        ...mismatchedIdArg.context.args,
        "operation-id": "00000000-0000-4000-8000-000000000098",
      },
    };
    expect(await runApprovedMutation(mismatchedIdArg)).toBe("APPROVAL_DIGEST_MISMATCH");
    expect(await persisted()).toEqual(before);
  });

  transactionTest("rejects a different instance after signature verification and before ledger writes", async () => {
    registerGuardedWriteHandler(VERB, { flags: {} }, () => {}, GUARD);
    const before = await persisted();
    const other = "fs81-other";
    await pool.query(
      `insert into "enterprise_policy"
         (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
       values ('fs81-other-policy', $1, 'other-owner', 'test', 'test', 3, 'enterprise')`,
      [other],
    );
    const body = payload();
    body.targetFingerprint = `megaui:${SCOPE}:other`;
    body.deploymentRole = "other";
    const approved = bundle([operation({
      targetFingerprint: body.targetFingerprint,
      deploymentRole: body.deploymentRole,
      payloadDigest: payloadDigest(body),
    })]);
    expect(await cli(approved, body, {
      ...cliEnv(),
      ENTERPRISE_DEPLOYMENT_ROLE: "other",
    })).toEqual({
      code: 3,
      stdout: "",
      stderr: "error: SCOPE_REJECTED\n",
    });
    const after = await persisted();
    expect(after.operations).toEqual(before.operations);
    expect(after.users).toEqual(before.users);
    expect(after.policy).toHaveLength(2);
    expect(after.policy.find((row) => row.scope === other)).toMatchObject({ auth_epoch: 3 });
  });

  transactionTest("rejects a different target fingerprint before ledger writes", async () => {
    registerGuardedWriteHandler(VERB, { flags: {} }, () => {}, GUARD);
    const before = await persisted();
    expect(await cli(bundle([operation({ deploymentRole: "development" })]))).toEqual({
      code: 3,
      stdout: "",
      stderr: "error: APPROVAL_ROLE_MISMATCH\n",
    });
    expect(await persisted()).toEqual(before);
  });

  transactionTest("rejects epoch and flag mismatches without business or ledger writes", async () => {
    registerGuardedWriteHandler(VERB, { flags: {} }, () => {}, GUARD);
    const before = await persisted();
    expect(await cli(bundle([operation({ expectedPolicyEpoch: 4, payloadDigest: payloadDigest(payload(OPERATION, 4)) })]), payload(OPERATION, 4))).toEqual({
      code: 3,
      stdout: "",
      stderr: "error: EPOCH_CAS_MISMATCH\n",
    });
    expect(await cli(bundle([operation({ expectedPolicyEpoch: 4 })]))).toEqual({
      code: 3,
      stdout: "",
      stderr: "error: APPROVAL_DIGEST_MISMATCH\n",
    });
    expect(await persisted()).toEqual(before);
  });

  transactionTest("rejects a missing approval and an unknown write before reading the database", async () => {
    const before = await persisted();
    const result = await cli(bundle([operation()]), payload(), { ...cliEnv(), DATABASE_URL: undefined });
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("error: UNKNOWN_VERB\n");
    expect(await persisted()).toEqual(before);
  });

  transactionTest("commits business and operation result once and replays the original result", async () => {
    let calls = 0;
    registerGuardedWriteHandler(VERB, { flags: {} }, async (_context: GuardedWriteContext, client: PoolClient) => {
      calls += 1;
      await client.query(`update "user" set name = 'after' where id = 'fs81-user'`);
      await client.query(`update "enterprise_policy" set auth_epoch = auth_epoch + 1 where scope = $1`, [SCOPE]);
      return { users: 1 };
    }, GUARD);
    const approved = bundle([operation()]);
    const first = await cli(approved);
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    expect(JSON.parse(first.stdout)).toMatchObject({
      operationId: OPERATION,
      policyEpoch: 4,
      resultCounts: { users: 1 },
      replayed: false,
    });
    expect(calls).toBe(1);
    const committed = await persisted();
    expect(committed.operations).toHaveLength(1);
    expect(committed.users[0]?.name).toBe("after");
    expect(committed.operations[0]?.result).toMatchObject({ policyEpoch: 4, resultCounts: { users: 1 } });
    const replay = await cli(approved);
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.stdout)).toEqual({
      ...JSON.parse(first.stdout),
      replayed: true,
    });
    expect(calls).toBe(1);
    expect(await persisted()).toEqual(committed);
  });

  transactionTest("rejects a changed operation payload without altering the committed result", async () => {
    registerGuardedWriteHandler(VERB, { flags: { note: { kind: "string", default: "default" } } }, () => {}, GUARD);
    const approved = bundle([operation({ payloadDigest: payloadDigest(payload(OPERATION, 3, "default")) })]);
    const first = await cli(approved, payload(OPERATION, 3, "default"));
    const before = await persisted();
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    const changed = payload(OPERATION, 3, "changed");
    const changedBundle = bundle([operation({ payloadDigest: payloadDigest(changed) })]);
    expect(await runApprovedMutation(directInput({
      bundle: changedBundle,
      context: {
        ...directInput().context,
        args: changed.args,
      },
    }))).toBe("OPERATION_PAYLOAD_MISMATCH");
    expect(await persisted()).toEqual(before);
  });

  transactionTest("returns the same stable result snapshot on first commit and replay", async () => {
    const counts = { users: 1 };
    const first = await runApprovedMutation(directInput({
      handler: () => counts,
      beforeCommit: () => { counts.users = 99; },
    }));
    expect(first).toMatchObject({ replayed: false, resultCounts: { users: 1 } });
    const replay = await runApprovedMutation(directInput({
      handler: () => { throw new Error("replay must not run"); },
    }));
    expect(replay).toMatchObject({ replayed: true, resultCounts: { users: 1 } });
    expect((await persisted()).operations).toHaveLength(1);
    expect((await persisted()).operations[0]?.result).toMatchObject({ resultCounts: { users: 1 } });
  });

  transactionTest("rolls back an invalid primitive handler result before writing", async () => {
    const before = await persisted();
    const invalid = await runApprovedMutation(directInput({
      handler: () => 1 as unknown as Record<string, number>,
    }));
    expect(invalid).toBe("DEPENDENCY_FAILED");
    expect(await persisted()).toEqual(before);
  });

  transactionTest("refuses to replay a malformed completed operation", async () => {
    expect(await runApprovedMutation(directInput())).toMatchObject({ replayed: false });
    const before = await persisted();
    await pool.query(
      `update "enterprise_admin_operations" set result = $1::jsonb where operation_id = $2`,
      [JSON.stringify({ policyEpoch: "wrong", resultCounts: {}, payloadDigest: "b".repeat(64) }), OPERATION],
    );
    expect(await runApprovedMutation(directInput())).toBe("OPERATION_PAYLOAD_MISMATCH");
    const after = await persisted();
    expect(after.operations).toHaveLength(1);
    expect(after.operations[0]?.result).toMatchObject({ policyEpoch: "wrong" });
    expect(before.users).toEqual(after.users);
  });

  transactionTest("rejects a different payload for the same committed operation id", async () => {
    const first = await runApprovedMutation(directInput());
    expect(first).toMatchObject({ replayed: false, policyEpoch: 3 });
    const beforeReplay = await persisted();
    expect(await runApprovedMutation(directInput())).toMatchObject({
      replayed: true,
      policyEpoch: 3,
    });
    expect(await persisted()).toEqual(beforeReplay);
    await pool.query(
      `update "enterprise_policy" set auth_epoch = 4 where scope = $1`,
      [SCOPE],
    );
    expect(await runApprovedMutation(directInput())).toMatchObject({
      replayed: true,
      policyEpoch: 3,
    });
    const changedBody = payload();
    changedBody.args = { ...changedBody.args, note: "changed" };
    const changedBundle = bundle([operation({ payloadDigest: payloadDigest(changedBody) })]);
    expect(await runApprovedMutation({
      ...directInput(),
      context: {
        ...directInput().context,
        args: { ...directInput().context.args, note: "changed" },
      },
      bundle: changedBundle,
    })).toBe("OPERATION_PAYLOAD_MISMATCH");
    expect((await persisted()).operations).toEqual(beforeReplay.operations);
  });

  transactionTest("rolls back business and ledger on crash, then safely retries", async () => {
    let fail = true;
    registerGuardedWriteHandler(VERB, { flags: {} }, async (_context: GuardedWriteContext, client: PoolClient) => {
      await client.query(`update "user" set name = 'after' where id = 'fs81-user'`);
      if (fail) throw new Error("fixture crash");
    }, GUARD);
    const before = await persisted();
    const approved = bundle([operation()]);
    expect(await cli(approved)).toEqual({
      code: 4,
      stdout: "",
      stderr: "error: DEPENDENCY_FAILED\n",
    });
    expect(await persisted()).toEqual(before);
    fail = false;
    expect((await cli(approved)).code).toBe(0);
    expect((await persisted()).operations).toHaveLength(1);
  });

  transactionTest("serializes concurrent identical operations and runs the handler once", async () => {
    let calls = 0;
    registerGuardedWriteHandler(VERB, { flags: {} }, async (_context: GuardedWriteContext, client: PoolClient) => {
      calls += 1;
      await client.query(`update "user" set name = 'after' where id = 'fs81-user'`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }, GUARD);
    const approved = bundle([operation()]);
    const [first, second] = await Promise.all([cli(approved), cli(approved)]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(calls).toBe(1);
    expect((await persisted()).operations).toHaveLength(1);
  });

  transactionTest("does not expose a raw handler through a pin", () => {
    registerGuardedWriteHandler(VERB, { flags: {} }, () => {}, GUARD);
    const pin = pinRegisteredVerb(VERB);
    expect(pin && "handler" in pin).toBe(false);
    pin?.release();
  });
});
