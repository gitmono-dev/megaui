// FS-85: the offline signing process does not connect to the real PostgreSQL fixture.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "@megaui/database/test-support";

import { approvalPublicKey, parseApprovalBundle, verifyApprovalSignature } from "./admin-approval-verifier";
import { payloadDigest, type PayloadDigestInput } from "./admin-payload";

if (!(await isDockerAvailable())) {
  throw new Error("[@megaui/engine] FS-85 integration tests require Docker");
}

let isolated: IsolatedPostgres;
let pool: Pool;
let directory: string;

async function snapshots(): Promise<unknown[]> {
  const result = await pool.query(
    "select table_name from information_schema.tables where table_schema='public' order by table_name",
  );
  const tables: unknown[] = [];
  for (const row of result.rows) {
    const table = row.table_name as string;
    const data = await pool.query(`select * from "${table}"`);
    tables.push({ table, rows: data.rows });
  }
  return tables;
}

function request(): Record<string, unknown> {
  const operationId = "00000000-0000-4000-8000-000000000085";
  const payload: PayloadDigestInput = {
    verb: "maintenance",
    targetFingerprint: "megaui:fs85-integration:test",
    deploymentRole: "test",
    operationId,
    expectedPolicyEpoch: 3,
    args: {
      target: "fs85-integration",
      "operation-id": operationId,
      "expect-policy-epoch": 3,
      mode: "maintenance",
    },
    inputFiles: {},
  };
  return { schemaVersion: 1, ...payload, manifestDigest: null, payloadDigest: payloadDigest(payload) };
}

function expiresAt(): string {
  return new Date(Date.now() + 10 * 60_000).toISOString().slice(0, 19) + "Z";
}

interface AuthorityProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

async function runAuthority(
  requestPath: string,
  keyPath: string,
  outputPath: string,
  pollutedEnvironment: Record<string, string> = {},
): Promise<AuthorityProcessResult> {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.ENTERPRISE_DB_INSTANCE_ID;
  delete env.ENTERPRISE_PROCESS_ROLE;
  delete env.ENTERPRISE_DEPLOYMENT_ROLE;
  delete env.ENTERPRISE_OWNER_FINGERPRINT;
  delete env.ENTERPRISE_APPROVAL_PUBLIC_KEY;
  Object.assign(env, pollutedEnvironment);
  return await new Promise((resolve) => {
    const child = spawn("pnpm", [
      "--filter", "@megaui/engine", "run", "enterprise:approve",
      "--request", requestPath,
      "--key-file", keyPath,
      "--approved-by", "fixture-authority",
      "--expires-at", expiresAt(),
      "--out", outputPath,
    ], { cwd: process.cwd(), env });
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (reason: Error) => { error = reason; });
    child.once("close", (status) => resolve({ status, stdout, stderr, error }));
  });
}

async function databaseConnectionTrace(): Promise<{ databaseUrl: string; count: () => number; close: () => Promise<void> }> {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("database trace did not bind TCP");
  return {
    databaseUrl: `postgres://trace:trace@127.0.0.1:${address.port}/trace?application_name=megaui-fs85-authority`,
    count: () => connections,
    close: async () => await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

describe("approval authority process isolation (FS-85)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    directory = mkdtempSync(join(tmpdir(), "megaui-fs85-integration-"));
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (isolated) await isolated.destroy();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("signs in a real Node child without database configuration, connections, DML, or DDL", async () => {
    const requestPath = join(directory, "request.json");
    const keyPath = join(directory, "authority.pem");
    const outputPath = join(directory, "approval.json");
    const pollutedOutputPath = join(directory, "polluted-approval.json");
    const rejectedRequestPath = join(directory, "rejected-request.json");
    const rejectedOutputPath = join(directory, "rejected-approval.json");
    const pair = generateKeyPairSync("ed25519");
    const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    writeFileSync(requestPath, JSON.stringify(request()));
    writeFileSync(rejectedRequestPath, JSON.stringify({ ...request(), payloadDigest: "0".repeat(64) }));
    writeFileSync(keyPath, privatePem, { mode: 0o600 });
    const before = await snapshots();

    const child = await runAuthority(requestPath, keyPath, outputPath);
    expect(child.error).toBeUndefined();
    expect(child.status, `${child.stderr}\n${child.stdout}`).toBe(0);
    expect(child.stderr).toBe("");
    expect(child.stdout).not.toContain(privatePem);

    const trace = await databaseConnectionTrace();
    try {
      const polluted = await runAuthority(requestPath, keyPath, pollutedOutputPath, { DATABASE_URL: trace.databaseUrl });
      expect(polluted.error).toBeUndefined();
      expect(polluted.status, `${polluted.stderr}\n${polluted.stdout}`).toBe(0);
      const rejected = await runAuthority(rejectedRequestPath, keyPath, rejectedOutputPath, { DATABASE_URL: trace.databaseUrl });
      expect(rejected.error).toBeUndefined();
      expect(rejected.status).toBe(2);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("error: AUTHORITY_REQUEST_INVALID\n");
      expect(`${rejected.stdout}\n${rejected.stderr}`).not.toContain(privatePem);
      expect(trace.count(), "authority must not open a TCP database connection, even with polluted environment").toBe(0);
    } finally {
      await trace.close();
    }
    expect(await snapshots()).toEqual(before);
    const parsed = parseApprovalBundle(JSON.parse(readFileSync(outputPath, "utf8")));
    const publicKey = approvalPublicKey(publicPem);
    expect(typeof parsed).not.toBe("string");
    expect(typeof publicKey).not.toBe("string");
    if (typeof parsed === "string" || typeof publicKey === "string") throw new Error("fixture bundle rejected");
    expect(verifyApprovalSignature(parsed, publicKey)).toBe(true);
  }, 60_000);
});
