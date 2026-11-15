// FS-82: real PostgreSQL read-only approval-request preparation.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "@megaui/database/test-support";

import {
  canonicalSignedDocument,
  clearRegisteredWriteHandlers,
  registerGuardedWriteHandler,
  type ApprovalBundle,
} from "./admin-approval";
import { readApprovedFileBytes, runEnterpriseAdmin } from "./enterprise-admin";

if (!(await isDockerAvailable())) {
  throw new Error("[@megaui/engine] FS-82 integration tests require Docker");
}

const OPERATION = "00000000-0000-4000-8000-000000000082";
const INSTANCE = "fs82-instance";
const VERB = "fixture-write";
const GUARD = { approval: true as const, scope: true as const };
const AUTHORITY = generateKeyPairSync("ed25519");
const ENV = {
  ENTERPRISE_DB_INSTANCE_ID: INSTANCE,
  ENTERPRISE_PROCESS_ROLE: "test",
  ENTERPRISE_DEPLOYMENT_ROLE: "test",
  ENTERPRISE_OWNER_FINGERPRINT: "megaui",
  ENTERPRISE_APPROVAL_PUBLIC_KEY: AUTHORITY.publicKey.export({
    type: "spki", format: "pem",
  }).toString(),
};

let isolated: IsolatedPostgres;
let pool: Pool;
let directory: string;

async function snapshots(): Promise<unknown[]> {
  const result = await pool.query(
    `select table_name from information_schema.tables where table_schema='public' order by table_name`,
  );
  const tables: unknown[] = [];
  for (const row of result.rows) {
    const table = row.table_name as string;
    const data = await pool.query(`select * from "${table}"`);
    tables.push({ table, rows: data.rows });
  }
  return tables;
}

async function emit(out: string, extra: string[] = []): Promise<{ code: number; stdout: string; stderr: string; sql: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sql: string[] = [];
  const code = await runEnterpriseAdmin({
    argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
      "--expect-policy-epoch", "3", "--out", out,
      "--emit-approval-request", ...extra],
    onEmitQuery: (sqlText) => sql.push(sqlText),
    env: { ...ENV, DATABASE_URL: isolated.databaseUrl },
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), sql };
}

function signedApproval(request: Record<string, unknown>): ApprovalBundle {
  const unsigned: ApprovalBundle = {
    schemaVersion: 1,
    approvalId: "fs82-approval",
    approvedBy: "fixture-authority",
    issuedAt: 1_700_000_000,
    expiresAt: 1_899_000_000,
    operations: [{
      verb: request.verb as string,
      targetFingerprint: request.targetFingerprint as string,
      deploymentRole: request.deploymentRole as string,
      operationId: request.operationId as string,
      payloadDigest: request.payloadDigest as string,
      manifestDigest: request.manifestDigest as string | null,
      expectedPolicyEpoch: request.expectedPolicyEpoch as number,
    }],
    signature: "",
  };
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalSignedDocument(unsigned), "utf8"), AUTHORITY.privateKey)
      .toString("base64"),
  };
}

describe("approval request preparation (FS-82)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    await pool.query(
      `insert into "enterprise_policy"
         (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
       values ('fs82-policy', $1, 'megaui', 'test', 'test', 3, 'enterprise')`,
      [INSTANCE],
    );
    directory = realpathSync(mkdtempSync(join(tmpdir(), "megaui-fs82-")));
  }, 120_000);

  beforeEach(() => {
    clearRegisteredWriteHandlers();
  });

  afterAll(async () => {
    clearRegisteredWriteHandlers();
    if (pool) await pool.end();
    if (isolated) await isolated.destroy();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("emits a canonical request in a real read-only transaction with no DML/DDL", async () => {
    registerGuardedWriteHandler(VERB, {
      flags: {
        manifest: { kind: "file", required: true },
        digest: { kind: "string", required: true, emitSafe: true },
        note: { kind: "string", default: "default", emitSafe: true },
      },
    }, () => { throw new Error("emit must not execute a handler"); }, GUARD);
    const manifest = join(directory, "members.json");
    writeFileSync(manifest, Buffer.from('{"members":["one"]}'));
    const before = await snapshots();
    const out = join(directory, "request.json");
    const traced = await emit(out, ["--manifest", manifest, "--digest", "a".repeat(64)]);
    expect(traced.code, `${traced.stderr} sql=${traced.sql.join(" | ")}`).toBe(0);
    expect(traced.stdout).toBe("");
    expect(traced.stderr).toBe("");
    expect(traced.sql.join(" | ")).toContain("transaction read only");
    expect(traced.sql.some((statement) => statement.includes("enterprise_policy"))).toBe(true);
    expect(traced.sql.every((statement) => !/^\s*(insert|update|delete|create|alter|drop|truncate|grant|revoke)\b/i.test(statement))).toBe(true);
    expect(await snapshots()).toEqual(before);
    const request = JSON.parse(readFileSync(out, "utf8"));
    expect(request).toMatchObject({
      schemaVersion: 1,
      verb: VERB,
      targetFingerprint: `megaui:${INSTANCE}:test`,
      deploymentRole: "test",
      operationId: OPERATION,
      expectedPolicyEpoch: 3,
      manifestDigest: "a".repeat(64),
      args: {
        target: INSTANCE,
        "operation-id": OPERATION,
        "expect-policy-epoch": 3,
        note: "default",
        manifest,
        digest: "a".repeat(64),
      },
    });
    expect(request.args.out).toBeUndefined();
    expect(Object.keys(request.args)).toHaveLength(6);
    expect(request.payloadDigest).not.toBe("a".repeat(64));
    expect(request.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);

  it("computes a canonical quarantine manifest digest and rejects an explicit mismatch", async () => {
    registerGuardedWriteHandler("quarantine", {
      flags: {
        manifest: { kind: "file", required: true },
        digest: { kind: "string", required: true, emitSafe: true },
      },
      emitDigest: "canonical-manifest",
    }, () => { throw new Error("must not invoke future business handler"); }, GUARD);
    writeFileSync(join(directory, "quarantine.json"), JSON.stringify([{
      local_user_id: "user-1",
      reason: "conflicting mapping",
      expected_user_version: "a".repeat(64),
    }]));
    const manifest = realpathSync(join(directory, "quarantine.json"));
    const before = await snapshots();
    const computedOut = join(directory, "quarantine-request.json");
    const stderr: string[] = [];
    const computed = await runEnterpriseAdmin({
      argv: ["quarantine", "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", "--manifest", manifest,
        "--out", computedOut, "--emit-approval-request"],
      env: { ...ENV, DATABASE_URL: isolated.databaseUrl },
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
    });
    expect(computed, stderr.join("")).toBe(0);
    const request = JSON.parse(readFileSync(computedOut, "utf8"));
    expect(request.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(request.manifestDigest).not.toBe("a".repeat(64));
    expect(request.args.digest).toBe(request.manifestDigest);
    expect(request.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await snapshots()).toEqual(before);
    const wrong = await runEnterpriseAdmin({
      argv: ["quarantine", "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", "--manifest", manifest,
        "--digest", "a".repeat(64), "--out", join(directory, "wrong-request.json"),
        "--emit-approval-request"],
      env: { ...ENV, DATABASE_URL: isolated.databaseUrl },
      io: { stdout: () => {}, stderr: () => {} },
    });
    expect(wrong).toBe(3);
    expect(await snapshots()).toEqual(before);
  });

  it("derives the canonical manifest digest from the no-follow byte snapshot", async () => {
    registerGuardedWriteHandler("quarantine", {
      flags: {
        manifest: { kind: "file", required: true },
        digest: { kind: "string", required: true, emitSafe: true },
      },
      emitDigest: "canonical-manifest",
    }, () => { throw new Error("must not invoke future business handler"); }, GUARD);
    const manifest = join(directory, "snapshot-quarantine.json");
    const original = [{
      local_user_id: "user-1",
      reason: "original",
      expected_user_version: "a".repeat(64),
    }];
    const replacement = [{
      local_user_id: "user-1",
      reason: "replacement",
      expected_user_version: "a".repeat(64),
    }];
    writeFileSync(manifest, JSON.stringify(original));
    const out = join(directory, "snapshot-quarantine-request.json");
    let swapped = false;
    const stderr: string[] = [];
    const code = await runEnterpriseAdmin({
      argv: ["quarantine", "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", "--manifest", manifest,
        "--out", out, "--emit-approval-request"],
      env: { ...ENV, DATABASE_URL: isolated.databaseUrl },
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
      observeApprovedBytes: () => {
        swapped = true;
        writeFileSync(manifest, JSON.stringify(replacement));
      },
    });
    expect(code, stderr.join("")).toBe(0);
    expect(swapped).toBe(true);
    const request = JSON.parse(readFileSync(out, "utf8"));
    expect(request.inputFiles.manifest).toBe(
      createHash("sha256").update(JSON.stringify(original)).digest("hex"),
    );
    expect(request.manifestDigest).toBe(
      createHash("sha256")
        .update('[{"expected_user_version":"' + 'a'.repeat(64) + '","local_user_id":"user-1","reason":"original"}]')
        .digest("hex"),
    );
    expect(request.manifestDigest).not.toBe(
      createHash("sha256")
        .update('[{"expected_user_version":"' + 'a'.repeat(64) + '","local_user_id":"user-1","reason":"replacement"}]')
        .digest("hex"),
    );
  });

  it("rejects false boolean assignments, invalid booleans and missing manifest", async () => {
    for (const value of ["false", "no", "1"]) {
      const result = await runEnterpriseAdmin({
        argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
          "--expect-policy-epoch", "3", "--out", join(directory, `bool-${value}.json`),
          `--emit-approval-request=${value}`],
        env: ENV,
        io: { stdout: () => {}, stderr: () => {} },
      });
      expect(result).toBe(2);
    }
    const missing = await runEnterpriseAdmin({
      argv: ["quarantine", "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", "--out", join(directory, "missing-manifest.json"),
        "--emit-approval-request"],
      env: ENV,
      io: { stdout: () => {}, stderr: () => {} },
    });
    expect(missing).toBe(2);
  });

  it("rejects unknown verbs, duplicate destinations and missing approval inputs correctly", async () => {
    registerGuardedWriteHandler(VERB, { flags: {} }, () => {}, GUARD);
    expect((await emit(join(directory, "unknown.json"), ["--unknown"])).code).toBe(2);
    const missing = await runEnterpriseAdmin({
      argv: ["maintenance"],
      env: ENV,
      io: { stdout: () => {}, stderr: () => {} },
    });
    expect(missing).toBe(2);
    const duplicate = await emit(join(directory, "duplicate.json"), ["--out", join(directory, "other.json")]);
    expect(duplicate.code).toBe(2);
    expect(duplicate.stderr).toBe("error: DUPLICATE_FLAG\n");
    expect(() => registerGuardedWriteHandler("out-owner", {
      flags: { out: { kind: "string", default: "unsafe" } },
    }, () => {}, GUARD)).toThrow("collides with a common write flag");
  });

  it("rejects non-absolute and lexical-traversal destinations before opening the database", async () => {
    registerGuardedWriteHandler(VERB, { flags: {} }, () => {}, GUARD);
    for (const out of ["request.json", `${directory}/../escaped-request.json`]) {
      const stderr: string[] = [];
      const queries: string[] = [];
      const code = await runEnterpriseAdmin({
        argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
          "--expect-policy-epoch", "3", "--out", out, "--emit-approval-request"],
        env: { ...ENV, DATABASE_URL: "postgres://127.0.0.1:1/missing" },
        io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
        onEmitQuery: (query) => queries.push(query),
      });
      expect(code).toBe(2);
      expect(stderr.join("")).toBe("error: INVALID_ARGUMENT\n");
      expect(queries).toEqual([]);
    }
  });

  it("rejects malformed string input before the emit branch opens the database", async () => {
    registerGuardedWriteHandler(VERB, {
      flags: { note: { kind: "string", default: "default", emitSafe: true } },
    }, () => {}, GUARD);
    const malformed = Buffer.from([0x00, 0xd8]).toString("utf16le");
    const stderr: string[] = [];
    const queries: string[] = [];
    const code = await runEnterpriseAdmin({
      argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", "--note", malformed,
        "--out", join(directory, "malformed-request.json"), "--emit-approval-request"],
      env: { ...ENV, DATABASE_URL: "postgres://127.0.0.1:1/missing" },
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
      onEmitQuery: (query) => queries.push(query),
    });
    expect(code).toBe(2);
    expect(stderr.join("")).toBe("error: INVALID_ARGUMENT\n");
    expect(queries).toEqual([]);
  });

  it("rejects a malformed manifest digest before the emit branch opens the database", async () => {
    registerGuardedWriteHandler(VERB, {
      flags: { digest: { kind: "string", required: true, emitSafe: true } },
    }, () => {}, GUARD);
    const stderr: string[] = [];
    const queries: string[] = [];
    const code = await runEnterpriseAdmin({
      argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", "--digest", "not-a-sha256",
        "--out", join(directory, "malformed-digest-request.json"), "--emit-approval-request"],
      env: { ...ENV, DATABASE_URL: "postgres://127.0.0.1:1/missing" },
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
      onEmitQuery: (query) => queries.push(query),
    });
    expect(code).toBe(2);
    expect(stderr.join("")).toBe("error: INVALID_ARGUMENT\n");
    expect(queries).toEqual([]);
  });

  it("rejects NUL-containing input paths before emit opens the database", async () => {
    registerGuardedWriteHandler(VERB, {
      flags: { manifest: { kind: "file", required: true } },
    }, () => {}, GUARD);
    const stderr: string[] = [];
    const queries: string[] = [];
    const code = await runEnterpriseAdmin({
      argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", "--manifest", `${directory}/bad\0manifest.json`,
        "--out", join(directory, "nul-path-request.json"), "--emit-approval-request"],
      env: { ...ENV, DATABASE_URL: "postgres://127.0.0.1:1/missing" },
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
      onEmitQuery: (query) => queries.push(query),
    });
    expect(code).toBe(2);
    expect(stderr.join("")).toBe("error: INVALID_ARGUMENT\n");
    expect(queries).toEqual([]);
  });

  it("rejects relative and lexical-traversal file flags in emit and execution forms", async () => {
    registerGuardedWriteHandler(VERB, {
      flags: { manifest: { kind: "file", required: true } },
    }, () => {}, GUARD);
    for (const manifest of ["package.json", `${process.cwd()}/../megaui/package.json`]) {
      const emitStderr: string[] = [];
      const queries: string[] = [];
      const emitted = await runEnterpriseAdmin({
        argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
          "--expect-policy-epoch", "3", "--manifest", manifest,
          "--out", join(directory, "relative-manifest-request.json"), "--emit-approval-request"],
        env: { ...ENV, DATABASE_URL: "postgres://127.0.0.1:1/missing" },
        io: { stdout: () => {}, stderr: (text) => emitStderr.push(text) },
        onEmitQuery: (query) => queries.push(query),
      });
      expect(emitted).toBe(2);
      expect(emitStderr.join("")).toBe("error: INVALID_ARGUMENT\n");
      expect(queries).toEqual([]);

      const executionStderr: string[] = [];
      const executed = await runEnterpriseAdmin({
        argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
          "--expect-policy-epoch", "3", "--manifest", manifest,
          "--approval", join(directory, "missing-approval.json"),
          "--approved-payload", join(directory, "missing-payload.json")],
        env: ENV,
        io: { stdout: () => {}, stderr: (text) => executionStderr.push(text) },
      });
      expect(executed).toBe(2);
      expect(executionStderr.join("")).toBe("error: INVALID_ARGUMENT\n");
    }
  });

  it("accepts an absolute --out=<path> destination", async () => {
    registerGuardedWriteHandler(VERB, { flags: {} }, () => {}, GUARD);
    const out = join(directory, "inline-output-request.json");
    const stderr: string[] = [];
    const code = await runEnterpriseAdmin({
      argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", `--out=${out}`, "--emit-approval-request"],
      env: { ...ENV, DATABASE_URL: isolated.databaseUrl },
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
    });
    expect(code, stderr.join("")).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).operationId).toBe(OPERATION);
  });

  it("rejects malformed Unicode in separate and equals-form output destinations before opening the database", async () => {
    registerGuardedWriteHandler(VERB, { flags: {} }, () => {}, GUARD);
    const malformed = Buffer.from([0x00, 0xd8]).toString("utf16le");
    for (const outputArgs of [
      ["--out", `${directory}/${malformed}.json`],
      [`--out=${directory}/${malformed}.json`],
    ]) {
      const stderr: string[] = [];
      const queries: string[] = [];
      const code = await runEnterpriseAdmin({
        argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
          "--expect-policy-epoch", "3", ...outputArgs, "--emit-approval-request"],
        env: { ...ENV, DATABASE_URL: "postgres://127.0.0.1:1/missing" },
        io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
        onEmitQuery: (query) => queries.push(query),
      });
      expect(code).toBe(2);
      expect(stderr.join("")).toBe("error: INVALID_ARGUMENT\n");
      expect(queries).toEqual([]);
    }
  });

  it("refuses to emit an unclassified behavior string before opening the database", async () => {
    registerGuardedWriteHandler(VERB, {
      flags: { authority_token: { kind: "string", required: true } },
    }, () => {}, GUARD);
    const out = join(directory, "unsafe-request.json");
    const stderr: string[] = [];
    const queries: string[] = [];
    const code = await runEnterpriseAdmin({
      argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", "--authority_token", "never-emit-me",
        "--out", out, "--emit-approval-request"],
      env: { ...ENV, DATABASE_URL: isolated.databaseUrl },
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
      onEmitQuery: (query) => queries.push(query),
    });
    expect(code).toBe(2);
    expect(stderr.join("")).toBe("error: INVALID_ARGUMENT\n");
    expect(queries).toEqual([]);
    expect(() => readFileSync(out)).toThrow();
  });

  it("round-trips an emitted request through approval and formal execution", async () => {
    let handlerRuns = 0;
    registerGuardedWriteHandler(VERB, { flags: {} }, () => {
      handlerRuns += 1;
      return { requests: 1 };
    }, GUARD);
    const requestPath = join(directory, "round-trip-request.json");
    const emitted = await runEnterpriseAdmin({
      argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", "--out", requestPath, "--emit-approval-request"],
      env: { ...ENV, DATABASE_URL: isolated.databaseUrl },
      io: { stdout: () => {}, stderr: () => {} },
    });
    expect(emitted).toBe(0);
    const request = JSON.parse(readFileSync(requestPath, "utf8")) as Record<string, unknown>;
    const approvalPath = join(directory, "round-trip-approval.json");
    writeFileSync(approvalPath, JSON.stringify(signedApproval(request)));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const savedEnv = new Map(Object.entries(ENV).map(([key]) => [key, process.env[key]]));
    const savedDatabaseUrl = process.env.DATABASE_URL;
    Object.assign(process.env, ENV, { DATABASE_URL: isolated.databaseUrl });
    try {
      const executed = await runEnterpriseAdmin({
        argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
          "--expect-policy-epoch", "3", "--approval", approvalPath,
          "--approved-payload", requestPath],
        env: { ...ENV, DATABASE_URL: isolated.databaseUrl },
        now: () => new Date("2026-11-10T12:00:00Z"),
        io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
      });
      expect(executed, stderr.join("")).toBe(0);
      const tampered = { ...request, payloadDigest: "a".repeat(64) };
      writeFileSync(requestPath, JSON.stringify(tampered));
      writeFileSync(approvalPath, JSON.stringify(signedApproval(tampered)));
      const tamperedStderr: string[] = [];
      const rejected = await runEnterpriseAdmin({
        argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
          "--expect-policy-epoch", "3", "--approval", approvalPath,
          "--approved-payload", requestPath],
        env: { ...ENV, DATABASE_URL: isolated.databaseUrl },
        now: () => new Date("2026-11-10T12:00:00Z"),
        io: { stdout: () => {}, stderr: (text) => tamperedStderr.push(text) },
      });
      expect(rejected).toBe(2);
      expect(tamperedStderr.join("")).toBe("error: APPROVAL_MALFORMED\n");
    } finally {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedDatabaseUrl;
    }
    expect(handlerRuns).toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ operationId: OPERATION, resultCounts: { requests: 1 } });
  });

  it("requires a canonical manifest digest during formal execution", async () => {
    registerGuardedWriteHandler("quarantine", {
      flags: {
        manifest: { kind: "file", required: true },
        digest: { kind: "string", required: true, emitSafe: true },
      },
      emitDigest: "canonical-manifest",
    }, () => {}, GUARD);
    const manifest = join(directory, "formal-quarantine.json");
    writeFileSync(manifest, JSON.stringify([{
      local_user_id: "user-1",
      reason: "formal",
      expected_user_version: "a".repeat(64),
    }]));
    const stderr: string[] = [];
    const code = await runEnterpriseAdmin({
      argv: ["quarantine", "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", "--manifest", manifest,
        "--approval", join(directory, "missing-approval.json"),
        "--approved-payload", join(directory, "missing-payload.json")],
      env: ENV,
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
    });
    expect(code).toBe(2);
    expect(stderr.join("")).toBe("error: MISSING_ARGUMENT\n");
  });

  it("classifies NUL and malformed-Unicode approval and approved-payload paths as input errors", async () => {
    registerGuardedWriteHandler(VERB, { flags: {} }, () => {}, GUARD);
    const common = [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
      "--expect-policy-epoch", "3"];
    const approvalPath = join(directory, "valid-approval.json");
    writeFileSync(approvalPath, JSON.stringify(signedApproval({
      verb: VERB,
      targetFingerprint: `megaui:${INSTANCE}:test`,
      deploymentRole: "test",
      operationId: OPERATION,
      payloadDigest: "a".repeat(64),
      manifestDigest: null,
      expectedPolicyEpoch: 3,
    })));
    const malformed = Buffer.from([0x00, 0xd8]).toString("utf16le");
    for (const suffix of ["\0", malformed]) {
      const approvalStderr: string[] = [];
      const badApproval = await runEnterpriseAdmin({
        argv: [...common, "--approval", `${directory}/bad${suffix}approval.json`,
          "--approved-payload", join(directory, "unused-payload.json")],
        env: ENV,
        io: { stdout: () => {}, stderr: (text) => approvalStderr.push(text) },
      });
      expect(badApproval).toBe(2);
      expect(approvalStderr.join("")).toBe("error: INVALID_ARGUMENT\n");

      const payloadStderr: string[] = [];
      const badPayload = await runEnterpriseAdmin({
        argv: [...common, "--approval", approvalPath,
          "--approved-payload", `${directory}/bad${suffix}payload.json`],
        env: ENV,
        io: { stdout: () => {}, stderr: (text) => payloadStderr.push(text) },
      });
      expect(badPayload).toBe(2);
      expect(payloadStderr.join("")).toBe("error: INVALID_ARGUMENT\n");
    }
  });

  it("maps a no-follow snapshot resource signal to a retryable dependency failure", async () => {
    const input = join(directory, "resource-input.txt");
    const helper = join(directory, "resource-helper-after-ready");
    const beforeReady = join(directory, "resource-helper-before-ready");
    const blockedAfterReady = join(directory, "resource-helper-blocked-after-ready");
    writeFileSync(input, "input");
    writeFileSync(helper, ["#!/bin/sh", "printf 'ready\\n'", "read line", "exit 4", ""].join("\n"));
    writeFileSync(beforeReady, ["#!/bin/sh", "exit 4", ""].join("\n"));
    writeFileSync(blockedAfterReady, ["#!/bin/sh", "printf 'ready\\n'", "read line", "exec sleep 1", ""].join("\n"));
    chmodSync(helper, 0o755);
    chmodSync(beforeReady, 0o755);
    chmodSync(blockedAfterReady, 0o755);
    expect(await readApprovedFileBytes(input, undefined, helper)).toBe("DEPENDENCY_FAILED");
    expect(await readApprovedFileBytes(input, undefined, beforeReady)).toBe("DEPENDENCY_FAILED");
    const started = Date.now();
    expect(await readApprovedFileBytes(input, undefined, blockedAfterReady, 100)).toBe("DEPENDENCY_FAILED");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("maps no-follow temporary-directory setup and cleanup failures to dependency failures", async () => {
    const input = join(directory, "temporary-directory-input.txt");
    writeFileSync(input, "input");
    expect(await readApprovedFileBytes(
      input,
      undefined,
      "python3",
      10_000,
      join(directory, "missing-temp-root"),
    )).toBe("DEPENDENCY_FAILED");

    const cleanupRoot = mkdtempSync(join(directory, "cleanup-root-"));
    try {
      expect(await readApprovedFileBytes(
        input,
        () => chmodSync(cleanupRoot, 0o500),
        "python3",
        10_000,
        cleanupRoot,
      )).toBe("DEPENDENCY_FAILED");
    } finally {
      chmodSync(cleanupRoot, 0o700);
      rmSync(cleanupRoot, { recursive: true, force: true });
    }
  });

  it("maps unreadable approval and approved-payload files to retryable dependency failures", async () => {
    registerGuardedWriteHandler(VERB, { flags: {} }, () => {}, GUARD);
    const common = [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
      "--expect-policy-epoch", "3"];
    const blockedApproval = join(directory, "blocked-approval.json");
    writeFileSync(blockedApproval, "{}");
    chmodSync(blockedApproval, 0o000);
    try {
      const stderr: string[] = [];
      const code = await runEnterpriseAdmin({
        argv: [...common, "--approval", blockedApproval,
          "--approved-payload", join(directory, "unused-payload.json")],
        env: ENV,
        io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
      });
      expect(code).toBe(4);
      expect(stderr.join("")).toBe("error: DEPENDENCY_FAILED\n");
    } finally {
      chmodSync(blockedApproval, 0o600);
    }

    const approvalPath = join(directory, "readable-approval.json");
    writeFileSync(approvalPath, JSON.stringify(signedApproval({
      verb: VERB,
      targetFingerprint: `megaui:${INSTANCE}:test`,
      deploymentRole: "test",
      operationId: OPERATION,
      payloadDigest: "a".repeat(64),
      manifestDigest: null,
      expectedPolicyEpoch: 3,
    })));
    const blockedPayload = join(directory, "blocked-payload.json");
    writeFileSync(blockedPayload, "{}");
    chmodSync(blockedPayload, 0o000);
    try {
      const stderr: string[] = [];
      const code = await runEnterpriseAdmin({
        argv: [...common, "--approval", approvalPath, "--approved-payload", blockedPayload],
        env: ENV,
        io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
      });
      expect(code).toBe(4);
      expect(stderr.join("")).toBe("error: DEPENDENCY_FAILED\n");
    } finally {
      chmodSync(blockedPayload, 0o600);
    }
  });

  it("rejects a no-follow input replaced by a symlink before formal execution", async () => {
    let handlerRuns = 0;
    registerGuardedWriteHandler(VERB, {
      flags: { manifest: { kind: "file", required: true } },
    }, () => { handlerRuns += 1; }, GUARD);
    const manifest = join(directory, "swap-before-execution.json");
    const replacement = join(directory, "swap-replacement.json");
    writeFileSync(manifest, "approved");
    writeFileSync(replacement, "replacement");
    const requestPath = join(directory, "swap-request.json");
    const emitted = await runEnterpriseAdmin({
      argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", "--manifest", manifest,
        "--out", requestPath, "--emit-approval-request"],
      env: { ...ENV, DATABASE_URL: isolated.databaseUrl },
      io: { stdout: () => {}, stderr: () => {} },
    });
    expect(emitted).toBe(0);
    const approvalPath = join(directory, "swap-approval.json");
    writeFileSync(approvalPath, JSON.stringify(signedApproval(JSON.parse(readFileSync(requestPath, "utf8")))));
    unlinkSync(manifest);
    symlinkSync(replacement, manifest);
    const stderr: string[] = [];
    const executed = await runEnterpriseAdmin({
      argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", "--manifest", manifest,
        "--approval", approvalPath, "--approved-payload", requestPath],
      env: { ...ENV, DATABASE_URL: isolated.databaseUrl },
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
    });
    expect(executed).toBe(2);
    expect(stderr.join("")).toBe("error: INVALID_ARGUMENT\n");
    expect(handlerRuns).toBe(0);
  });

  it("maps a missing no-follow helper to exit 4 in emit and formal execution", async () => {
    registerGuardedWriteHandler(VERB, {
      flags: { manifest: { kind: "file", required: true } },
    }, () => {}, GUARD);
    const manifest = join(directory, "helper-required.json");
    writeFileSync(manifest, "approved");
    const requestPath = join(directory, "helper-request.json");
    const emitted = await runEnterpriseAdmin({
      argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", "--manifest", manifest,
        "--out", requestPath, "--emit-approval-request"],
      env: { ...ENV, DATABASE_URL: isolated.databaseUrl },
      io: { stdout: () => {}, stderr: () => {} },
    });
    expect(emitted).toBe(0);
    const approvalPath = join(directory, "helper-approval.json");
    writeFileSync(approvalPath, JSON.stringify(signedApproval(JSON.parse(readFileSync(requestPath, "utf8")))));
    const noPython = join(directory, "no-python");
    mkdirSync(noPython);
    const savedPath = process.env.PATH;
    process.env.PATH = noPython;
    try {
      const emitStderr: string[] = [];
      const emitCode = await runEnterpriseAdmin({
        argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
          "--expect-policy-epoch", "3", "--manifest", manifest,
          "--out", join(directory, "helper-missing-request.json"), "--emit-approval-request"],
        env: { ...ENV, DATABASE_URL: isolated.databaseUrl },
        io: { stdout: () => {}, stderr: (text) => emitStderr.push(text) },
      });
      expect(emitCode).toBe(4);
      expect(emitStderr.join("")).toBe("error: DEPENDENCY_FAILED\n");
      const executionStderr: string[] = [];
      const executionCode = await runEnterpriseAdmin({
        argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
          "--expect-policy-epoch", "3", "--manifest", manifest,
          "--approval", approvalPath, "--approved-payload", requestPath],
        env: { ...ENV, DATABASE_URL: isolated.databaseUrl },
        io: { stdout: () => {}, stderr: (text) => executionStderr.push(text) },
      });
      expect(executionCode).toBe(4);
      expect(executionStderr.join("")).toBe("error: DEPENDENCY_FAILED\n");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("fails a scope mismatch without a request file", async () => {
    registerGuardedWriteHandler(VERB, { flags: {} }, () => { throw new Error("no handler"); }, GUARD);
    const out = join(directory, "scope.json");
    await pool.query(
      `update "enterprise_policy" set environment = 'other' where scope = $1`,
      [INSTANCE],
    );
    const code = await runEnterpriseAdmin({
      argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", "--out", out, "--emit-approval-request"],
      env: { ...ENV, DATABASE_URL: isolated.databaseUrl },
      io: { stdout: () => {}, stderr: () => {} },
    });
    expect(code, "scope guard must reject mismatched environment").toBe(3);
    expect(await runEnterpriseAdmin({
      argv: [VERB, "--target", INSTANCE, "--operation-id", OPERATION,
        "--expect-policy-epoch", "3", "--out", out, "--emit-approval-request"],
      env: { ...ENV, DATABASE_URL: undefined },
      io: { stdout: () => {}, stderr: () => {} },
    })).toBe(4);
  });
});
