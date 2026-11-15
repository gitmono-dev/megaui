// FS-79: persistent maintenance command through the real signed CLI boundary.
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "@megaui/database/test-support";

import {
  clearRegisteredWriteHandlers,
  type ApprovalBundle,
  type ApprovalOperation,
} from "../../cli/admin-approval";
import { trustedAdminEnv } from "../../cli/admin-env";
import { runApprovedMutation } from "../../cli/admin-mutation";
import { payloadDigest, type PayloadDigestInput } from "../../cli/admin-payload";
import {
  installEnterpriseAdminDispatch,
  runEnterpriseAdmin,
} from "../../cli/enterprise-admin";
import { runMaintenanceMutation } from "./maintenance";

if (!(await isDockerAvailable())) {
  throw new Error("[@megaui/engine] maintenance.integration.test.ts requires Docker.");
}

const SCOPE = "fs79-instance";
const FIRST_OPERATION = "00000000-0000-4000-8000-000000000079";
const SECOND_OPERATION = "00000000-0000-4000-8000-00000000007a";
const CLI = fileURLToPath(new URL("../../cli/enterprise-admin.ts", import.meta.url));
const SIGNER = fileURLToPath(new URL("../../cli/admin-approval.fixture-signer.ts", import.meta.url));

let isolated: IsolatedPostgres;
let pool: Pool;
let directory: string;
let keyPath: string;
let publicPath: string;
const previousEnv = { ...process.env };

function env(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "test",
    DATABASE_URL: isolated.databaseUrl,
    ENTERPRISE_APPROVAL_PUBLIC_KEY: readFileSync(publicPath, "utf8"),
    ENTERPRISE_DB_INSTANCE_ID: SCOPE,
    ENTERPRISE_PROCESS_ROLE: "test",
    ENTERPRISE_DEPLOYMENT_ROLE: "test",
    ENTERPRISE_OWNER_FINGERPRINT: "megaui",
  };
}

function applyEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ENTERPRISE_") || key === "DATABASE_URL") delete process.env[key];
  }
  Object.assign(process.env, env());
}

function payload(operationId: string, expectedPolicyEpoch: number, extra: Record<string, string> = {}): PayloadDigestInput {
  return {
    verb: "maintenance",
    targetFingerprint: `megaui:${SCOPE}:test`,
    deploymentRole: "test",
    operationId,
    expectedPolicyEpoch,
    args: {
      target: SCOPE,
      "operation-id": operationId,
      "expect-policy-epoch": expectedPolicyEpoch,
      ...extra,
    },
    inputFiles: {},
  };
}

function approval(operationId: string, expectedPolicyEpoch: number, body = payload(operationId, expectedPolicyEpoch)): ApprovalBundle {
  const operation: ApprovalOperation = {
    verb: body.verb,
    targetFingerprint: body.targetFingerprint,
    deploymentRole: body.deploymentRole,
    operationId,
    payloadDigest: payloadDigest(body),
    manifestDigest: null,
    expectedPolicyEpoch,
  };
  const request = join(directory, `request-${operationId}.json`);
  const output = join(directory, `approval-${operationId}.json`);
  writeFileSync(request, JSON.stringify({
    schemaVersion: 1,
    approvalId: `approval-${operationId}`,
    approvedBy: "fs79-fixture-authority",
    issuedAt: 1_700_000_000,
    expiresAt: 1_899_000_000,
    operations: [operation],
    signature: "",
  }));
  const signed = spawnSync(
    process.execPath,
    ["--import", "tsx", SIGNER, keyPath, publicPath, request, output],
    { cwd: fileURLToPath(new URL("../../../../../", import.meta.url)) },
  );
  if (signed.status !== 0) throw new Error(signed.stderr.toString() || "FS-79 signer failed");
  return JSON.parse(readFileSync(output, "utf8")) as ApprovalBundle;
}

function writePayload(body: PayloadDigestInput): string {
  const path = join(directory, `payload-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, ...body }));
  return path;
}

function writeApproval(value: unknown): string {
  const path = join(directory, `bundle-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function mutationArgs(body: PayloadDigestInput): Record<string, string | number> {
  const args: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(body.args)) {
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error("FS-79 fixture generated an unsupported mutation argument.");
    }
    args[key] = value;
  }
  return args;
}

function cliArguments(bundle: ApprovalBundle, body: PayloadDigestInput): string[] {
  return [
    "maintenance",
    "--target", SCOPE,
    "--approval", writeApproval(bundle),
    "--approved-payload", writePayload(body),
    "--operation-id", body.operationId,
    "--expect-policy-epoch", String(body.expectedPolicyEpoch),
  ];
}

function runCli(bundle: ApprovalBundle, body: PayloadDigestInput): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, ...cliArguments(bundle, body)], {
    cwd: fileURLToPath(new URL("../../../../../", import.meta.url)),
    env: env(),
    encoding: "utf8",
  });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

async function snapshot(): Promise<{ policy: unknown[]; operations: unknown[] }> {
  const policy = await pool.query(
    `select scope, auth_epoch, activation_state, activated_at, updated_at
       from "enterprise_policy" order by scope`,
  );
  const operations = await pool.query(
    `select operation_id, verb, result from "enterprise_admin_operations" order by operation_id`,
  );
  return { policy: policy.rows, operations: operations.rows };
}

async function reset(): Promise<void> {
  await pool.query(`delete from "enterprise_admin_operations"`);
  await pool.query(`delete from "enterprise_policy"`);
  await pool.query(
    `insert into "enterprise_policy"
       (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state, activated_at)
     values ('fs79-policy', $1, 'megaui', 'test', 'test', 3, 'enterprise', '2026-11-10T00:00:00Z')`,
    [SCOPE],
  );
}

describe("persistent maintenance admin command (FS-79)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    directory = mkdtempSync(join(tmpdir(), "megaui-fs79-"));
    keyPath = join(directory, "authority-private.pem");
    publicPath = join(directory, "authority-public.pem");
    const pair = generateKeyPairSync("ed25519");
    writeFileSync(keyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    writeFileSync(publicPath, pair.publicKey.export({ type: "spki", format: "pem" }).toString(), { mode: 0o600 });
    await reset();
  }, 120_000);

  beforeEach(async () => {
    clearRegisteredWriteHandlers();
    applyEnv();
    await reset();
  });

  afterAll(async () => {
    clearRegisteredWriteHandlers();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    const failures: unknown[] = [];
    try {
      await pool?.end();
    } catch (error) {
      failures.push(error);
    }
    try {
      await isolated?.destroy();
    } catch (error) {
      failures.push(error);
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
    if (failures.length > 0) throw new AggregateError(failures, "FS-79 fixture cleanup failed");
  });

  it("persists maintenance once, preserves activation, and replays the original result through the real CLI", async () => {
    const firstBody = payload(FIRST_OPERATION, 3);
    const firstBundle = approval(FIRST_OPERATION, 3, firstBody);
    const before = await snapshot();
    const originalActivation = (before.policy[0] as { activated_at: string }).activated_at;

    const first = runCli(firstBundle, firstBody);
    expect(first).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(first.stdout)).toEqual({
      schemaVersion: 1,
      operationId: FIRST_OPERATION,
      policyEpoch: 4,
      resultCounts: { policyTransitions: 1 },
      replayed: false,
    });
    const afterFirst = await snapshot();
    expect(afterFirst.policy).toHaveLength(1);
    expect(afterFirst.policy[0]).toMatchObject({
      scope: SCOPE,
      activation_state: "maintenance",
      auth_epoch: 4,
      activated_at: originalActivation,
    });
    expect(afterFirst.operations).toHaveLength(1);

    const replay = runCli(firstBundle, firstBody);
    expect(replay).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(replay.stdout)).toEqual({ ...JSON.parse(first.stdout), replayed: true });
    expect(await snapshot()).toEqual(afterFirst);

    const secondBody = payload(SECOND_OPERATION, 4);
    const second = runCli(approval(SECOND_OPERATION, 4, secondBody), secondBody);
    expect(second).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(second.stdout)).toMatchObject({
      policyEpoch: 4,
      resultCounts: { policyTransitions: 0 },
      replayed: false,
    });
    expect((await snapshot()).policy[0]).toMatchObject({
      activation_state: "maintenance",
      auth_epoch: 4,
      activated_at: originalActivation,
    });
  });

  it("rejects a different signed payload for an existing operation before rerunning maintenance", async () => {
    const firstBody = payload(FIRST_OPERATION, 3);
    expect(runCli(approval(FIRST_OPERATION, 3, firstBody), firstBody).code).toBe(0);
    const before = await snapshot();
    const changedBody = payload(FIRST_OPERATION, 3, { fixture: "changed" });
    const result = await runApprovedMutation({
      bundle: approval(FIRST_OPERATION, 3, changedBody),
      operationId: FIRST_OPERATION,
      manifestDigest: null,
      expectedPolicyEpoch: 3,
      context: {
        verb: "maintenance",
        operationId: FIRST_OPERATION,
        args: mutationArgs(changedBody),
        files: { names: () => [], bytes: () => undefined },
      },
      handler: runMaintenanceMutation,
    });
    expect(result).toBe("OPERATION_PAYLOAD_MISMATCH");
    expect(await snapshot()).toEqual(before);
  });

  it("emits a request with a real read-only PostgreSQL transaction and no database writes", async () => {
    installEnterpriseAdminDispatch();
    const requestPath = join(directory, "maintenance-request.json");
    const queries: string[] = [];
    const before = await snapshot();
    const stderr: string[] = [];
    const code = await runEnterpriseAdmin({
      argv: [
        "maintenance",
        "--target", SCOPE,
        "--operation-id", FIRST_OPERATION,
        "--expect-policy-epoch", "3",
        "--out", requestPath,
        "--emit-approval-request",
      ],
      env: trustedAdminEnv(),
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
      onEmitQuery: (sql) => queries.push(sql),
    });
    expect(code, stderr.join("")).toBe(0);
    expect(JSON.parse(readFileSync(requestPath, "utf8"))).toMatchObject({
      verb: "maintenance",
      operationId: FIRST_OPERATION,
      expectedPolicyEpoch: 3,
    });
    expect(queries.join("\n")).toMatch(/set transaction read only/i);
    expect(queries.map((sql) => sql.trim().split(/\s+/, 1)[0]?.toLowerCase())).toEqual([
      "begin",
      "set",
      "select",
      "select",
      "rollback",
    ]);
    expect(await snapshot()).toEqual(before);
  });
});
