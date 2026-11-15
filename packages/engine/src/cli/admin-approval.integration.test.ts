// FS-80: real PostgreSQL and the actual admin CLI assembly.
//
// The suite owns an isolated Postgres 16. It does not read an environment
// sample. A separate signer process holds the authority private key.
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
  dispatchPinnedVerb,
  pinRegisteredVerb,
  registerGuardedWriteHandler,
  type ApprovalBundle,
  type ApprovalOperation,
  type VerbSchema,
} from "./admin-approval";
import { canonicalizeJson, payloadDigest } from "./admin-payload";
import { readApprovedFileBytes, runEnterpriseAdmin } from "./enterprise-admin";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error(
    "[@megaui/engine] admin-approval.integration.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

const INSTANCE_ID = "instance-1";
const FINGERPRINT = "megaui:instance-1:test";
const OPERATION_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-10T02:30:00.000Z");
const CLI = fileURLToPath(new URL("./enterprise-admin.ts", import.meta.url));
const GUARD = { approval: true as const, scope: true as const };

const ACCEPT_SCHEMA: VerbSchema = {
  flags: {
    digest: { kind: "string", required: true },
    manifest: { kind: "file", required: true },
    note: { kind: "string", default: "none" },
  },
};

const SIGNER = fileURLToPath(new URL("./admin-approval.fixture-signer.ts", import.meta.url));

let isolated: IsolatedPostgres;
let pool: Pool;
let directory: string;
let keyPath: string;
let publicPath: string;

function publicPem(): string {
  return readFileSync(publicPath, "utf8");
}

function canonicalPayload(): string {
  return [
    '{"args":{"expect-policy-epoch":3,"operation-id":"',
    OPERATION_ID,
    '","target":"',
    INSTANCE_ID,
    '"},"deploymentRole":"test","expectedPolicyEpoch":3,"inputFiles":{},',
    '"operationId":"',
    OPERATION_ID,
    '","schemaVersion":1,"targetFingerprint":"',
    FINGERPRINT,
    '","verb":"maintenance"}',
  ].join("");
}

function operation(overrides: Partial<ApprovalOperation> = {}): ApprovalOperation {
  return {
    verb: "maintenance",
    targetFingerprint: FINGERPRINT,
    deploymentRole: "test",
    operationId: OPERATION_ID,
    payloadDigest: createHash("sha256").update(canonicalPayload().replaceAll(
      OPERATION_ID,
      overrides.operationId ?? OPERATION_ID,
    ), "utf8").digest("hex"),
    manifestDigest: null,
    expectedPolicyEpoch: 3,
    ...overrides,
  };
}

function bundle(operations: ApprovalOperation[], expiresAt = 1_899_000_000): ApprovalBundle {
  const request = join(directory, `request-${Math.random().toString(16).slice(2)}.json`);
  const output = join(directory, `signed-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(
    request,
    JSON.stringify({
      schemaVersion: 1,
      approvalId: "approval-1",
      approvedBy: "fixture-approver",
      issuedAt: 1_700_000_000,
      expiresAt,
      operations,
      signature: "",
    }),
  );
  const signed = spawnSync(
    process.execPath,
    ["--import", "tsx", SIGNER, keyPath, publicPath, request, output],
    { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) },
  );
  if (signed.status !== 0) {
    throw new Error(signed.stderr.toString() || "the fixture signer failed");
  }
  return JSON.parse(readFileSync(output, "utf8")) as ApprovalBundle;
}

function writeApproval(value: unknown): string {
  const path = join(directory, `approval-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

async function persisted(): Promise<{ operations: unknown[]; policy: unknown[] }> {
  const operations = await pool.query(`select * from "enterprise_admin_operations" order by id`);
  const policy = await pool.query(`select * from "enterprise_policy" order by id`);
  return { operations: operations.rows, policy: policy.rows };
}

function cliEnv(publicKeyPem = publicPem()): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "test",
    DATABASE_URL: isolated.databaseUrl,
    ENTERPRISE_APPROVAL_PUBLIC_KEY: publicKeyPem,
    ENTERPRISE_DB_INSTANCE_ID: INSTANCE_ID,
    ENTERPRISE_PROCESS_ROLE: "test",
    ENTERPRISE_DEPLOYMENT_ROLE: "test",
    ENTERPRISE_OWNER_FINGERPRINT: "megaui",
  };
}

function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = cliEnv(),
): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr, stdout }));
  });
}

function common(
  approval: string,
  extra: readonly string[] = [],
  payload?: Parameters<typeof payloadDigest>[0],
  operationId = OPERATION_ID,
): string[] {
  const body = payload ?? {
    verb: "maintenance",
    targetFingerprint: FINGERPRINT,
    deploymentRole: "test",
    operationId,
    expectedPolicyEpoch: 3,
    args: {
      target: INSTANCE_ID,
      "operation-id": operationId,
      "expect-policy-epoch": 3,
    },
    inputFiles: {},
  };
  const payloadPath = join(directory, `payload-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(payloadPath, JSON.stringify({ schemaVersion: 1, ...body }));
  return [
    "--target",
    INSTANCE_ID,
    "--approval",
    approval,
    "--approved-payload",
    payloadPath,
    "--operation-id",
    operationId,
    "--expect-policy-epoch",
    "3",
    ...extra,
  ];
}

describe("enterprise admin approval framework (FS-80)", () => {
  const previousEnv = { ...process.env };
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    await pool.query(
      `insert into "enterprise_policy"
         (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
       values ('policy-1', $1, 'megaui', 'test', 'test', 3, 'enterprise')`,
      [INSTANCE_ID],
    );
    directory = realpathSync(mkdtempSync(join(tmpdir(), "megaui-fs80-")));
    keyPath = join(directory, "authority-private.pem");
    publicPath = join(directory, "authority-public.pem");
    bundle([operation()]);
    Object.assign(process.env, cliEnv());
  }, 120_000);

  beforeEach(() => {
    clearRegisteredWriteHandlers();
  });

  afterAll(async () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
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
    if (failures.length > 0) throw new AggregateError(failures, "FS-80 fixture cleanup failed");
  });

  it("locks native RFC 8785 vectors and rejects unpaired surrogates", () => {
    const literal = canonicalPayload();
    expect(canonicalizeJson({ b: 1, a: { d: true, c: "x" } })).toBe('{"a":{"c":"x","d":true},"b":1}');
    expect(canonicalizeJson("😀")).toBe('"😀"');
    const lone = Buffer.from([0x00, 0xd8]).toString("utf16le");
    const hole = [1];
    hole.length = 2;
    Object.defineProperty(hole, "extra", { value: true, enumerable: true });
    expect(() => canonicalizeJson(hole)).toThrow(/sparse array/);
    expect(() => canonicalizeJson(Array(2))).toThrow(/sparse array/);
    expect(() => canonicalizeJson(new Date(0))).toThrow(/unsupported object/);
    expect(() => canonicalizeJson(lone)).toThrow(/unpaired surrogate/);
    expect(() => canonicalizeJson({ [lone]: 1 })).toThrow(/unpaired surrogate/);
    expect(
      payloadDigest({
        verb: "maintenance",
        targetFingerprint: FINGERPRINT,
        deploymentRole: "test",
        operationId: OPERATION_ID,
        expectedPolicyEpoch: 3,
        args: { target: INSTANCE_ID, "operation-id": OPERATION_ID, "expect-policy-epoch": 3 },
        inputFiles: {},
      }),
    ).toBe(createHash("sha256").update(literal, "utf8").digest("hex"));
  });

  it("does not dispatch a handler inserted outside the guarded registry", async () => {
    const sneaky = new Map<string, () => void>();
    let called = false;
    sneaky.set("maintenance", () => {
      called = true;
    });
    const before = await persisted();
    const result = await runEnterpriseAdmin({
      argv: ["maintenance", ...common(writeApproval(bundle([operation()])))],
      env: cliEnv(),
      now: () => NOW,
      io: { stdout: () => {}, stderr: () => {} },
      ...({ registry: sneaky } as Record<string, unknown>),
    });
    expect(result).toBe(2);
    expect(called).toBe(false);
    expect(await persisted()).toEqual(before);
  });

  it("returns UNKNOWN_VERB before reading arguments for an unregistered verb", async () => {
    const before = await persisted();
    const approval = writeApproval(bundle([operation()]));
    const bare = await runCli(["unregistered"]);
    const missing = await runCli(["unregistered", "--approval", approval]);
    const unknown = await runCli([
      "unregistered",
      ...common(approval),
      "--manifest",
      join(directory, "unused.json"),
    ]);
    expect(bare).toMatchObject({ code: 2, stderr: "error: UNKNOWN_VERB\n" });
    expect(missing).toMatchObject({ code: 2, stderr: "error: UNKNOWN_VERB\n" });
    expect(unknown).toMatchObject({ code: 2, stderr: "error: UNKNOWN_VERB\n" });
    expect(await persisted()).toEqual(before);
  });

  it("returns exit 2 for a missing argument, an unknown flag, and a repeated flag", async () => {
    registerGuardedWriteHandler("maintenance", { flags: {} }, () => {}, GUARD);
    const before = await persisted();
    const approval = writeApproval(bundle([operation()]));
    const stderr: string[] = [];
    const io = { stdout: () => {}, stderr: (text: string) => stderr.push(text) };
    stderr.length = 0;
    const missing = await runEnterpriseAdmin({
      argv: ["maintenance", "--approval", approval],
      env: cliEnv(),
      now: () => NOW,
      io,
    });
    expect(missing).toBe(2);
    expect(stderr.join("")).toBe("error: MISSING_ARGUMENT\n");
    stderr.length = 0;
    const unknown = await runEnterpriseAdmin({
      argv: ["maintenance", ...common(approval), "--manifest", join(directory, "unused.json")],
      env: cliEnv(),
      now: () => NOW,
      io,
    });
    expect(unknown).toBe(2);
    expect(stderr.join("")).toBe("error: UNKNOWN_FLAG\n");
    stderr.length = 0;
    const duplicate = await runEnterpriseAdmin({
      argv: ["maintenance", "--target", INSTANCE_ID, "--target", INSTANCE_ID, ...common(approval).slice(2)],
      env: cliEnv(),
      now: () => NOW,
      io,
    });
    expect(duplicate).toBe(2);
    expect(stderr.join("")).toBe("error: DUPLICATE_FLAG\n");
    expect(await persisted()).toEqual(before);
  });

  it("rejects approval failures with exit 3 and leaves both tables unchanged", async () => {
    registerGuardedWriteHandler("maintenance", { flags: {} }, () => {}, GUARD);
    registerGuardedWriteHandler("provision", { flags: {} }, () => {}, GUARD);
    const before = await persisted();
    const valid = bundle([operation()]);
    const cases: Array<[string, readonly string[]]> = [
      ["APPROVAL_SIGNATURE_INVALID", ["maintenance", ...common(writeApproval({ ...valid, approvedBy: "other" }))]],
      ["APPROVAL_SIGNATURE_INVALID", ["maintenance", ...common(writeApproval({ ...valid, signature: "abcd" }))]],
      ["APPROVAL_VERB_MISMATCH", ["provision", ...common(writeApproval(bundle([operation()])))]],
      [
        "APPROVAL_TARGET_MISMATCH",
        ["maintenance", ...common(writeApproval(bundle([operation({ targetFingerprint: "megaui:other:test" })])))],
      ],
      [
        "APPROVAL_OPERATION_MISMATCH",
        [
          "maintenance",
          ...common(
            writeApproval(bundle([operation({ operationId: "00000000-0000-4000-8000-000000000002" })])),
          ),
        ],
      ],
      ["APPROVAL_EXPIRED", ["maintenance", ...common(writeApproval(bundle([operation()], 1_700_000_001)))]],
      [
        "APPROVAL_DIGEST_MISMATCH",
        ["maintenance", ...common(writeApproval(bundle([operation({ payloadDigest: "c".repeat(64) })])))],
      ],
    ];
    for (const [key, args] of cases) {
      const stderr: string[] = [];
      const code = await runEnterpriseAdmin({
        argv: args,
        env: cliEnv(),
        now: () => NOW,
        io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
      });
      expect(code).toBe(3);
      expect(stderr.join("")).toBe(`error: ${key}\n`);
      expect(stderr.join("")).not.toContain(publicPem().slice(0, 24));
      expect(await persisted()).toEqual(before);
    }
  }, 30_000);

  it("rejects an inherited flag name, an unsafe flag name, and a private key", async () => {
    const unsafe = Object.create(null) as VerbSchema["flags"];
    Object.defineProperty(unsafe, "__proto__", {
      value: { kind: "string", default: "hidden" },
      enumerable: true,
    });
    expect(() => registerGuardedWriteHandler("unsafe", { flags: unsafe }, () => {}, GUARD)).toThrow(/flag/);
    expect(() => registerGuardedWriteHandler("emit-owner", {
      flags: { "emit-approval-request": { kind: "string", default: "unsafe" } },
    }, () => {}, GUARD)).toThrow(/flag/);
    expect(() => registerGuardedWriteHandler("unguarded", { flags: {} }, () => {})).toThrow(/complete approval guard/);
    expect(() => registerGuardedWriteHandler("partial", { flags: {} }, () => {}, { approval: true })).toThrow(
      /complete approval guard/,
    );
    expect(pinRegisteredVerb("unguarded")).toBeUndefined();
    registerGuardedWriteHandler("maintenance", { flags: {} }, () => {}, GUARD);
    const inherited = await runEnterpriseAdmin({
      argv: ["maintenance", ...common(writeApproval(bundle([operation()]))), "--toString", "value"],
      env: cliEnv(),
      now: () => NOW,
      io: { stdout: () => {}, stderr: () => {} },
    });
    expect(inherited).toBe(2);
    const disposable = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    }).toString();
    const before = await persisted();
    const stderr: string[] = [];
    const code = await runEnterpriseAdmin({
      argv: ["maintenance", ...common(writeApproval(bundle([operation()])))],
      env: cliEnv(disposable),
      now: () => NOW,
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
    });
    expect(code).toBe(2);
    expect(stderr.join("")).toBe("error: INVALID_CONFIG\n");
    expect(stderr.join("")).not.toContain("PRIVATE KEY");
    expect(await persisted()).toEqual(before);
  });

  it("rejects a non-Ed25519 approval key before verification", async () => {
    registerGuardedWriteHandler("maintenance", { flags: {} }, () => {}, GUARD);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
    const before = await persisted();
    const stderr: string[] = [];
    const code = await runEnterpriseAdmin({
      argv: ["maintenance", ...common(writeApproval(bundle([operation()])))],
      env: cliEnv(pem),
      now: () => NOW,
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
    });
    expect(code).toBe(2);
    expect(stderr.join("")).toBe("error: INVALID_CONFIG\n");
    expect(stderr.join("")).not.toContain("BEGIN RSA");
    expect(await persisted()).toEqual(before);
  });

  it("accepts a valid approval without writing or running an unregistered verb", async () => {
    const before = await persisted();
    const result = await runCli(["unregistered", ...common(writeApproval(bundle([operation()])))]);
    expect(result).toMatchObject({ code: 2, stderr: "error: UNKNOWN_VERB\n", stdout: "" });
    expect(await persisted()).toEqual(before);
  });

  it(
    "normalizes a verb schema once and keeps the approved file bytes immutable",
    async () => {
    const original = Buffer.from('{"members":["original"]}');
    const created = join(directory, "snapshot.json");
    writeFileSync(created, original);
    const file = realpathSync(created);
    const digest = createHash("sha256").update(original).digest("hex");
    let seenNote: string | number | undefined;
    let first: Uint8Array | undefined;
    let second: Uint8Array | undefined;
    let handlerRan = false;
    registerGuardedWriteHandler("accept-members", ACCEPT_SCHEMA, (context) => {
      handlerRan = true;
      expect(() => clearRegisteredWriteHandlers()).toThrow(/frozen/);
      seenNote = context.args.note;
      first = context.files.bytes("manifest");
      first?.set([0]);
      second = context.files.bytes("manifest");
    }, GUARD);
    const pin = pinRegisteredVerb("accept-members");
    if (!pin) throw new Error("accept-members was not pinned");
    const forged = bundle([operation({ verb: "accept-members" })]);
    forged.approvedBy = "forged-approver";
    const mutableArgs: Record<string, string | number> = {
      note: "none",
      target: INSTANCE_ID,
      "operation-id": OPERATION_ID,
      "expect-policy-epoch": 3,
    };
    let reads = 0;
    expect(
      await dispatchPinnedVerb({
        pin,
        env: cliEnv(),
        bundle: forged,
        operationId: OPERATION_ID,
        expectedPolicyEpoch: 3,
        manifestDigest: null,
        args: mutableArgs,
        files: {
          names: () => ["manifest"],
          bytes: () => {
            reads += 1;
            mutableArgs.note = "changed-during-read";
            return reads === 1 ? original : Buffer.from("different");
          },
        },
        now: () => NOW,
      }),
    ).toBe("APPROVAL_SIGNATURE_INVALID");
    expect(
      await dispatchPinnedVerb({
        pin,
        env: cliEnv(),
        bundle: bundle([
          operation({ verb: "accept-members", targetFingerprint: "megaui:other:test" }),
        ]),
        operationId: OPERATION_ID,
        expectedPolicyEpoch: 3,
        manifestDigest: null,
        args: mutableArgs,
        files: { names: () => [], bytes: () => undefined },
        now: () => NOW,
      }),
    ).toBe("APPROVAL_TARGET_MISMATCH");
    expect(handlerRan).toBe(false);
    const liveArgs: Record<string, string | number> = {
      digest,
      "expect-policy-epoch": 3,
      manifest: file,
      note: "none",
      "operation-id": OPERATION_ID,
      target: INSTANCE_ID,
    };
    let fileReads = 0;
    const admitted = await dispatchPinnedVerb({
      pin,
      env: cliEnv(),
      bundle: bundle([
        operation({
          verb: "accept-members",
          manifestDigest: digest,
          payloadDigest: payloadDigest({
            verb: "accept-members",
            targetFingerprint: FINGERPRINT,
            deploymentRole: "test",
            operationId: OPERATION_ID,
            expectedPolicyEpoch: 3,
            args: { ...liveArgs },
            inputFiles: { manifest: digest },
          }),
        }),
      ]),
      operationId: OPERATION_ID,
      expectedPolicyEpoch: 3,
      manifestDigest: digest,
      args: liveArgs,
      files: {
        names: () => ["manifest"],
        bytes: () => {
          fileReads += 1;
          liveArgs.note = "mutated-during-read";
          return fileReads === 1 ? original : Buffer.from("different");
        },
      },
      now: () => NOW,
    });
    expect(admitted).toMatchObject({ replayed: false, policyEpoch: 3 });
    expect(seenNote).toBe("none");
    expect(Buffer.from(second ?? new Uint8Array())).toEqual(original);
    pin.release();
    const memberPayload = {
      verb: "accept-members",
      targetFingerprint: FINGERPRINT,
      deploymentRole: "test",
      operationId: OPERATION_ID,
      expectedPolicyEpoch: 3,
      args: {
        digest,
        "expect-policy-epoch": 3,
        manifest: file,
        note: "none",
        "operation-id": OPERATION_ID,
        target: INSTANCE_ID,
      },
      inputFiles: { manifest: digest },
    };
    const approved = operation({
      verb: "accept-members",
      manifestDigest: digest,
      payloadDigest: payloadDigest(memberPayload),
    });
    const before = await persisted();
    const stderr: string[] = [];
    const code = await runEnterpriseAdmin({
      argv: [
        "accept-members",
        ...common(writeApproval(bundle([approved])), ["--manifest", file, "--digest", digest], memberPayload),
      ],
      env: cliEnv(),
      now: () => NOW,
      io: {
        stdout: () => {},
        stderr: (text) => stderr.push(text),
      },
      observeApprovedBytes: () => {
        writeFileSync(file, Buffer.from('{"members":["during"]}'));
      },
    });
    expect(code, stderr.join("")).toBe(0);
    expect(seenNote).toBe("none");
    expect(Buffer.from(second ?? new Uint8Array())).toEqual(original);
    expect(await persisted()).toEqual(before);

    writeFileSync(file, Buffer.from('{"members":["replaced"]}'));
    const replaced = await runEnterpriseAdmin({
      argv: [
        "accept-members",
        ...common(writeApproval(bundle([approved])), ["--manifest", file, "--digest", digest], memberPayload),
      ],
      env: cliEnv(),
      now: () => NOW,
      io: { stdout: () => {}, stderr: () => {} },
    });
    expect(replaced).toBe(3);
    expect(await persisted()).toEqual(before);

    const mismatched = await runEnterpriseAdmin({
      argv: [
        "accept-members",
        ...common(writeApproval(bundle([operation({ verb: "accept-members", manifestDigest: "a".repeat(64) })]))),
        "--manifest",
        file,
        "--digest",
        "b".repeat(64),
      ],
      env: cliEnv(),
      now: () => NOW,
      io: { stdout: () => {}, stderr: () => {} },
    });
    expect(mismatched).toBe(3);
    expect(await persisted()).toEqual(before);

    const fifo = join(directory, "substituted.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const started = Date.now();
    const substituted = await runEnterpriseAdmin({
      argv: [
        "accept-members",
        ...common(
          writeApproval(bundle([approved])),
          ["--manifest", fifo, "--digest", digest],
          memberPayload,
        ),
      ],
      env: cliEnv(),
      now: () => NOW,
      io: { stdout: () => {}, stderr: () => {} },
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(substituted).toBe(3);
  },
    30_000,
  );

  it("rechecks the process clock before dispatch and never uses the supplied clock", async () => {
    let called = false;
    const expiry = 1_890_000_000;
    registerGuardedWriteHandler("maintenance", { flags: {} }, () => {
      called = true;
    }, GUARD);
    const before = await persisted();
    const stderr: string[] = [];
    const approvedOperation = operation({ operationId: "00000000-0000-4000-8000-000000000070" });
    const approval = writeApproval(bundle([approvedOperation], expiry));
    const clockArgs = common(approval, [], undefined, approvedOperation.operationId);
    const code = await runEnterpriseAdmin({
      argv: ["maintenance", ...clockArgs],
      env: cliEnv(),
      now: () => new Date(0),
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
    });
    expect(code, stderr.join("")).toBe(0);
    expect(called).toBe(true);
    const after = await persisted();
    expect(after.policy).toEqual(before.policy);
    expect(after.operations).toHaveLength(before.operations.length + 1);
    expect((after.operations.at(-1) as { operation_id?: string } | undefined)?.operation_id).toBe(approvedOperation.operationId);
    expect(stderr.join("")).toBe("");
  });

  it("rejects an actually expired signed approval", async () => {
    registerGuardedWriteHandler("maintenance", { flags: {} }, () => {}, GUARD);
    const before = await persisted();
    const code = await runEnterpriseAdmin({
      argv: ["maintenance", ...common(writeApproval(bundle([operation()], Math.floor(Date.now() / 1000) - 1)))],
      env: cliEnv(),
      io: { stdout: () => {}, stderr: () => {} },
    });
    expect(code).toBe(3);
    expect(await persisted()).toEqual(before);
  });

  it(
    "rejects a swapped file between validation and open, and bad payload input",
    async () => {
    const approved = join(directory, "stable-input.txt");
    const other = join(directory, "other-input.txt");
    writeFileSync(approved, "approved");
    writeFileSync(other, "secret");
    let replacedCallback = false;
    const replaced = await readApprovedFileBytes(approved, () => {
      replacedCallback = true;
      unlinkSync(approved);
      writeFileSync(approved, "secret");
    });
    expect(replacedCallback).toBe(true);
    expect(replaced).toBeInstanceOf(Buffer);
    expect((replaced as Buffer).toString()).toBe("approved");
    const link = join(directory, "link-input.txt");
    symlinkSync(other, link);
    expect(await readApprovedFileBytes(link)).toBe("INVALID_ARGUMENT");
    const fifo = join(directory, "blocked.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const started = Date.now();
    expect(await readApprovedFileBytes(fifo)).toBe("INVALID_ARGUMENT");
    expect(Date.now() - started).toBeLessThan(2000);

    const parent = join(directory, "approved-parent");
    const replacement = join(directory, "replacement-parent");
    mkdirSync(parent);
    mkdirSync(replacement);
    writeFileSync(join(parent, "input"), "approved");
    writeFileSync(join(replacement, "input"), "secret");
    renameSync(parent, join(directory, "moved-parent"));
    symlinkSync(replacement, parent);
    expect(await readApprovedFileBytes(join(parent, "input"))).toBe("INVALID_ARGUMENT");
    expect(await readApprovedFileBytes(approved, undefined, "megaui-missing-file-helper")).toBe(
      "DEPENDENCY_FAILED",
    );
    const largeSize = 16 * 1024 * 1024 + 1;
    const large = Buffer.alloc(largeSize, 0x61);
    const largePath = join(directory, "large-input.bin");
    writeFileSync(largePath, large);
    const largeRead = await readApprovedFileBytes(largePath);
    expect(largeRead).toBeInstanceOf(Buffer);
    expect((largeRead as Buffer).length).toBe(largeSize);
    expect(createHash("sha256").update(largeRead as Buffer).digest("hex")).toBe(
      createHash("sha256").update(large).digest("hex"),
    );
    const noPython = join(directory, "no-python");
    mkdirSync(noPython);
    const savedPath = process.env.PATH;
    process.env.PATH = noPython;
    try {
      expect(await readApprovedFileBytes(approved)).toBe("DEPENDENCY_FAILED");
    } finally {
      process.env.PATH = savedPath;
    }
    const chunked = join(directory, "chunked-helper");
    writeFileSync(
      chunked,
      [
        "#!/bin/sh",
        "printf rea",
        "sleep 0.05",
        "printf 'dy\\n'",
        "read line",
        "printf approved > \"$4\"",
        "",
      ].join("\n"),
    );
    chmodSync(chunked, 0o755);
    expect((await readApprovedFileBytes(approved, undefined, chunked)).toString()).toBe("approved");
    const exiting = join(directory, "exit-after-ready");
    writeFileSync(exiting, ["#!/bin/sh", "printf 'ready\\n'", "exit 0", ""].join("\n"));
    chmodSync(exiting, 0o755);
    expect(await readApprovedFileBytes(approved, undefined, exiting)).toBe("INVALID_ARGUMENT");
    const temporaryRoot = join(directory, "owned-cleanup-probe");
    mkdirSync(temporaryRoot);
    const leftovers = () => readdirSync(temporaryRoot);
    const beforeTemps = leftovers();
    await expect(
      readApprovedFileBytes(approved, () => {
        throw new Error("swap failed");
      }, undefined, undefined, temporaryRoot),
    ).rejects.toThrow("swap failed");
    expect(leftovers()).toEqual(beforeTemps);
    const slowRead = join(directory, "slow-read-helper");
    writeFileSync(
      slowRead,
      ["#!/bin/sh", "printf 'ready\\n'", "read line", "exec sleep 0.4", ""].join("\n"),
    );
    chmodSync(slowRead, 0o755);
    expect(await readApprovedFileBytes(approved, undefined, slowRead, 150)).toBe("DEPENDENCY_FAILED");

    registerGuardedWriteHandler("maintenance", { flags: {} }, () => {}, GUARD);
    const stderr: string[] = [];
    const io = { stdout: () => {}, stderr: (text: string) => stderr.push(text) };
    const missingArgs = common(writeApproval(bundle([operation()])));
    missingArgs[missingArgs.indexOf("--approved-payload") + 1] = join(directory, "missing-payload.json");
    const missing = await runEnterpriseAdmin({
      argv: ["maintenance", ...missingArgs],
      env: cliEnv(),
      now: () => NOW,
      io,
    });
    expect(missing).toBe(2);
    expect(stderr.join("")).toBe("error: INVALID_ARGUMENT\n");

    const lone = Buffer.from([0x00, 0xd8]).toString("utf16le");
    const payloadPath = join(directory, "surrogate-payload.json");
    writeFileSync(
      payloadPath,
      JSON.stringify({
        schemaVersion: 1,
        verb: "maintenance",
        targetFingerprint: FINGERPRINT,
        deploymentRole: "test",
        operationId: OPERATION_ID,
        expectedPolicyEpoch: 3,
        args: { note: lone },
        inputFiles: {},
      }),
    );
    stderr.length = 0;
    const malformedArgs = common(writeApproval(bundle([operation()])));
    malformedArgs[malformedArgs.indexOf("--approved-payload") + 1] = payloadPath;
    const malformed = await runEnterpriseAdmin({
      argv: ["maintenance", ...malformedArgs],
      env: cliEnv(),
      now: () => NOW,
      io,
    });
    expect(malformed).toBe(2);
    expect(stderr.join("")).toBe("error: APPROVAL_MALFORMED\n");
  },
    30_000,
  );
});
